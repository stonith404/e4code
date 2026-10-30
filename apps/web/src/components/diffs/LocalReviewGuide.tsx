import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ReviewDiffPreviewSourceKind,
  ReviewGuideResult,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { getDiffLineStat } from "~/lib/diffRendering";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";

import ChatMarkdown from "../ChatMarkdown";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { GuideFileDiff } from "../pullRequest/guide/GuideFileDiff";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { DiffFileReviewControl } from "./DiffFileReviewControl";

const RUN_POLL_MS = 5_000;

export function LocalReviewGuide({
  environmentId,
  projectId,
  cwd,
  sourceKind,
  baseRef,
  ignoreWhitespace,
  diffHash,
  reviewScopeKey,
  files,
  loadDiffFiles,
  isCollapsed,
  onToggleCollapsed,
  onWantPaths,
  onReviewedChange,
  onFlaggedChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  sourceKind: ReviewDiffPreviewSourceKind;
  baseRef: string | null;
  ignoreWhitespace: boolean;
  /** The diff on screen; a guide written for another one is stale. */
  diffHash: string | null;
  reviewScopeKey: string;
  files: ReadonlyMap<string, FileDiffMetadata>;
  loadDiffFiles: FileDiffContentsLoader;
  isCollapsed: (fileDiff: FileDiffMetadata) => boolean;
  onToggleCollapsed: (fileDiff: FileDiffMetadata) => void;
  onWantPaths: (paths: ReadonlyArray<string>) => void;
  onReviewedChange: (fileDiff: FileDiffMetadata, reviewed: boolean) => void;
  onFlaggedChange: (fileDiff: FileDiffMetadata, flagged: boolean) => void;
}) {
  const input = { cwd, sourceKind, ...(baseRef === null ? {} : { baseRef }) };
  const query = useEnvironmentQuery(reviewEnvironment.guide({ environmentId, input }));
  const canWrite = useAtomValue(reviewEnvironment.generateGuide.permissionAtom(environmentId));
  const generate = useAtomCommand(reviewEnvironment.generateGuide, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  // The start's own answer stands until a read newer than it arrives.
  const [answer, setAnswer] = useState<{ at: number; result: ReviewGuideResult } | null>(null);
  const data =
    answer !== null && answer.at > query.dataUpdatedAt ? answer.result : (query.data ?? null);
  const running = starting || data?.run?._tag === "Running";
  const refresh = query.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server while it writes the guide in the background
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const write = async () => {
    if (running) return;
    setStarting(true);
    const result = await generate({
      environmentId,
      input: { ...input, projectId, ignoreWhitespace },
    });
    setStarting(false);
    if (result._tag === "Success") {
      setAnswer({ at: Date.now(), result: result.value });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not start a review guide",
      description: readableFailure(
        squashAtomCommandFailure(result),
        "Check the review guide model in Settings → Source control.",
      ),
    });
  };

  const guide = data?.guide ?? null;
  const failure = data?.run?._tag === "Failed" ? data.run.detail : null;
  const writeButton = (label: string, size: "sm" | "xs") =>
    canWrite ? (
      <Button size={size} variant="outline" disabled={running} onClick={() => void write()}>
        {running ? <Spinner /> : <SparklesIcon aria-hidden className="size-3.5" />}
        {running ? "Reading the changes..." : label}
      </Button>
    ) : null;

  if (guide === null) {
    if (query.isPending && data === null) {
      return (
        <div className="flex min-h-48 flex-1 items-center justify-center">
          <Spinner />
        </div>
      );
    }
    return (
      <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {running ? "Writing a review guide" : "No review guide yet"}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {failure ??
            query.error ??
            (running
              ? "An agent is reading the changes. This takes a few minutes; you can keep working."
              : "An agent summarizes the changes and groups the files in a good order to read them.")}
        </p>
        {writeButton(failure === null ? "Write guide" : "Try again", "sm")}
      </div>
    );
  }

  const stale = diffHash !== null && diffHash !== guide.diffHash;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-4 px-3 py-3">
        {stale || failure !== null || running ? (
          <Alert variant={running ? "info" : "warning"}>
            {running ? <Spinner /> : <TriangleAlertIcon />}
            <AlertDescription>
              {running
                ? "Rewriting this guide."
                : (failure ?? "The changes moved on since this guide was written.")}
            </AlertDescription>
            {!running && canWrite ? (
              <AlertAction>{writeButton("Rewrite", "xs")}</AlertAction>
            ) : null}
          </Alert>
        ) : null}
        {guide.summary !== "" ? (
          <section className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 text-sm">
            <ChatMarkdown text={guide.summary} cwd={cwd} environmentId={environmentId} />
          </section>
        ) : null}
        <DiffWorkerPoolProvider>
          {guide.groups.map((group, index) => (
            <section key={group.title} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                {index + 1}. {group.title}
              </h3>
              <ul className="overflow-hidden rounded-lg border border-border/70">
                {group.files.map((path) => {
                  const file = files.get(path);
                  const open = file !== undefined && !isCollapsed(file);
                  const slash = path.lastIndexOf("/");
                  return (
                    <li
                      key={path}
                      className="border-b border-border/60 [contain-intrinsic-block-size:auto_12rem] [content-visibility:auto] last:border-b-0"
                    >
                      <div className="flex items-center gap-2 px-2 py-1">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-xs"
                          aria-expanded={open}
                          onClick={() =>
                            file === undefined ? onWantPaths([path]) : onToggleCollapsed(file)
                          }
                        >
                          {open ? (
                            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">
                            <span className="text-muted-foreground">
                              {path.slice(0, slash + 1)}
                            </span>
                            {path.slice(slash + 1)}
                          </span>
                        </button>
                        {file === undefined ? null : (
                          <>
                            <DiffStatLabel
                              {...getDiffLineStat([file])}
                              className="text-2xs"
                              layout="inline"
                            />
                            <DiffFileReviewControl
                              scopeKey={reviewScopeKey}
                              fileDiff={file}
                              onReviewedChange={onReviewedChange}
                              onFlaggedChange={onFlaggedChange}
                            />
                          </>
                        )}
                      </div>
                      {open ? <GuideFileDiff file={file} loadDiffFiles={loadDiffFiles} /> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </DiffWorkerPoolProvider>
      </div>
    </div>
  );
}
