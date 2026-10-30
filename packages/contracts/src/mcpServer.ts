import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** The name T3 Code's own MCP server is registered under in every provider. */
export const T3_MCP_SERVER_NAME = "t3-code";

// The name keys secrets and sign-ins, and becomes Claude's `mcp__<name>__` prefix and a Codex config key.
export const McpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
  Schema.makeFilter(
    (name) => name !== T3_MCP_SERVER_NAME || `${T3_MCP_SERVER_NAME} is reserved for T3 Code.`,
  ),
);
export type McpServerName = typeof McpServerName.Type;

// Every value is kept in the secret store; settingsSecrets.ts maps them.
const McpServerSecretMap = Schema.Record(Schema.String, Schema.String).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

const sharedFields = {
  name: McpServerName,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** The Claude and Codex instances whose sessions get this server. */
  providerInstanceIds: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
};

export const McpStdioServerConfig = Schema.Struct({
  ...sharedFields,
  transport: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  env: McpServerSecretMap,
});
export type McpStdioServerConfig = typeof McpStdioServerConfig.Type;

const emptyByDefault = TrimmedString.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")));

export const McpHttpServerConfig = Schema.Struct({
  ...sharedFields,
  transport: Schema.Literal("http"),
  url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/\S+$/)),
  headers: McpServerSecretMap,
  oauth: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** A pre-registered client; empty signs in with E4 Code's client ID metadata document. */
  oauthClientId: emptyByDefault,
  oauthClientSecret: emptyByDefault,
  /** Space-separated; empty asks for the scopes the server advertises. */
  oauthScopes: emptyByDefault,
  /** The signed-in tokens, written by the server; clearing it signs out. */
  oauthSession: emptyByDefault,
});
export type McpHttpServerConfig = typeof McpHttpServerConfig.Type;

export const McpServerConfig = Schema.Union([McpStdioServerConfig, McpHttpServerConfig]);
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpServerConfigs = Schema.Array(McpServerConfig).check(
  Schema.makeFilter(
    (servers: ReadonlyArray<{ readonly name: string }>) =>
      new Set(servers.map((server) => server.name)).size === servers.length ||
      "MCP server names must be unique.",
  ),
);

/** Where the authorization server sends the browser back, below the environment's HTTP origin. */
export const MCP_SERVER_OAUTH_CALLBACK_PATH = "/oauth/mcp-servers/callback";

export const McpServerOAuthStartInput = Schema.Struct({
  name: McpServerName,
  /** The callback on the HTTP origin this client reaches the environment at. */
  redirectUri: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/\S+$/)),
});
export type McpServerOAuthStartInput = typeof McpServerOAuthStartInput.Type;

export const McpServerOAuthStartResult = Schema.Struct({
  authorizationUrl: TrimmedNonEmptyString,
});
export type McpServerOAuthStartResult = typeof McpServerOAuthStartResult.Type;

export class McpServerOAuthError extends Schema.TaggedError<McpServerOAuthError>()(
  "McpServerOAuthError",
  { name: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not sign in to ${this.name}: ${this.detail}`;
  }
}
