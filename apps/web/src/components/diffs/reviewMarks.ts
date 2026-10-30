import type { FileDiffMetadata } from "@pierre/diffs";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { buildFileDiffContentVersion } from "~/lib/diffRendering";
import { resolveStorage } from "~/lib/storage";

export interface ReviewMark {
  readonly state: "reviewed" | "flagged";
  /** The file's diff version when it was marked; a reviewed file whose diff moves on reads as changed. */
  readonly version: string;
}

export type FileReviewState = "unreviewed" | "reviewed" | "flagged" | "changed";

type ScopeMarks = {
  readonly updatedAt: number;
  readonly files: Readonly<Record<string, ReviewMark>>;
};

type MarksByScope = Readonly<Record<string, ScopeMarks>>;

const MAX_SCOPES = 200;
const NO_MARKS: Readonly<Record<string, ReviewMark>> = {};

// Blob ids from the diff's index line name the exact contents, whatever whitespace mode rendered it.
export function fileReviewVersion(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevObjectId || fileDiff.newObjectId
    ? `${fileDiff.prevObjectId ?? ""}..${fileDiff.newObjectId ?? ""}`
    : String(buildFileDiffContentVersion(fileDiff));
}

/** A null version means the file's patch has not loaded yet, so a reviewed mark cannot be checked. */
export function deriveFileReviewState(
  mark: ReviewMark | undefined,
  version: string | null,
): FileReviewState {
  if (mark === undefined) return "unreviewed";
  if (mark.state === "flagged") return "flagged";
  return version === null || version === mark.version ? "reviewed" : "changed";
}

// A flip carries the reviewed state it was made under, so a change to a reviewed file drops it.
const foldFlipKey = (fileKey: string, reviewed: boolean) => `${fileKey}\u0000${reviewed}`;

/** Reviewed files fold by default; `flips` are the folds the user toggled against that default. */
export function foldedFileKeys(
  fileKeys: ReadonlyArray<string>,
  reviewed: ReadonlySet<string>,
  flips: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  return new Set(
    fileKeys.filter(
      (fileKey) =>
        reviewed.has(fileKey) !==
        (flips?.has(foldFlipKey(fileKey, reviewed.has(fileKey))) === true),
    ),
  );
}

export function foldFlips(
  fileKeys: ReadonlyArray<string>,
  reviewed: ReadonlySet<string>,
  folded: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    fileKeys
      .filter((fileKey) => folded.has(fileKey) !== reviewed.has(fileKey))
      .map((fileKey) => foldFlipKey(fileKey, reviewed.has(fileKey))),
  );
}

/** Marking a file returns it to its default fold. */
export function dropFoldFlips(
  flips: ReadonlySet<string>,
  fileKeys: ReadonlyArray<string>,
): ReadonlySet<string> {
  const next = new Set(flips);
  for (const fileKey of fileKeys) {
    next.delete(foldFlipKey(fileKey, true));
    next.delete(foldFlipKey(fileKey, false));
  }
  return next;
}

export function updateScopeMarks(
  byScope: MarksByScope,
  scopeKey: string,
  changes: Readonly<Record<string, ReviewMark | null>>,
  now: number,
): MarksByScope {
  const files: Record<string, ReviewMark> = { ...byScope[scopeKey]?.files };
  for (const [path, mark] of Object.entries(changes)) {
    if (mark === null) delete files[path];
    else files[path] = mark;
  }
  const { [scopeKey]: _previous, ...others } = byScope;
  const kept = Object.entries(others)
    .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SCOPES - 1);
  return Object.fromEntries([...kept, [scopeKey, { updatedAt: now, files }]]);
}

interface ReviewMarksState {
  readonly byScope: MarksByScope;
  readonly setMarks: (
    scopeKey: string,
    changes: Readonly<Record<string, ReviewMark | null>>,
  ) => void;
}

export const useReviewMarksStore = create<ReviewMarksState>()(
  persist(
    (set) => ({
      byScope: {},
      setMarks: (scopeKey, changes) =>
        set((state) => ({
          byScope: updateScopeMarks(state.byScope, scopeKey, changes, Date.now()),
        })),
    }),
    {
      name: "t3code:review-marks:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byScope: state.byScope }),
    },
  ),
);

export function useScopeReviewMarks(scopeKey: string | null) {
  return useReviewMarksStore((state) =>
    scopeKey === null ? NO_MARKS : (state.byScope[scopeKey]?.files ?? NO_MARKS),
  );
}
