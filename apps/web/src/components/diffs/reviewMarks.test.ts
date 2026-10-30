import { describe, expect, it } from "vite-plus/test";

import {
  deriveFileReviewState,
  dropFoldFlips,
  foldedFileKeys,
  foldFlips,
  updateScopeMarks,
} from "./reviewMarks";

describe("deriveFileReviewState", () => {
  it("reads a reviewed file as changed once its diff moves on, but keeps a flag", () => {
    const reviewed = { state: "reviewed", version: "a..b" } as const;
    const flagged = { state: "flagged", version: "a..b" } as const;
    expect(deriveFileReviewState(undefined, "a..b")).toBe("unreviewed");
    expect(deriveFileReviewState(reviewed, "a..b")).toBe("reviewed");
    expect(deriveFileReviewState(reviewed, "a..c")).toBe("changed");
    expect(deriveFileReviewState(reviewed, null)).toBe("reviewed");
    expect(deriveFileReviewState(flagged, "a..c")).toBe("flagged");
  });
});

describe("updateScopeMarks", () => {
  it("clears unmarked files and keeps only the most recently used scopes", () => {
    const mark = { state: "reviewed", version: "v" } as const;
    let byScope = updateScopeMarks({}, "scope-0", { "a.ts": mark, "b.ts": mark }, 0);
    byScope = updateScopeMarks(byScope, "scope-0", { "a.ts": null }, 1);
    expect(byScope["scope-0"]?.files).toEqual({ "b.ts": mark });

    for (let index = 1; index <= 200; index++) {
      byScope = updateScopeMarks(byScope, `scope-${index}`, { "a.ts": mark }, index + 1);
    }
    expect(Object.keys(byScope)).toHaveLength(200);
    expect(byScope["scope-0"]).toBeUndefined();
    expect(byScope["scope-200"]?.files).toEqual({ "a.ts": mark });
  });
});

describe("foldedFileKeys", () => {
  it("folds reviewed files, keeps manual folds until the file's review state changes", () => {
    const files = ["a"];
    const none = new Set<string>();
    const reviewed = new Set(["a"]);
    expect(foldedFileKeys(files, none, undefined)).toEqual(new Set());

    const folded = foldFlips(files, none, new Set(["a"]));
    expect(foldedFileKeys(files, none, folded)).toEqual(new Set(["a"]));

    const afterReview = dropFoldFlips(folded, files);
    expect(foldedFileKeys(files, reviewed, afterReview)).toEqual(new Set(["a"]));

    const unfolded = foldFlips(files, reviewed, new Set());
    expect(foldedFileKeys(files, reviewed, unfolded)).toEqual(new Set());
    // The agent edits the reviewed file, so it reads as changed, not reviewed.
    expect(foldedFileKeys(files, none, unfolded)).toEqual(new Set());

    const afterReReview = dropFoldFlips(unfolded, files);
    expect(foldedFileKeys(files, reviewed, afterReReview)).toEqual(new Set(["a"]));
  });
});
