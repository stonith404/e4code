import type { FileDiffMetadata } from "@pierre/diffs";
import { FlagIcon } from "lucide-react";

import { resolveFileDiffPath } from "~/lib/diffRendering";

import { Checkbox } from "../ui/checkbox";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { deriveFileReviewState, fileReviewVersion, useReviewMarksStore } from "./reviewMarks";

// Reads its own mark from the store, so a memoized diff header still updates when it changes.
export function DiffFileReviewControl({
  scopeKey,
  fileDiff,
  onReviewedChange,
  onFlaggedChange,
}: {
  scopeKey: string;
  fileDiff: FileDiffMetadata;
  onReviewedChange: (fileDiff: FileDiffMetadata, reviewed: boolean) => void;
  onFlaggedChange: (fileDiff: FileDiffMetadata, flagged: boolean) => void;
}) {
  const path = resolveFileDiffPath(fileDiff);
  const mark = useReviewMarksStore((state) => state.byScope[scopeKey]?.files[path]);
  const state = deriveFileReviewState(mark, fileReviewVersion(fileDiff));
  return (
    <span data-review-control="" className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={state === "flagged" ? `Unflag ${path}` : `Check ${path} later`}
              variant="ghost"
              size="xs"
              pressed={state === "flagged"}
              onPressedChange={(pressed) => onFlaggedChange(fileDiff, pressed)}
            />
          }
        >
          <FlagIcon
            className={state === "flagged" ? "size-3.5 text-warning-foreground" : "size-3.5"}
          />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {state === "flagged" ? "Remove check later" : "Check later"}
        </TooltipPopup>
      </Tooltip>
      <label className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground">
        <Checkbox
          aria-label={state === "changed" ? `${path} changed since reviewed` : `Reviewed ${path}`}
          checked={state === "reviewed"}
          onCheckedChange={(checked) => onReviewedChange(fileDiff, checked)}
        />
        {state === "changed" ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              Changed
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              This file changed since you marked it reviewed.
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="@max-xs:hidden">Reviewed</span>
        )}
      </label>
    </span>
  );
}
