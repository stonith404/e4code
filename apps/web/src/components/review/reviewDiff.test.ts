import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { completeNewFileDiff } from "./reviewDiff";

describe("completeNewFileDiff", () => {
  it("rebuilds a new file's patch as a complete diff that keeps its blob ids", () => {
    const fileDiff = parsePatchFiles(
      [
        "diff --git a/src/tax.ts b/src/tax.ts",
        "new file mode 100644",
        "index 0000000..1a2b3c4",
        "--- /dev/null",
        "+++ b/src/tax.ts",
        "@@ -0,0 +1,2 @@",
        "+export const RATE = 0.2;",
        "+export const tax = (amount: number) => amount * RATE;",
        "\\ No newline at end of file",
      ].join("\n"),
      { cacheKeyPrefix: "review-diff-test" },
    )[0]!.files[0]!;
    const complete = completeNewFileDiff(fileDiff);
    expect(complete?.isPartial).toBe(false);
    expect(complete?.type).toBe("new");
    expect(complete?.additionLines.join("")).toBe(
      "export const RATE = 0.2;\nexport const tax = (amount: number) => amount * RATE;",
    );
    expect(complete?.newObjectId).toBe("1a2b3c4");
  });
});
