import {
  MCP_SERVER_OAUTH_CALLBACK_PATH,
  McpServerConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeMcpServerConfig = Schema.decodeUnknownOption(McpServerConfig);

/** A saved secret arrives as its redaction marker, and sending the marker back keeps it. */
export interface SecretDraft {
  readonly value: string;
  readonly saved: boolean;
}

export interface SecretEntryDraft extends SecretDraft {
  /** Keeps a row's identity while its key is edited. */
  readonly id: string;
  readonly key: string;
}

export interface McpServerDraft {
  readonly name: string;
  readonly transport: McpServerConfig["transport"];
  readonly enabled: boolean;
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly command: string;
  /** One argument per line, so an argument may contain spaces. */
  readonly args: string;
  readonly env: ReadonlyArray<SecretEntryDraft>;
  readonly url: string;
  readonly headers: ReadonlyArray<SecretEntryDraft>;
  readonly oauth: boolean;
  /** Empty signs in with E4 Code's client ID metadata document. */
  readonly clientId: string;
  readonly clientSecret: SecretDraft;
  readonly scopes: string;
}

const savedEntries = (values: Readonly<Record<string, string>>) =>
  Object.entries(values).map(([key, value]) => ({ id: key, key, value, saved: value !== "" }));

export function draftFromServer(
  server: McpServerConfig | null,
  providerInstanceIds: ReadonlyArray<ProviderInstanceId>,
): McpServerDraft {
  const draft: McpServerDraft = {
    name: "",
    transport: "http",
    enabled: true,
    providerInstanceIds,
    command: "",
    args: "",
    env: [],
    url: "",
    headers: [],
    oauth: false,
    clientId: "",
    clientSecret: { value: "", saved: false },
    scopes: "",
  };
  if (server === null) return draft;
  const shared = {
    ...draft,
    name: server.name,
    enabled: server.enabled,
    providerInstanceIds: server.providerInstanceIds,
  };
  if (server.transport === "stdio") {
    return {
      ...shared,
      transport: "stdio",
      command: server.command,
      args: server.args.join("\n"),
      env: savedEntries(server.env),
    };
  }
  return {
    ...shared,
    url: server.url,
    headers: savedEntries(server.headers),
    oauth: server.oauth,
    clientId: server.oauthClientId,
    clientSecret: { value: server.oauthClientSecret, saved: server.oauthClientSecret !== "" },
    scopes: server.oauthScopes,
  };
}

export interface McpServerDraftProblem {
  readonly field: "name" | "command" | "url";
  readonly message: string;
}

const entriesToRecord = (entries: ReadonlyArray<SecretEntryDraft>) =>
  Object.fromEntries(
    entries.flatMap((entry) =>
      entry.key.trim() !== "" && entry.value !== "" ? [[entry.key.trim(), entry.value]] : [],
    ),
  );

/**
 * The server to save, or why the draft cannot be saved. A change to how the server signs in
 * clears its session, since tokens from the old client or URL no longer apply.
 */
export function serverFromDraft(
  draft: McpServerDraft,
  previous: McpServerConfig | null,
  takenNames: ReadonlySet<string>,
): { readonly server: McpServerConfig } | { readonly problem: McpServerDraftProblem } {
  const name = draft.name.trim();
  if (previous === null && takenNames.has(name)) {
    return { problem: { field: "name", message: `A server named ${name} already exists.` } };
  }
  const shared = { name, enabled: draft.enabled, providerInstanceIds: draft.providerInstanceIds };
  let candidate: McpServerConfig;
  if (draft.transport === "stdio") {
    candidate = {
      ...shared,
      transport: "stdio",
      command: draft.command.trim(),
      args: draft.args.split("\n").filter((arg) => arg.trim() !== ""),
      env: entriesToRecord(draft.env),
    };
  } else {
    const clientId = draft.oauth ? draft.clientId.trim() : "";
    const clientSecret = clientId === "" ? "" : draft.clientSecret.value;
    const scopes = draft.oauth ? draft.scopes.trim() : "";
    const url = draft.url.trim();
    const kept =
      previous?.transport === "http" &&
      previous.oauth === draft.oauth &&
      previous.url === url &&
      previous.oauthClientId === clientId &&
      previous.oauthScopes === scopes &&
      previous.oauthClientSecret === clientSecret;
    candidate = {
      ...shared,
      transport: "http",
      url,
      headers: entriesToRecord(draft.headers),
      oauth: draft.oauth,
      oauthClientId: clientId,
      oauthClientSecret: clientSecret,
      oauthScopes: scopes,
      oauthSession: kept ? previous.oauthSession : "",
    };
  }
  if (Option.isSome(decodeMcpServerConfig(candidate))) return { server: candidate };
  if (name === "") return { problem: { field: "name", message: "Enter a name." } };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || name === "t3-code") {
    return {
      problem: {
        field: "name",
        message: "Use letters, digits, dashes, and underscores (not t3-code).",
      },
    };
  }
  return draft.transport === "stdio"
    ? { problem: { field: "command", message: "Enter the command that starts the server." } }
    : { problem: { field: "url", message: "Enter the server's http or https URL." } };
}

/** The callback the authorization server must allow, on the origin this client reaches. */
export function mcpServerRedirectUri(httpBaseUrl: string): string {
  return new URL(MCP_SERVER_OAUTH_CALLBACK_PATH, httpBaseUrl).href;
}
