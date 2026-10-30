import type { FileDiffMetadata } from "@pierre/diffs";
import { FlagIcon } from "lucide-react";

import { resolveFileDiffPath } from "~/lib/diffRendering";

import { Checkbox } from "../ui/checkbox";
import { Kbd } from "../ui/kbd";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveFileReviewState,
  fileReviewVersion,
  markFile,
  useReviewMarksStore,
} from "./reviewMarks";

// Reads its own mark from the store, so a memoized diff header still updates when it changes.
export function ReviewFileControl({
  scopeKey,
  fileDiff,
}: {
  scopeKey: string;
  fileDiff: FileDiffMetadata;
}) {
  const path = resolveFileDiffPath(fileDiff);
  const mark = useReviewMarksStore((state) => state.byScope[scopeKey]?.files[path]);
  const state = deriveFileReviewState(mark, fileReviewVersion(fileDiff));
  return (
    <span className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={state === "flagged" ? `Unflag ${path}` : `Check ${path} later`}
              variant="ghost"
              size="xs"
              pressed={state === "flagged"}
              onPressedChange={(pressed) =>
                markFile(scopeKey, fileDiff, pressed ? "flagged" : null)
              }
            />
          }
        >
          <FlagIcon
            className={state === "flagged" ? "size-3.5 text-warning-foreground" : "size-3.5"}
          />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {state === "flagged" ? "Remove check later" : "Check later"}
          <Kbd className="ml-1.5">M</Kbd>
        </TooltipPopup>
      </Tooltip>
      <label className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground">
        <Checkbox
          aria-label={state === "changed" ? `${path} changed since reviewed` : `Reviewed ${path}`}
          checked={state === "reviewed"}
          onCheckedChange={(checked) => markFile(scopeKey, fileDiff, checked ? "reviewed" : null)}
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
          <Tooltip>
            <TooltipTrigger render={<span className="@max-xs:hidden" />}>Reviewed</TooltipTrigger>
            <TooltipPopup side="bottom">
              Mark reviewed
              <Kbd className="ml-1.5">R</Kbd>
            </TooltipPopup>
          </Tooltip>
        )}
      </label>
    </span>
  );
}
