import {
  type McpHttpServerConfig,
  McpServerOAuthError,
  type McpServerOAuthStartInput,
  type McpServerOAuthStartResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

import * as ServerSettings from "../serverSettings.ts";

/** Providers reach OAuth servers here, so tokens never leave the server. */
export const MCP_SERVER_PROXY_PATH = "/mcp-servers";

/**
 * E4 Code's client ID metadata document, committed at `oauth/mcp-client.json`.
 * It lists loopback redirect URIs only, which authorization servers match on any port (RFC 8252).
 * Served from jsDelivr because authorization servers require `application/json` and raw GitHub serves `text/plain`.
 */
export const MCP_CLIENT_METADATA_URL =
  "https://cdn.jsdelivr.net/gh/stonith404/e4code@main/oauth/mcp-client.json";

const REQUEST_TIMEOUT = Duration.seconds(15);
const SIGN_IN_TTL_MS = Duration.toMillis(Duration.minutes(10));
// Refresh ahead of expiry so a token does not lapse during a long tool call.
const REFRESH_MARGIN_MS = Duration.toMillis(Duration.minutes(2));

/** One server as a provider CLI is configured with it. */
export type ProviderMcpServer =
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

const TokenEndpointAuthMethod = Schema.Literals([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);
type TokenEndpointAuthMethod = typeof TokenEndpointAuthMethod.Type;

const McpOAuthSession = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  /** Null when the token does not expire. */
  expiresAt: Schema.NullOr(Schema.Number),
  tokenEndpoint: Schema.String,
  authMethod: TokenEndpointAuthMethod,
  resource: Schema.String,
  /** The server URL and configured client the session was issued for; either changing signs out. */
  url: Schema.String,
  configuredClientId: Schema.String,
  /** The client the tokens belong to, which E4 Code picks itself when none is configured. */
  clientId: Schema.String,
  clientSecret: Schema.String,
});
type McpOAuthSession = typeof McpOAuthSession.Type;
type McpOAuthClient = Omit<McpOAuthSession, "accessToken" | "refreshToken" | "expiresAt">;

const McpOAuthSessionJson = Schema.fromJsonString(McpOAuthSession);
const decodeSession = Schema.decodeUnknownOption(McpOAuthSessionJson);
const encodeSession = Schema.encodeSync(McpOAuthSessionJson);

const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.optional(Schema.String),
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});

const AuthorizationServerMetadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
  registration_endpoint: Schema.optional(Schema.String),
});

