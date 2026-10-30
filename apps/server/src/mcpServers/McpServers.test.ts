import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MCP_SERVER_OAUTH_CALLBACK_PATH,
  type McpServerConfig,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import clientMetadataDocument from "../../../../oauth/mcp-client.json" with { type: "json" };
import * as ServerSettings from "../serverSettings.ts";
import * as McpServers from "./McpServers.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");
const REDIRECT_URI = "http://127.0.0.1:3773/oauth/mcp-servers/callback";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly form: URLSearchParams;
  readonly authorization: string | undefined;
}

type Reply = {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
};

const linear = (overrides: Partial<Extract<McpServerConfig, { transport: "http" }>> = {}) =>
  ({
    name: "linear",
    enabled: true,
    providerInstanceIds: [CLAUDE],
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: {},
    oauth: true,
    oauthClientId: "t3-client",
    oauthClientSecret: "t3-secret",
    oauthScopes: "",
    oauthSession: "",
    ...overrides,
  }) satisfies McpServerConfig;

/** A fake MCP server and authorization server; `token` answers the token endpoint. */
function harness(options: {
  readonly servers: ReadonlyArray<McpServerConfig>;
  readonly token: (form: URLSearchParams) => Reply;
}) {
  const requests: Array<Sent> = [];
  const reply = (sent: Sent): Reply => {
    if (sent.method === "POST" && sent.url === "https://mcp.example.com/mcp") {
      return {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="issues:read"',
        },
      };
    }
    if (sent.url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return {
        body: {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        },
      };
    }
    if (sent.url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return {
        body: {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
          client_id_metadata_document_supported: true,
        },
      };
    }
    if (sent.url === "https://auth.example.com/token") return options.token(sent.form);
    return { status: 404 };
  };
  const http = HttpClient.make((request) => {
    const sent: Sent = {
      method: request.method,
      url: request.url,
      form: new URLSearchParams(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      ),
      authorization: request.headers["authorization"],
    };
    requests.push(sent);
    const answer = reply(sent);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers: { "content-type": "application/json", ...answer.headers },
        }),
      ),
    );
  });
  const layer = McpServers.layer.pipe(
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({ mcpServers: options.servers }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { layer, requests };
}

const mcpSession = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: CLAUDE,
  endpoint: "http://127.0.0.1:3773/mcp",
  authorizationHeader: "Bearer t3-session-token",
  browserToolsAvailable: true,
};

const signIn = Effect.fn("signIn")(function* () {
  const mcpServers = yield* McpServers.McpServers;
  const started = yield* mcpServers.startSignIn({ name: "linear", redirectUri: REDIRECT_URI });
  const authorization = new URL(started.authorizationUrl);
  yield* mcpServers.completeSignIn({
    state: authorization.searchParams.get("state") ?? "",
    code: "auth-code",
    error: null,
    errorDescription: null,
  });
  return authorization;
});

const savedSession = ServerSettings.ServerSettingsService.pipe(
  Effect.flatMap((settings) => settings.getSettings),
  Effect.map((settings) => {
    const server = settings.mcpServers.find((candidate) => candidate.name === "linear");
    return server?.transport === "http" ? server.oauthSession : undefined;
  }),
);

