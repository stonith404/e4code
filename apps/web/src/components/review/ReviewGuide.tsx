import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ReviewGuideGroup,
  ReviewGuideInput,
  ReviewGuideResult,
} from "@t3tools/contracts";
import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";

import ChatMarkdown from "../ChatMarkdown";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

const RUN_POLL_MS = 5_000;

export type ReviewGuideState = ReturnType<typeof useReviewGuide>;

export function useReviewGuide({
  environmentId,
  projectId,
  input,
  ignoreWhitespace,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  input: ReviewGuideInput | null;
  ignoreWhitespace: boolean;
}) {
  const query = useEnvironmentQuery(
    input === null ? null : reviewEnvironment.guide({ environmentId, input }),
  );
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
    if (running || input === null || projectId === null) return;
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

  return {
    guide: data?.guide ?? null,
    failure: data?.run?._tag === "Failed" ? data.run.detail : null,
    loading: query.isPending && data === null,
    error: query.error,
    running,
    canWrite: canWrite && projectId !== null,
    write,
  };
}

export function ReviewGuideSidebar({
  state,
  diffHash,
  cwd,
  environmentId,
  groups,
  uncoveredPaths,
  renderFile,
}: {
  state: ReviewGuideState;
  /** The diff on screen; a guide written for another one is stale. */
  diffHash: string | null;
  cwd: string;
  environmentId: EnvironmentId;
  /** The guide's groups, keeping only files still in the diff. */
  groups: ReadonlyArray<ReviewGuideGroup>;
  /** Changed files the guide does not list, such as ones added after it was written. */
  uncoveredPaths: ReadonlyArray<string>;
  renderFile: (path: string) => ReactNode;
}) {
  const { guide, failure, running, canWrite } = state;
  const writeButton = (label: string, size: "sm" | "xs") =>
    canWrite ? (
      <Button size={size} variant="outline" disabled={running} onClick={() => void state.write()}>
        {running ? <Spinner /> : <SparklesIcon aria-hidden className="size-3.5" />}
        {running ? "Reading the changes..." : label}
      </Button>
    ) : null;

  if (guide === null) {
    if (state.loading) {
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
        <p className="text-xs text-muted-foreground">
          {failure ??
            state.error ??
            (running
              ? "An agent is reading the changes. This takes a few minutes; you can keep working."
              : "An agent summarizes the changes and groups the files in a good order to read them.")}
        </p>
        {writeButton(failure === null ? "Write guide" : "Try again", "sm")}
      </div>
    );
  }

  const stale = diffHash !== null && diffHash !== guide.diffHash;
  const shownGroups =
    uncoveredPaths.length === 0
      ? groups
      : [...groups, { title: "Not in the guide", files: uncoveredPaths }];

  return (
    <div className="flex flex-col gap-3 py-2">
      {stale || failure !== null || running ? (
        <Alert variant={running ? "info" : "warning"} className="mx-2 w-auto">
          {running ? <Spinner /> : <TriangleAlertIcon />}
          <AlertDescription>
            {running
              ? "Rewriting this guide."
              : (failure ?? "The changes moved on since this guide was written.")}
          </AlertDescription>
          {!running && canWrite ? <AlertAction>{writeButton("Rewrite", "xs")}</AlertAction> : null}
        </Alert>
      ) : null}
      {guide.summary !== "" ? (
        <section className="mx-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 text-xs">
          <ChatMarkdown text={guide.summary} cwd={cwd} environmentId={environmentId} />
        </section>
      ) : null}
      {shownGroups.map((group, index) => (
        <section key={group.title} className="flex flex-col gap-0.5">
          <h3 className="px-3 text-2xs font-medium text-muted-foreground">
            {index < groups.length ? `${index + 1}. ${group.title}` : group.title}
          </h3>
          <ul className="px-1.5">
            {group.files.map((path) => (
              <li key={path}>{renderFile(path)}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