// RFC 7591 refusals carry an `error` instead of a `client_id`.
const RegistrationResponse = Schema.Struct({
  client_id: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

// Token endpoints answer refusals with a 4xx and an `error`.
const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

/** RFC 9728 locations, path-specific first. */
export function protectedResourceMetadataUrls(serverUrl: string): ReadonlyArray<string> {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/$/, "");
  return [
    ...(path === "" ? [] : [`${url.origin}/.well-known/oauth-protected-resource${path}`]),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
}

/** RFC 8414 and OpenID Connect discovery locations, in the order the MCP spec tries them. */
export function authorizationServerMetadataUrls(issuer: string): ReadonlyArray<string> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  return path === ""
    ? [
        `${url.origin}/.well-known/oauth-authorization-server`,
        `${url.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ];
}

/** The parameters of a `Bearer` challenge, such as `resource_metadata` and `scope`. */
export function parseBearerChallenge(header: string | undefined): Readonly<Record<string, string>> {
  if (header === undefined || !/^bearer\b/i.test(header.trim())) return {};
  return Object.fromEntries(
    Array.from(header.matchAll(/([a-zA-Z_]+)="([^"]*)"/g), (match) => [match[1]!, match[2]!]),
  );
}

/** Basic auth when the server allows it or names no method, as RFC 8414 defaults to it. */
function tokenEndpointAuthMethod(
  clientSecret: string,
  supported: ReadonlyArray<string> | undefined,
): TokenEndpointAuthMethod {
  if (clientSecret === "") return "none";
  return supported === undefined || supported.includes("client_secret_basic")
    ? "client_secret_basic"
    : "client_secret_post";
}

interface PendingSignIn {
  readonly name: string;
  readonly client: McpOAuthClient;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

const sessionMatches = (
  server: McpHttpServerConfig,
  session: Pick<McpOAuthSession, "url" | "configuredClientId">,
) => session.url === server.url && session.configuredClientId === server.oauthClientId;

export class McpServers extends Context.Service<
  McpServers,
  {
    /**
     * The servers a provider instance's session gets. OAuth servers go through the proxy with
     * the session's T3 credential, so a session without one, or a server not signed in, gets none.
     */
    readonly forProviderInstance: (
      instanceId: ProviderInstanceId,
      mcpSession: McpProviderSessionConfig | undefined,
    ) => Effect.Effect<ReadonlyArray<ProviderMcpServer>>;
    /** The enabled, signed-in OAuth server a provider instance may reach through the proxy. */
    readonly proxyTarget: (
      name: string,
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<McpHttpServerConfig>>;
    readonly startSignIn: (
      input: McpServerOAuthStartInput,
    ) => Effect.Effect<McpServerOAuthStartResult, McpServerOAuthError>;
    /** Exchanges the code the authorization server sent back and saves the session. */
    readonly completeSignIn: (input: {
      readonly state: string;
      readonly code: string | null;
      readonly error: string | null;
      readonly errorDescription: string | null;
    }) => Effect.Effect<{ readonly name: string }, McpServerOAuthError>;
    /** The access token for `name`, refreshed when due or when `rejected` is the one just refused. */
    readonly accessToken: (
      name: string,
      rejected?: string,
    ) => Effect.Effect<Option.Option<string>, McpServerOAuthError>;
  }
>()("t3/mcpServers/McpServers") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const refreshLock = yield* Semaphore.make(1);
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());

  const servers = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.mcpServers),
    Effect.orElseSucceed(() => []),
  );
  const httpServer = (name: string) =>
    servers.pipe(
      Effect.map((list) =>
        Option.fromNullishOr(
          list.flatMap((server) =>
            server.transport === "http" && server.name === name ? [server] : [],
          )[0],
        ),
      ),
    );

  const oauthError = (name: string, detail: string) => new McpServerOAuthError({ name, detail });

  const getJson = <S extends Schema.Top>(url: string, schema: S) =>
    httpClient
      .get(url, { headers: { accept: "application/json" } })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.option,
      );

  const firstJson = Effect.fnUntraced(function* <S extends Schema.Top>(
    urls: ReadonlyArray<string>,
    schema: S,
  ) {
    for (const url of urls) {
      const found = yield* getJson(url, schema);
      if (Option.isSome(found)) return found;
    }
    return Option.none<S["Type"]>();
  });

  // An unauthenticated request answers with the challenge that names the resource metadata.
  const probeChallenge = (url: string) =>
    httpClient
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json, text/event-stream" }),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 0, method: "ping" }),
        ),
      )
      .pipe(
        Effect.map((response) =>
          response.status === 401 ? parseBearerChallenge(response.headers["www-authenticate"]) : {},
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.scoped,
        Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
      );

  const requestToken = (
    name: string,
    client: Pick<McpOAuthClient, "tokenEndpoint" | "authMethod" | "clientId" | "clientSecret">,
    body: Record<string, string>,
  ) => {
    const { clientSecret, ...session } = client;
    const basic = session.authMethod === "client_secret_basic";
    return httpClient
      .execute(
        HttpClientRequest.post(session.tokenEndpoint).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json",
            ...(basic
              ? {
                  authorization: `Basic ${Buffer.from(
                    `${encodeURIComponent(session.clientId)}:${encodeURIComponent(clientSecret)}`,
                  ).toString("base64")}`,
                }
              : {}),
          }),
          HttpClientRequest.bodyUrlParams({
            ...body,
            ...(basic ? {} : { client_id: session.clientId }),
            ...(session.authMethod === "client_secret_post" ? { client_secret: clientSecret } : {}),
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() => oauthError(name, "The token endpoint did not answer.")),
      );
  };

  const sessionFrom = (
    now: number,
    response: typeof TokenResponse.Type & { readonly access_token: string },
    base: McpOAuthClient,
    previousRefreshToken: string | null,
  ): McpOAuthSession => ({
    ...base,
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt: response.expires_in === undefined ? null : now + response.expires_in * 1_000,
  });

  /** Writes `value` only while the server still has the URL and client `from` was issued for. */
  const writeSession = Effect.fn("McpServers.writeSession")(function* (
    name: string,
    from: Pick<McpOAuthSession, "url" | "configuredClientId">,
    value: string,
  ) {
    const list = yield* servers;
    const current = list.find((server) => server.name === name);
    if (current?.transport !== "http" || !sessionMatches(current, from)) return false;
    yield* serverSettings
      .updateSettings({
        mcpServers: list.map((server) =>
          server.name === name && server.transport === "http"
            ? { ...server, oauthSession: value }
            : server,
        ),
      })
      .pipe(Effect.mapError(() => oauthError(name, "The sign-in could not be saved.")));
    return true;
  });

  /**
   * The configured client, else E4 Code's metadata document where the server accepts it, else a
   * client registered for this sign-in (RFC 7591).
   */
  const clientFor = Effect.fn("McpServers.clientFor")(function* (
    config: McpHttpServerConfig,
    metadata: typeof AuthorizationServerMetadata.Type,
    redirectUri: string,
    scope: string,
  ) {
    const { name } = config;
    const supported = metadata.token_endpoint_auth_methods_supported;
    if (config.oauthClientId !== "") {
      return {
        clientId: config.oauthClientId,
        clientSecret: config.oauthClientSecret,
        authMethod: tokenEndpointAuthMethod(config.oauthClientSecret, supported),
      };
    }
    // The document lists loopback redirects only.
    const acceptsDocument =
      metadata.client_id_metadata_document_supported === true &&
      isLocalLoopbackHost(new URL(redirectUri).hostname);
    if (acceptsDocument) {
      return { clientId: MCP_CLIENT_METADATA_URL, clientSecret: "", authMethod: "none" as const };
    }
    if (metadata.registration_endpoint === undefined) {
      return yield* oauthError(
        name,
        metadata.client_id_metadata_document_supported === true
          ? "Sign in from this machine at a localhost address, or enter a client ID registered with the server."
          : "The server does not let E4 Code register itself. Enter a client ID registered with it.",
      );
    }
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(metadata.registration_endpoint).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json" }),
          HttpClientRequest.bodyJsonUnsafe({
            client_name: "E4 Code",
            client_uri: "https://github.com/stonith404/e4code",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            ...(scope === "" ? {} : { scope }),
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RegistrationResponse)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() => oauthError(name, "The registration endpoint did not answer.")),
      );
    if (response.client_id === undefined) {
      return yield* oauthError(
        name,
        response.error_description ?? response.error ?? "The server did not register E4 Code.",
      );
    }
    const clientSecret = response.client_secret ?? "";
    return {
      clientId: response.client_id,
      clientSecret,
      authMethod: tokenEndpointAuthMethod(
        clientSecret,
        response.token_endpoint_auth_method === undefined
          ? supported
          : [response.token_endpoint_auth_method],
      ),
    };
  });

  const startSignIn = Effect.fn("McpServers.startSignIn")(function* (
    input: McpServerOAuthStartInput,
  ) {
    const { name, redirectUri } = input;
    const server = yield* httpServer(name);
    if (Option.isNone(server) || !server.value.oauth) {
      return yield* oauthError(name, "OAuth is not set up for this server.");
    }
    const config = server.value;
    const challenge = yield* probeChallenge(config.url);
    const resourceMetadata = yield* firstJson(
      [
        ...(challenge.resource_metadata ? [challenge.resource_metadata] : []),
        ...protectedResourceMetadataUrls(config.url),
      ],
      ProtectedResourceMetadata,
    );
    const resource = Option.match(resourceMetadata, {
      onNone: () => config.url,
      onSome: (metadata) => metadata.resource ?? config.url,
    });
    // Servers from before resource metadata are their own authorization server.
    const issuer = Option.match(resourceMetadata, {
      onNone: () => new URL(config.url).origin,
      onSome: (metadata) => metadata.authorization_servers?.[0] ?? new URL(config.url).origin,
    });
    const authorizationServer = yield* firstJson(
      authorizationServerMetadataUrls(issuer),
      AuthorizationServerMetadata,
    );
    if (Option.isNone(authorizationServer)) {
      return yield* oauthError(name, `${issuer} publishes no OAuth authorization server metadata.`);
    }
    const authorization = authorizationServer.value;
    const scope =
      config.oauthScopes ||
      challenge.scope ||
      Option.match(resourceMetadata, {
        onNone: () => "",
        onSome: (metadata) => metadata.scopes_supported?.join(" ") ?? "",
      });
    const client = yield* clientFor(config, authorization, redirectUri, scope);

    const verifier = Base64Url.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const codeChallenge = Base64Url.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
    );
    const state = Base64Url.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie));
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(pending, (current) => {
      const next = new Map(
        Array.from(current).filter(([, signIn]) => signIn.expiresAt > now && signIn.name !== name),
      );
      return next.set(state, {
        name,
        client: {
          ...client,
          tokenEndpoint: authorization.token_endpoint,
          resource,
          url: config.url,
          configuredClientId: config.oauthClientId,
        },
        verifier,
        redirectUri,
        expiresAt: now + SIGN_IN_TTL_MS,
      });
    });

    const authorizationUrl = new URL(authorization.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      resource,
      ...(scope === "" ? {} : { scope }),
    })) {
      authorizationUrl.searchParams.set(key, value);
    }
    return { authorizationUrl: authorizationUrl.href };
  });

  const completeSignIn = Effect.fn("McpServers.completeSignIn")(function* (input: {
    readonly state: string;
    readonly code: string | null;
    readonly error: string | null;
    readonly errorDescription: string | null;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const signIn = yield* Ref.modify(pending, (current) => {
      const next = new Map(current);
      next.delete(input.state);
      return [current.get(input.state), next] as const;
    });
    if (signIn === undefined || signIn.expiresAt <= now) {
      return yield* oauthError(
        "the MCP server",
        "This sign-in expired. Start it again in Settings.",
      );
    }
    const { name } = signIn;
    if (input.error !== null || input.code === null) {
      return yield* oauthError(
        name,
        input.errorDescription ?? input.error ?? "No authorization code came back.",
      );
    }
    const { client } = signIn;
    const response = yield* requestToken(name, client, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: signIn.redirectUri,
      code_verifier: signIn.verifier,
      resource: client.resource,
    });
    if (response.access_token === undefined) {
      return yield* oauthError(
        name,
        response.error_description ?? response.error ?? "The server issued no access token.",
      );
    }
    const session = sessionFrom(
      yield* Clock.currentTimeMillis,
      { ...response, access_token: response.access_token },
      client,
      null,
    );
    const saved = yield* writeSession(name, client, encodeSession(session));
    if (!saved) {
      return yield* oauthError(name, "The server changed during sign-in. Sign in again.");
    }
    return { name };
  });

  const refresh = Effect.fn("McpServers.refresh")(function* (
    name: string,
    session: McpOAuthSession,
  ) {
    if (session.refreshToken === null) {
      yield* writeSession(name, session, "");
      return Option.none<string>();
    }
    const response = yield* requestToken(name, session, {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      resource: session.resource,
    });
    if (response.access_token === undefined) {
      yield* Effect.logWarning("MCP server refused the token refresh; signing out.", {
        server: name,
        error: response.error,
      });
      yield* writeSession(name, session, "");
      return Option.none<string>();
    }
    const next = sessionFrom(
      yield* Clock.currentTimeMillis,
      { ...response, access_token: response.access_token },
      session,
      session.refreshToken,
    );
    yield* writeSession(name, session, encodeSession(next));
    return Option.some(next.accessToken);
  });

  const accessToken = Effect.fn("McpServers.accessToken")(function* (
    name: string,
    rejected?: string,
  ) {
    return yield* refreshLock.withPermits(1)(
      Effect.gen(function* () {
        const server = yield* httpServer(name);
        if (Option.isNone(server)) return Option.none<string>();
        const session = decodeSession(server.value.oauthSession);
        if (Option.isNone(session) || !sessionMatches(server.value, session.value)) {
          return Option.none<string>();
        }
        const now = yield* Clock.currentTimeMillis;
        const due =
          session.value.accessToken === rejected ||
          (session.value.expiresAt !== null && session.value.expiresAt - REFRESH_MARGIN_MS <= now);
        return due ? yield* refresh(name, session.value) : Option.some(session.value.accessToken);
      }),
    );
  });

  const forProviderInstance = Effect.fn("McpServers.forProviderInstance")(function* (
    instanceId: ProviderInstanceId,
    mcpSession: McpProviderSessionConfig | undefined,
  ) {
    return (yield* servers).flatMap((server): ReadonlyArray<ProviderMcpServer> => {
      if (!server.enabled || !server.providerInstanceIds.includes(instanceId)) return [];
      if (server.transport === "stdio") {
        const { name, command, args, env } = server;
        return [{ name, transport: "stdio", command, args, env }];
      }
      if (!server.oauth) {
        return [{ name: server.name, transport: "http", url: server.url, headers: server.headers }];
      }
      if (mcpSession === undefined || server.oauthSession === "") return [];
      return [
        {
          name: server.name,
          transport: "http",
          url: new URL(`${MCP_SERVER_PROXY_PATH}/${server.name}`, mcpSession.endpoint).href,
          headers: { Authorization: mcpSession.authorizationHeader },
        },
      ];
    });
  });

  const proxyTarget = Effect.fn("McpServers.proxyTarget")(function* (
    name: string,
    instanceId: ProviderInstanceId,
  ) {
    return Option.filter(
      yield* httpServer(name),
      (server) => server.enabled && server.oauth && server.providerInstanceIds.includes(instanceId),
    );
  });

  return McpServers.of({
    forProviderInstance,
    proxyTarget,
    startSignIn,
    completeSignIn,
    accessToken,
  });
});

export const layer = Layer.effect(McpServers, make);
