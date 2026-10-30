import type { FileDiffMetadata } from "@pierre/diffs";

export interface OverviewMark {
  /** Fraction of the fully expanded file where the change starts. */
  readonly top: number;
  readonly height: number;
  readonly kind: "added" | "deleted" | "modified";
}

/** Where each change block sits in the fully expanded file, for a scrollbar-style overview. */
export function overviewMarks(
  fileDiff: FileDiffMetadata,
  diffStyle: "unified" | "split",
  /** Whether `additionLines` holds the whole new file, so the unchanged tail is known. */
  wholeFile: boolean,
): ReadonlyArray<OverviewMark> {
  const blocks: Array<{ row: number; rows: number; kind: OverviewMark["kind"] }> = [];
  let row = 0;
  let lastAdditionLine = 0;
  for (const hunk of fileDiff.hunks) {
    row += hunk.collapsedBefore;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        row += content.lines;
        continue;
      }
      const rows =
        diffStyle === "split"
          ? Math.max(content.deletions, content.additions)
          : content.deletions + content.additions;
      blocks.push({
        row,
        rows,
        kind: content.additions === 0 ? "deleted" : content.deletions === 0 ? "added" : "modified",
      });
      row += rows;
    }
    lastAdditionLine = Math.max(0, hunk.additionStart - 1) + hunk.additionCount;
  }
  const total =
    row + (wholeFile ? Math.max(0, fileDiff.additionLines.length - lastAdditionLine) : 0);
  return total === 0
    ? []
    : blocks.map((block) => ({
        top: block.row / total,
        height: block.rows / total,
        kind: block.kind,
      }));
}