describe("McpServers OAuth", () => {
  it.effect("signs in with PKCE, proxies only signed-in servers, and refreshes when due", () => {
    let issued = 0;
    const { layer, requests } = harness({
      servers: [
        linear(),
        {
          name: "docs",
          enabled: true,
          providerInstanceIds: [CLAUDE, CODEX],
          transport: "stdio",
          command: "npx",
          args: ["docs-mcp"],
          env: { DOCS_TOKEN: "docs-token" },
        },
      ],
      token: () => {
        issued += 1;
        return {
          body: {
            access_token: `access-${issued}`,
            expires_in: 3600,
            ...(issued === 1 ? { refresh_token: "refresh-1" } : {}),
          },
        };
      },
    });
    return Effect.gen(function* () {
      const mcpServers = yield* McpServers.McpServers;
      expect(
        (yield* mcpServers.forProviderInstance(CLAUDE, mcpSession)).map((s) => s.name),
      ).toEqual(["docs"]);

      const authorization = yield* signIn();
      expect(authorization.origin + authorization.pathname).toBe(
        "https://auth.example.com/authorize",
      );
      expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
        response_type: "code",
        client_id: "t3-client",
        redirect_uri: REDIRECT_URI,
        code_challenge_method: "S256",
        resource: "https://mcp.example.com/mcp",
        scope: "issues:read",
      });
      const exchange = requests.find(
        (sent) => sent.form.get("grant_type") === "authorization_code",
      );
      const verifier = exchange?.form.get("code_verifier") ?? "";
      const challenge = Buffer.from(
        yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
        ),
      ).toString("base64url");
      expect(challenge).toBe(authorization.searchParams.get("code_challenge"));
      expect(Object.fromEntries(exchange?.form ?? [])).toMatchObject({
        code: "auth-code",
        client_id: "t3-client",
        client_secret: "t3-secret",
        redirect_uri: REDIRECT_URI,
        resource: "https://mcp.example.com/mcp",
      });

      expect(yield* mcpServers.forProviderInstance(CLAUDE, mcpSession)).toEqual([
        {
          name: "linear",
          transport: "http",
          url: "http://127.0.0.1:3773/mcp-servers/linear",
          headers: { Authorization: "Bearer t3-session-token" },
        },
        {
          name: "docs",
          transport: "stdio",
          command: "npx",
          args: ["docs-mcp"],
          env: { DOCS_TOKEN: "docs-token" },
        },
      ]);
      expect(
        (yield* mcpServers.forProviderInstance(CLAUDE, undefined)).map((s) => s.name),
        "without a T3 credential the proxy cannot authenticate the provider",
      ).toEqual(["docs"]);
      expect((yield* mcpServers.forProviderInstance(CODEX, mcpSession)).map((s) => s.name)).toEqual(
        ["docs"],
      );
      expect(Option.isSome(yield* mcpServers.proxyTarget("linear", CODEX))).toBe(false);

      expect(yield* mcpServers.accessToken("linear")).toEqual(Option.some("access-1"));
      yield* TestClock.adjust("59 minutes");
      expect(yield* mcpServers.accessToken("linear")).toEqual(Option.some("access-2"));
      const refresh = requests.findLast((sent) => sent.form.get("grant_type") === "refresh_token");
      expect(refresh?.form.get("refresh_token")).toBe("refresh-1");
      expect(
        yield* mcpServers.accessToken("linear", "access-2"),
        "a rejected token refreshes with the kept refresh token",
      ).toEqual(Option.some("access-3"));
      expect(
        requests
          .findLast((sent) => sent.form.get("grant_type") === "refresh_token")
          ?.form.get("refresh_token"),
      ).toBe("refresh-1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("signs in as E4 Code's metadata document and out when its refresh is refused", () => {
    const clientId = McpServers.MCP_CLIENT_METADATA_URL;
    const { layer, requests } = harness({
      servers: [linear({ oauthClientId: "", oauthClientSecret: "" })],
      token: (form) =>
        form.get("grant_type") === "authorization_code"
          ? { body: { access_token: "access-1", refresh_token: "refresh-1" } }
          : { status: 400, body: { error: "invalid_grant" } },
    });
    return Effect.gen(function* () {
      const mcpServers = yield* McpServers.McpServers;
      const remote = yield* Effect.flip(
        mcpServers.startSignIn({
          name: "linear",
          redirectUri: "https://e4.example.ts.net/oauth/mcp-servers/callback",
        }),
      );
      expect(remote.detail, "the document lists loopback redirects only").toContain("localhost");
      const authorization = yield* signIn();
      expect(authorization.searchParams.get("client_id")).toBe(clientId);
      const exchange = requests.find(
        (sent) => sent.form.get("grant_type") === "authorization_code",
      );
      expect(exchange?.form.get("client_id")).toBe(clientId);
      expect(exchange?.form.has("client_secret")).toBe(false);
      expect(exchange?.authorization).toBeUndefined();
      expect(yield* savedSession).not.toBe("");

      expect(yield* mcpServers.accessToken("linear", "access-1")).toEqual(Option.none());
      expect(yield* savedSession).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a callback whose state it did not issue", () => {
    const { layer } = harness({ servers: [linear()], token: () => ({ status: 500 }) });
    return Effect.gen(function* () {
      const mcpServers = yield* McpServers.McpServers;
      yield* mcpServers.startSignIn({ name: "linear", redirectUri: REDIRECT_URI });
      const error = yield* Effect.flip(
        mcpServers.completeSignIn({
          state: "forged",
          code: "auth-code",
          error: null,
          errorDescription: null,
        }),
      );
      expect(error.detail).toContain("expired");
      expect(yield* savedSession).toBe("");
    }).pipe(Effect.provide(layer));
  });
});

describe("McpServers discovery", () => {
  it("serves the client ID metadata document at the URL it names", () => {
    expect(clientMetadataDocument.client_id).toBe(McpServers.MCP_CLIENT_METADATA_URL);
    expect(clientMetadataDocument.redirect_uris).toContain(
      `http://127.0.0.1${MCP_SERVER_OAUTH_CALLBACK_PATH}`,
    );
  });

  it("lists metadata locations in the order the MCP spec tries them", () => {
    expect(McpServers.protectedResourceMetadataUrls("https://mcp.example.com/v1/mcp/")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(McpServers.authorizationServerMetadataUrls("https://auth.example.com/tenant")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);
    expect(McpServers.parseBearerChallenge('Bearer error="invalid_token", scope="a b"')).toEqual({
      error: "invalid_token",
      scope: "a b",
    });
  });
});
