import { RefreshIcon } from "~/components/ui/refresh-icon";
import type { FileTreeRowDecoration } from "@pierre/trees";
import {
  cloneFileDiffMetadata,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  FlagIcon,
  FolderTreeIcon,
  ListIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Rows3Icon,
  SparklesIcon,
  TextWrapIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { type CSSProperties, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { type DraftId } from "~/composerDraftStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import { useAtomCommand } from "~/state/use-atom-command";

import { DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { AnnotatableCodeView } from "../diffs/AnnotatableCodeView";
import { DiffFileLoadingBoundary } from "../diffs/DiffFileLoadingBoundary";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { useReviewFilePatches } from "../diffs/useReviewFilePatches";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ReviewFileControl } from "./ReviewFileControl";
import { ReviewGuideSidebar, useReviewGuide } from "./ReviewGuide";
import { type OverviewMark, overviewMarks } from "./reviewOverview";
import {
  deriveFileReviewState,
  fileReviewVersion,
  type FileReviewState,
  markFile,
  useScopeReviewMarks,
} from "./reviewMarks";
import { Kbd } from "../ui/kbd";
import { surfaceShortcutTargetsTypingContext } from "../RightPanelTabs";

type ReviewScope = "branch" | "unstaged" | "unpushed";

const SCOPES = {
  branch: { label: "Changes", sourceKind: "branch-range" },
  unstaged: { label: "Uncommitted", sourceKind: "working-tree" },
  unpushed: { label: "Unpushed", sourceKind: "unpushed" },
} as const;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 560;
const CODE_MIN_WIDTH = 256;
const SidebarViewSchema = Schema.Literals(["list", "tree", "guide"]);
const TREE_DECORATIONS = {
  reviewed: { icon: "t3-tree-icon-reviewed", title: "Reviewed" },
  flagged: { icon: "t3-tree-icon-flagged", title: "Check later" },
  changed: { icon: "t3-tree-icon-changed", title: "Changed since reviewed" },
} as const satisfies Record<Exclude<FileReviewState, "unreviewed">, FileTreeRowDecoration>;

// Pierre writes the loaded unchanged lines into the diff it renders, and the parsed diffs are rebuilt
// on every render, so the full-file view keeps one copy per file content.
const expandedCopies = new Map<string, FileDiffMetadata>();
const MAX_EXPANDED_COPIES = 50;
function expandedCopy(fileDiff: FileDiffMetadata) {
  const key = `${buildFileDiffIdentityKey(fileDiff)}\u0000${buildFileDiffContentVersion(fileDiff)}`;
  let copy = expandedCopies.get(key);
  if (!copy) {
    copy = cloneFileDiffMetadata(fileDiff);
    expandedCopies.set(key, copy);
    const oldest = expandedCopies.keys().next().value;
    if (expandedCopies.size > MAX_EXPANDED_COPIES && oldest !== undefined) {
      expandedCopies.delete(oldest);
    }
  }
  return copy;
}

const isPendingFile = (fileDiff: FileDiffMetadata) =>
  fileDiff.cacheKey?.endsWith(":pending") === true;

export default function ReviewPanel({
  threadRef,
  composerDraftTarget,
  workspaceMutationId,
  visible,
}: {
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
  visible: boolean;
}) {
  const theme = useRenderedAppearance();
  const settings = useClientSettings((settings) => ({
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    wordWrap: settings.wordWrap,
  }));
  const ignoreWhitespace = settings.diffIgnoreWhitespace;
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [scope, setScope] = useState<ReviewScope>("branch");
  const [sidebarView, setSidebarView] = useLocalStorage(
    "t3code.reviewSidebarView",
    "list",
    SidebarViewSchema,
  );
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  // Pierre loads the whole file into the shown diff in place, which React cannot see.
  const [hydratedDiff, setHydratedDiff] = useState<FileDiffMetadata | null>(null);

  const { environmentId } = threadRef;
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  const fileAccess = useFilesystemReadAccess(environmentId);
  const previewInput =
    fileAccess.canReadFiles && cwd
      ? { cwd, ignoreWhitespace, ...(scope === "unpushed" ? { unpushed: true } : {}) }
      : undefined;
  // Read under the workspace mutation id, so each mutation refetches the diff.
  const preview = useEnvironmentQuery(
    previewInput
      ? revisionedQuery(
          reviewEnvironment.diffPreview({ environmentId, input: previewInput }),
          workspaceMutationId,
        )
      : null,
  );
  // The surface stays mounted while hidden, and edits made outside T3 Code bump no mutation id.
  useLiveRefresh(
    preview.data !== null && !preview.isPending
      ? () => {
          if (Date.now() - preview.dataUpdatedAt < LIVE_REFRESH_MIN_INTERVAL_MS) return;
          preview.refresh();
        }
      : null,
    {
      enabled: visible && previewInput !== undefined,
      key: `review:${environmentId}:${threadRef.threadId}`,
      intervalMs: null,
      refreshOnShow: true,
    },
  );

  const source = preview.data?.sources.find((entry) => entry.kind === SCOPES[scope].sourceKind);
  const lazySource = source?.truncated && source.files ? source : null;
  const { renderableFiles, requestFile, fileStates, retry, isPending } = useReviewFilePatches({
    environmentId,
    cwd: preview.data?.cwd,
    source: lazySource,
    baseRef: lazySource?.baseRef ?? null,
    ignoreWhitespace,
    theme,
    previewInput,
    preview: getRenderablePatch(lazySource ? undefined : source?.diff, `diff-panel:${theme}`, {
      compactPartialHunkOffsets: true,
    }),
  });

  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const currentLoadDiffFiles =
    preview.data && source
      ? createGitDiffFileContentsLoader(getDiffFileContents, {
          environmentId,
          cwd: preview.data.cwd,
          sourceKind: source.kind,
          baseRef: source.baseRef,
          headRef: source.headRef,
          cacheKey: source.diffHash,
        })
      : undefined;
  const loadDiffFiles: FileDiffContentsLoader = useStableCallback(async (fileDiff) => {
    if (!currentLoadDiffFiles) throw new Error("Diff file contents are unavailable.");
    return currentLoadDiffFiles(fileDiff);
  });

  const scopeKey = `${environmentId}:${threadRef.threadId}:${scope}`;
  const marks = useScopeReviewMarks(scopeKey);
  const filesByPath = new Map(
    renderableFiles.map((fileDiff) => [resolveFileDiffPath(fileDiff), fileDiff]),
  );
  const sortedPaths = [...filesByPath.keys()];
  const reviewStates = new Map(
    [...filesByPath].map(([path, fileDiff]) => [
      path,
      deriveFileReviewState(
        marks[path],
        isPendingFile(fileDiff) ? null : fileReviewVersion(fileDiff),
      ),
    ]),
  );
  const reviewedCount = [...reviewStates.values()].filter((state) => state === "reviewed").length;
  const flaggedCount = [...reviewStates.values()].filter((state) => state === "flagged").length;

  const guideState = useReviewGuide({
    environmentId,
    projectId: thread?.projectId ?? null,
    input: sidebarView === "guide" && cwd ? { cwd, sourceKind: SCOPES[scope].sourceKind } : null,
    ignoreWhitespace,
  });
  const guide = sidebarView === "guide" ? guideState.guide : null;
  const guideGroups = (guide?.groups ?? [])
    .map((group) => ({ ...group, files: group.files.filter((path) => filesByPath.has(path)) }))
    .filter((group) => group.files.length > 0);
  const guidedPaths = new Set(guideGroups.flatMap((group) => group.files));
  const uncoveredPaths = guide ? sortedPaths.filter((path) => !guidedPaths.has(path)) : [];
  const orderedPaths = guide ? [...guidedPaths, ...uncoveredPaths] : sortedPaths;

  const selectedPath =
    chosenPath !== null && filesByPath.has(chosenPath) ? chosenPath : (orderedPaths[0] ?? null);
  const selectedFile = selectedPath === null ? undefined : filesByPath.get(selectedPath);
  const selectedPosition = selectedPath === null ? -1 : orderedPaths.indexOf(selectedPath);
  const requestPath = (path: string) => {
    if (lazySource) requestFile(sortedPaths.indexOf(path));
  };
  const selectPath = (path: string) => {
    setChosenPath(path);
    requestPath(path);
  };
  const sidebarRef = useRef<HTMLElement>(null);
  const shownDiff =
    selectedFile === undefined || isPendingFile(selectedFile) ? null : expandedCopy(selectedFile);
  const diffStyle = settings.diffLayout === "split" ? "split" : "unified";
  const changeMarks =
    shownDiff === null ? [] : overviewMarks(shownDiff, diffStyle, hydratedDiff === shownDiff);
  const jumpToFraction = (fraction: number) => {
    const scroller = codeRef.current?.querySelector<HTMLElement>(".diff-render-surface");
    scroller?.scrollTo({ top: fraction * scroller.scrollHeight - scroller.clientHeight / 2 });
  };
  const [sidebarMaxWidth, setSidebarMaxWidth] = useState(SIDEBAR_MAX_WIDTH);
  const sidebarWidth = useResizableWidth({
    storageKey: "t3code.reviewSidebarWidth",
    defaultWidth: 288,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: sidebarMaxWidth,
    edge: "left",
  });
  const codeRef = useRef<HTMLDivElement>(null);
  const stepFile = (offset: -1 | 1) => {
    const path = orderedPaths[selectedPosition + offset];
    if (path === undefined) return;
    selectPath(path);
    const row = sidebarRef.current?.querySelector<HTMLElement>(
      `[data-review-path="${CSS.escape(path)}"]`,
    );
    if (sidebarRef.current?.contains(document.activeElement)) row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };
  const toggleMark = (mark: "reviewed" | "flagged") => {
    if (selectedPath === null || selectedFile === undefined || isPendingFile(selectedFile)) return;
    markFile(scopeKey, selectedFile, reviewStates.get(selectedPath) === mark ? null : mark);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const path = event.nativeEvent.composedPath();
    const target = path[0];
    if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
    const key = event.key.toLowerCase();
    if (key === "r" || key === "m") {
      if (event.repeat) return;
      toggleMark(key === "r" ? "reviewed" : "flagged");
    } else if (key === "arrowdown" || key === "arrowup") {
      // The code view scrolls with the arrows, and the tree moves its own selection with them.
      if (codeRef.current && path.includes(codeRef.current)) return;
      if (sidebarView === "tree" && sidebarRef.current && path.includes(sidebarRef.current)) return;
      stepFile(key === "arrowdown" ? 1 : -1);
    } else {
      return;
    }
    event.preventDefault();
  };

  const renderFileRow = (path: string) => {
    const fileDiff = filesByPath.get(path);
    if (!fileDiff) return null;
    return (
      <ReviewFileRow
        path={path}
        changeType={fileDiff.type}
        state={reviewStates.get(path) ?? "unreviewed"}
        selected={path === selectedPath}
        onSelect={() => selectPath(path)}
      />
    );
  };

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="secondary" />}
            aria-label={`Review scope: ${SCOPES[scope].label}`}
            data-workspace-focus-default
          >
            <span className="truncate">{SCOPES[scope].label}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as ReviewScope)}
            >
              {Object.entries(SCOPES).map(([value, { label }]) => (
                <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {reviewStates.size > 0 ? (
          <span
            className="flex items-center gap-1.5 text-2xs text-muted-foreground tabular-nums"
            aria-label={`${reviewedCount} of ${reviewStates.size} files reviewed${
              flaggedCount > 0 ? `, ${flaggedCount} to check later` : ""
            }`}
          >
            <span className="flex items-center gap-0.5">
              <CheckIcon aria-hidden className="size-3" />
              {reviewedCount}/{reviewStates.size}
            </span>
            {flaggedCount > 0 ? (
              <span className="flex items-center gap-0.5 text-warning-foreground">
                <FlagIcon aria-hidden className="size-3" />
                {flaggedCount}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <HeaderButton
          label={preview.isPending || isPending ? "Refreshing changes" : "Refresh changes"}
          onClick={preview.refresh}
          disabled={previewInput === undefined}
        >
          <RefreshIcon size="sm" refreshing={preview.isPending || isPending} />
        </HeaderButton>
        <HeaderButton
          label="Previous file"
          shortcut="↑"
          onClick={() => stepFile(-1)}
          disabled={selectedPosition <= 0}
        >
          <ChevronLeftIcon className="size-3.5" />
        </HeaderButton>
        <HeaderButton
          label="Next file"
          shortcut="↓"
          onClick={() => stepFile(1)}
          disabled={selectedPosition < 0 || selectedPosition >= orderedPaths.length - 1}
        >
          <ChevronRightIcon className="size-3.5" />
        </HeaderButton>
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[settings.diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") updateClientSettings({ diffLayout: next });
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  const body = !fileAccess.canReadFiles ? (
    fileAccess.isPending ? (
      <DiffPanelLoadingState label="Checking file access..." />
    ) : (
      <ReviewMessage>
        {fileAccess.error ?? "This connection cannot read local diffs."}
      </ReviewMessage>
    )
  ) : preview.data === null ? (
    preview.error ? (
      <ReviewMessage>{preview.error}</ReviewMessage>
    ) : (
      <DiffPanelLoadingState label="Loading changes..." />
    )
  ) : sortedPaths.length === 0 ? (
    <ReviewMessage>No changes to review here.</ReviewMessage>
  ) : (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div ref={codeRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedPath === null || selectedFile === undefined ? null : isPendingFile(
            selectedFile,
          ) ? (
          fileStates.get(selectedPath)?.error ? (
            <ReviewMessage>
              <span>Could not load this file.</span>
              <Button size="xs" variant="outline" onClick={() => retry(selectedPath)}>
                Retry
              </Button>
            </ReviewMessage>
          ) : (
            <DiffFileLoadingBoundary
              key={selectedPath}
              load={() => requestPath(selectedPath)}
              count={1}
            />
          )
        ) : (
          <div className="flex min-h-0 flex-1">
            <AnnotatableCodeView
              codeViewKey={`${scopeKey}:${selectedPath}`}
              className="h-full min-h-0 min-w-0 flex-1 overflow-auto"
              files={[
                {
                  fileDiff: shownDiff ?? expandedCopy(selectedFile),
                  filePath: selectedPath,
                  fileKey: buildFileDiffIdentityKey(selectedFile),
                  fileVersion: buildFileDiffContentVersion(selectedFile),
                  collapsed: false,
                },
              ]}
              pendingFiles={[]}
              sectionId={scope}
              sectionTitle={SCOPES[scope].label}
              composerDraftTarget={composerDraftTarget}
              renderHeaderMetadata={(fileDiff) => (
                <ReviewFileControl scopeKey={scopeKey} fileDiff={fileDiff} />
              )}
              renderHeaderFilenameSuffix={() => null}
              renderHeaderPrefix={() => null}
              onRevealSearchMatch={() => undefined}
              options={{
                diffStyle,
                lineDiffType: "none",
                overflow: wordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(theme),
                themeType: theme,
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                stickyHeaders: true,
                expandUnchanged: true,
                loadDiffFiles,
                onPostRender: () => {
                  if (shownDiff !== null && !shownDiff.isPartial) setHydratedDiff(shownDiff);
                },
              }}
            />
            <ChangeOverview marks={changeMarks} onJump={jumpToFraction} />
          </div>
        )}
      </div>
      <aside
        ref={(host) => {
          sidebarRef.current = host;
          const row = host?.parentElement;
          if (!row) return;
          const measure = () =>
            setSidebarMaxWidth(
              Math.max(
                SIDEBAR_MIN_WIDTH,
                Math.min(SIDEBAR_MAX_WIDTH, row.clientWidth - CODE_MIN_WIDTH),
              ),
            );
          measure();
          return observeResize(row, measure);
        }}
        className="relative flex shrink-0 flex-col border-l border-border/60"
        style={
          {
            [RESIZABLE_WIDTH_PROPERTY]: `${sidebarWidth.width}px`,
            width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
          } as CSSProperties
        }
      >
        <RightPanelResizeHandle
          handlers={sidebarWidth.handlers}
          label="Resize changed files"
          tabIndex={0}
          aria-valuenow={sidebarWidth.width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={sidebarMaxWidth}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const step = { ArrowLeft: 16, ArrowRight: -16 }[event.key];
            if (step === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            sidebarWidth.setWidth(sidebarWidth.width + step);
          }}
        />
        <div className="flex shrink-0 items-center px-2 py-1.5">
          <ToggleGroup
            aria-label="Changed files view"
            variant="segmented"
            value={[sidebarView]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "list" || next === "tree" || next === "guide") setSidebarView(next);
            }}
          >
            <Toggle aria-label="List" value="list">
              <ListIcon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Tree" value="tree">
              <FolderTreeIcon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Review guide" value="guide">
              <SparklesIcon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
        </div>
        {sidebarView === "tree" ? (
          <DiffFileTree
            ariaLabel={`${SCOPES[scope].label} files`}
            entries={diffFileTreeEntries(renderableFiles)}
            decorations={
              new Map(
                [...reviewStates].flatMap(([path, state]) =>
                  state === "unreviewed" ? [] : [[path, TREE_DECORATIONS[state]] as const],
                ),
              )
            }
            selectedPath={selectedPath}
            onSelectFile={selectPath}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            {sidebarView === "guide" && cwd ? (
              <ReviewGuideSidebar
                state={guideState}
                diffHash={source?.diffHash ?? null}
                cwd={cwd}
                environmentId={environmentId}
                groups={guideGroups}
                uncoveredPaths={uncoveredPaths}
                renderFile={renderFileRow}
              />
            ) : (
              <ul className="px-1.5 py-1">
                {sortedPaths.map((path) => (
                  <li key={path}>{renderFileRow(path)}</li>
                ))}
              </ul>
            )}
          </ScrollArea>
        )}
      </aside>
    </div>
  );

  return (
    <div className="contents" onKeyDown={handleKeyDown}>
      <DiffPanelShell mode="embedded" header={header}>
        {body}
      </DiffPanelShell>
    </div>
  );
}

function HeaderButton(props: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.label}
        {props.shortcut ? <Kbd className="ml-1.5">{props.shortcut}</Kbd> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function ReviewMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground/70">
      {children}
    </div>
  );
}

const OVERVIEW_MARK_CLASSES = {
  added: "bg-diff-addition-foreground",
  deleted: "bg-diff-deletion-foreground",
  modified: "bg-warning",
} as const satisfies Record<OverviewMark["kind"], string>;

function ChangeOverview({
  marks,
  onJump,
}: {
  marks: ReadonlyArray<OverviewMark>;
  onJump: (fraction: number) => void;
}) {
  if (marks.length === 0) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label="Jump to a change"
      className="relative w-2.5 shrink-0 cursor-pointer border-l border-border/60"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onJump((event.clientY - rect.top) / rect.height);
      }}
    >
      {marks.map((mark) => (
        <span
          key={mark.top}
          aria-hidden
          className={cn(
            "absolute inset-x-0.5 min-h-0.5 rounded-full",
            OVERVIEW_MARK_CLASSES[mark.kind],
          )}
          style={{ top: `${mark.top * 100}%`, height: `${mark.height * 100}%` }}
        />
      ))}
    </button>
  );
}

const REVIEW_STATE_ICONS = {
  reviewed: { icon: CheckIcon, label: "Reviewed" },
  flagged: { icon: FlagIcon, label: "Check later" },
  changed: { icon: RotateCcwIcon, label: "Changed since reviewed" },
} as const;

const CHANGE_TYPE_ICONS = {
  new: { icon: PlusIcon, className: "text-diff-addition-foreground", label: "Added" },
  deleted: { icon: MinusIcon, className: "text-diff-deletion-foreground", label: "Deleted" },
  change: { icon: PencilIcon, className: "text-warning-foreground", label: "Modified" },
  "rename-pure": { icon: ArrowRightIcon, className: "text-info-foreground", label: "Renamed" },
  "rename-changed": { icon: ArrowRightIcon, className: "text-info-foreground", label: "Renamed" },
} as const satisfies Record<FileDiffMetadata["type"], unknown>;

function ReviewFileRow({
  path,
  changeType,
  state,
  selected,
  onSelect,
}: {
  path: string;
  changeType: FileDiffMetadata["type"];
  state: FileReviewState;
  selected: boolean;
  onSelect: () => void;
}) {
  const slash = path.lastIndexOf("/");
  const change = CHANGE_TYPE_ICONS[changeType];
  const stateIcon = selected && state !== "unreviewed" ? REVIEW_STATE_ICONS[state] : null;
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      data-review-path={path}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        selected
          ? "bg-foreground/12 font-medium"
          : state === "flagged"
            ? "bg-warning/18 font-medium hover:bg-warning/24"
            : "hover:bg-foreground/7",
        !selected && state === "reviewed" && "opacity-50 hover:opacity-80",
      )}
      onClick={onSelect}
    >
      <change.icon
        aria-label={change.label}
        className={cn("size-3.5 shrink-0", change.className)}
      />
      <span className="flex min-w-0 flex-1">
        {slash >= 0 ? (
          <StartTruncatedPath path={path.slice(0, slash + 1)} className="text-muted-foreground" />
        ) : null}
        <span className="shrink-0">{path.slice(slash + 1)}</span>
      </span>
      {stateIcon ? (
        <stateIcon.icon aria-label={stateIcon.label} className="size-3.5 shrink-0" />
      ) : null}
    </button>
  );
}
