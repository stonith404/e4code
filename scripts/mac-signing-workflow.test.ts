// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow to check signing identity propagation.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);

describe("macOS CLI signing workflow", () => {
  it.each(["Build CLI archive", "Await CLI notarization"])(
    "passes the imported identity to %s",
    (name) => {
      const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
      expect(step).toBeDefined();
      expect(step).toContain(
        "T3CODE_CLI_MAC_SIGN_IDENTITY: ${{ steps.cli_identity.outputs.identity }}",
      );
    },
  );
});
