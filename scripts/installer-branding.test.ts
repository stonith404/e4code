// @effect-diagnostics nodeBuiltinImport:off - Reads the checked-in NSIS template for static branding assertions.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const installer = NodeFS.readFileSync(
  new URL("../apps/desktop/resources/installer.nsh", import.meta.url),
  "utf8",
);

describe("Windows installer running-app messages", () => {
  it.each(["E4 Code", "E4 Code (Nightly)"])("recognizes a running %s build", (name) => {
    expect(installer).toContain(`'${name}'`);
    expect(installer).toMatch(new RegExp(`\\$1 == "${name.replace(/[()]/g, "\\$&")}"`));
  });

  it.each(["T3 Code (Alpha)", "T3 Code (Beta)", "T3 Code (Nightly)"])(
    "keeps upstream's legacy %s detection",
    (name) => {
      expect(installer).toContain(`'${name}'`);
    },
  );
});
