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

describe("remote setup installer commands", () => {
  it("installs E4 rather than upstream on the other computer", () => {
    const component = NodeFS.readFileSync(
      new URL("../apps/web/src/components/InstallT3Commands.tsx", import.meta.url),
      "utf8",
    );
    for (const extension of ["sh", "ps1"]) {
      expect(component).toContain(
        `https://raw.githubusercontent.com/stonith404/e4code/main/scripts/install.${extension}`,
      );
    }
    expect(component).not.toContain("https://t3.codes/install");
  });
});

describe("standalone installer state isolation", () => {
  it("uses E4's home by default on POSIX and Windows", () => {
    const posix = NodeFS.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
    const windows = NodeFS.readFileSync(new URL("./install.ps1", import.meta.url), "utf8");
    expect(posix).toContain('t3_home="${T3CODE_HOME:-$HOME/.e4}"');
    expect(windows).toContain('else { Join-Path $HOME ".e4" }');
  });
});
