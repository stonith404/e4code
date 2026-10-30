import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { McpServerName } from "./mcpServer.ts";

const decode = Schema.decodeUnknownSync(McpServerName);

describe("McpServerName", () => {
  it.each(["t3-code", "t3-code-direct"])("reserves the built-in %s server", (name) => {
    expect(() => decode(name)).toThrow(/reserved/);
  });

  it("allows user server names", () => {
    expect(decode("docs-mcp")).toBe("docs-mcp");
  });
});
