import { DEFAULT_SERVER_SETTINGS, McpServerConfig } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { mapSettingsSecrets, mapSettingsSecretValues, SECRET_REDACTED } from "./settingsSecrets.ts";

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
  assert.deepStrictEqual(Object.values(slots).sort(), [
    "client-secret",
    "env-secret",
    "header-secret",
    "session-secret",
  ]);
  assert.deepStrictEqual(
    redacted.mcpServers[0]?.transport === "stdio" ? redacted.mcpServers[0].env : null,
    { API_KEY: SECRET_REDACTED },
  );
  const restored = mapSettingsSecretValues(redacted, (_value, name) => slots[name] ?? "MISSING");
  assert.deepStrictEqual(restored.mcpServers, servers);
});
