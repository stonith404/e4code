import { DEFAULT_SERVER_SETTINGS, McpServerConfig } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  mapSettingsSecrets,
  mapSettingsSecretValues,
  SECRET_REDACTED,
  withoutRedirectedSecrets,
} from "./settingsSecrets.ts";

const decodeMcpServer = Schema.decodeUnknownSync(McpServerConfig);

it("maps MCP secrets through both upstream secret traversals without changing slot names or env case", () => {
  const servers = [
    decodeMcpServer({
      name: "stdio",
      transport: "stdio",
      command: "node",
      env: { API_KEY: "env-secret" },
    }),
    decodeMcpServer({
      name: "http",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { "X-Api-Key": "header-secret" },
      oauthClientSecret: "client-secret",
      oauthSession: "session-secret",
    }),
  ];
  const settings = { ...DEFAULT_SERVER_SETTINGS, mcpServers: servers };
  const slots: Record<string, string> = {};
  const redacted = mapSettingsSecrets(settings, (secret) => {
    slots[secret.secretName] = secret.value;
    return { value: "", redacted: true };
  });
  // Upstream can add other secret groups (for example cloud dictation credentials).
  // Check the MCP slots specifically, including their stable, case-sensitive encoded names.
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(slots).filter(([name]) => name.startsWith("mcp-server-"))),
    {
      "mcp-server-c3RkaW8-env-QVBJX0tFWQ": "env-secret",
      "mcp-server-aHR0cA-header-WC1BcGktS2V5": "header-secret",
      "mcp-server-aHR0cA-oauth-client-secret": "client-secret",
      "mcp-server-aHR0cA-oauth-session": "session-secret",
    },
  );
  assert.deepStrictEqual(
    redacted.mcpServers[0]?.transport === "stdio" ? redacted.mcpServers[0].env : null,
    { API_KEY: SECRET_REDACTED },
  );
  const restored = mapSettingsSecretValues(redacted, (_value, name) => slots[name] ?? "MISSING");
  assert.deepStrictEqual(restored.mcpServers, servers);
});

it("binds kept MCP credentials to their saved HTTP destination, retaining new credentials", () => {
  const saved = decodeMcpServer({
    name: "http",
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "saved" },
    oauthClientSecret: "saved",
    oauthSession: "saved",
  });
  const current = { ...DEFAULT_SERVER_SETTINGS, mcpServers: [saved] };
  const next = (url: string, secret: string) => ({
    ...current,
    mcpServers: [
      decodeMcpServer({
        ...saved,
        url,
        headers: { Authorization: secret },
        oauthClientSecret: secret,
        oauthSession: secret,
      }),
    ],
  });
  const inspect = (url: string, secret: string) => {
    const server = withoutRedirectedSecrets(current, next(url, secret)).mcpServers[0]!;
    assert.equal(server.transport, "http");
    return server.transport === "http"
      ? [server.headers.Authorization, server.oauthClientSecret, server.oauthSession]
      : [];
  };
  assert.deepEqual(inspect("https://other.example/mcp", SECRET_REDACTED), ["", "", ""]);
  assert.deepEqual(inspect("https://example.com/other", SECRET_REDACTED), ["", "", ""]);
  assert.deepEqual(inspect("https://EXAMPLE.com/mcp/", SECRET_REDACTED), [
    SECRET_REDACTED,
    SECRET_REDACTED,
    SECRET_REDACTED,
  ]);
  assert.deepEqual(inspect("https://other.example/mcp", "new"), ["new", "new", "new"]);
});
