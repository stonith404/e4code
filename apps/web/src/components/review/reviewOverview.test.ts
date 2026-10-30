import { hydratePartialDiff } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { firstChangedLine, overviewMarks } from "./reviewOverview";

describe("overviewMarks", () => {
  it("places change blocks within the whole file once its unchanged tail is known", () => {
    const fileDiff = parsePatchFiles(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -9,3 +9,3 @@",
        " L9",
        "-L10",
        "+X",
        " L11",
        "@@ -89,3 +89,4 @@",
        " L89",
        " L90",
        "+NEW",
        " L91",
      ].join("\n"),
      "review-overview-test",
    )[0]!.files[0]!;
    expect(overviewMarks(fileDiff, "unified", false).at(-1)?.top).toBe(91 / 93);
    expect(firstChangedLine(fileDiff)).toEqual({ lineNumber: 10, side: "additions" });

    const oldLines = Array.from({ length: 100 }, (_, index) => `L${index + 1}\n`);
    const newLines = oldLines.with(9, "X\n").toSpliced(90, 0, "NEW\n");
    hydratePartialDiff("merge", fileDiff, {
      oldFile: { name: "a.ts", contents: oldLines.join("") },
      newFile: { name: "a.ts", contents: newLines.join("") },
    });
    expect(overviewMarks(fileDiff, "unified", true)).toEqual([
      { top: 9 / 102, height: 2 / 102, kind: "modified" },
      { top: 91 / 102, height: 1 / 102, kind: "added" },
    ]);
    expect(overviewMarks(fileDiff, "split", true)).toEqual([
      { top: 9 / 101, height: 1 / 101, kind: "modified" },
      { top: 90 / 101, height: 1 / 101, kind: "added" },
    ]);
    expect(firstChangedLine(fileDiff)).toEqual({ lineNumber: 10, side: "additions" });
  });
});
