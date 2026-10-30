import { T, useGT } from "gt-react";
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
  const gt = useGT();
  const path = resolveFileDiffPath(fileDiff);
  const mark = useReviewMarksStore((state) => state.byScope[scopeKey]?.files[path]);
  const state = deriveFileReviewState(mark, fileReviewVersion(fileDiff));
  return (
    <span className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={
                state === "flagged"
                  ? gt("Unflag {path}", { path: path })
                  : gt("Check {path} later", { path: path })
              }
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
          {state === "flagged" ? gt("Remove check later") : gt("Check later")}
          <Kbd className="ml-1.5">M</Kbd>
        </TooltipPopup>
      </Tooltip>
      <label className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground">
        <Checkbox
          aria-label={
            state === "changed"
              ? gt("{path} changed since reviewed", { path: path })
              : gt("Reviewed {path}", { path: path })
          }
          checked={state === "reviewed"}
          onCheckedChange={(checked) => markFile(scopeKey, fileDiff, checked ? "reviewed" : null)}
        />
        {state === "changed" ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              <T>Changed</T>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>This file changed since you marked it reviewed.</T>
            </TooltipPopup>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="@max-xs:hidden" />}>
              <T>Reviewed</T>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Mark reviewed</T>
              <Kbd className="ml-1.5">R</Kbd>
            </TooltipPopup>
          </Tooltip>
        )}
      </label>
    </span>
  );
}
