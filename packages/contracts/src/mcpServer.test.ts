import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { McpServerName, McpServerOAuthError } from "./mcpServer.ts";

const decode = Schema.decodeUnknownSync(McpServerName);

describe("McpServerName", () => {
  it.each(["t3-code", "t3-code-direct"])("reserves the built-in %s server", (name) => {
    expect(() => decode(name)).toThrow(/reserved/);
  });

  it("allows user server names", () => {
    expect(decode("docs-mcp")).toBe("docs-mcp");
  });
});

it("keeps the error type name separate from the MCP server name", () => {
  const error = new McpServerOAuthError({ serverName: "docs-mcp", detail: "Refused." });
  expect(error.name).toBe("McpServerOAuthError");
  expect(error.message).toBe("Could not sign in to docs-mcp: Refused.");
});
