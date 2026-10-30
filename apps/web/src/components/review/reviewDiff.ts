import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";

// Pierre cannot load a new file's contents into its patch, but the patch's one hunk already holds the whole file
export function completeNewFileDiff(fileDiff: FileDiffMetadata): FileDiffMetadata | null {
  if (fileDiff.type !== "new" || !fileDiff.isPartial || fileDiff.hunks.length !== 1) return null;
  const complete = parseDiffFromFile(null, {
    name: fileDiff.name,
    contents: fileDiff.additionLines.join(""),
    ...(fileDiff.lang ? { lang: fileDiff.lang } : {}),
  });
  // Review marks are keyed by the blob ids, which a diff rebuilt from contents lacks
  const { prevObjectId, newObjectId, mode, cacheKey } = fileDiff;
  return Object.assign(complete, {
    prevObjectId,
    newObjectId,
    mode,
    cacheKey: cacheKey && `${cacheKey}:complete`,
  });
}
