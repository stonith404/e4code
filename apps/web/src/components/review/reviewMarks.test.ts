import { describe, expect, it } from "vite-plus/test";

import { deriveFileReviewState, updateScopeMarks } from "./reviewMarks";

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
