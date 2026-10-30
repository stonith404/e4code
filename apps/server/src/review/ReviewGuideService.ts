import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Ref from "effect/Ref";

import {
  CheckpointRef,
  ReviewGuide,
  ReviewGuideError,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewSource,
  type ReviewGenerateGuideInput,
  type ReviewGuideInput,
  type ReviewGuideResult,
  type ReviewGuideRun,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  normalizeReviewGuide,
  parseReviewGuideChange,
} from "../pullRequest/pullRequestReviewGuideNormalize.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

export class ReviewGuideService extends Context.Service<
  ReviewGuideService,
  {
    readonly get: (input: ReviewGuideInput) => Effect.Effect<ReviewGuideResult>;
    readonly generate: (
      input: ReviewGenerateGuideInput,
    ) => Effect.Effect<ReviewGuideResult, ReviewDiffPreviewError | ReviewGuideError>;
  }
>()("t3/review/ReviewGuideService") {}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

const describeScope = (kind: ReviewGuideInput["sourceKind"], headRef: string | null): string => {
  switch (kind) {
    case "working-tree":
      return "the uncommitted changes";
    case "branch-range":
      return `the changes on branch ${headRef ?? "HEAD"}, committed or not`;
    case "unpushed":
      return `the commits on ${headRef ?? "HEAD"} that are not pushed yet`;
  }
};

const failureDetail = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (error instanceof Error && "detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  return "The review guide could not be written.";
};

const make = Effect.gen(function* () {
  const review = yield* ReviewService.ReviewService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, ReviewGuide);
  const serviceScope = yield* Effect.scope;
  const runs = yield* Ref.make<ReadonlyMap<string, ReviewGuideRun>>(new Map());

  // Hashed so a long workspace path still fits in one file name.
  const keyFor = (input: ReviewGuideInput) =>
    crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([input.cwd, input.sourceKind, input.baseRef ?? null]),
        ),
      )
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const readStored = (key: string) =>
    store.get(key).pipe(
      Effect.map(Option.getOrNull),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read a stored review guide", { cause }).pipe(Effect.as(null)),
      ),
    );

  const get: ReviewGuideService["Service"]["get"] = Effect.fn("ReviewGuideService.get")(
    function* (input) {
      const key = yield* keyFor(input);
      const [guide, current] = yield* Effect.all([readStored(key), Ref.get(runs)]);
      return { guide, run: current.get(key) ?? null };
    },
  );

  const resolveCommit = (cwd: string, revision: string) =>
    git
      .execute({
        operation: "ReviewGuideService.resolveCommit",
        cwd,
        args: ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  // Uncommitted work is snapshotted into a commit so the model reads a checkout nobody edits under it.
  const checkout = Effect.fn("ReviewGuideService.checkout")(function* (
    cwd: string,
    source: ReviewDiffPreviewSource,
  ) {
    const baseCommit =
      source.kind === "working-tree" || source.baseRef === null
        ? yield* resolveCommit(cwd, "HEAD")
        : yield* git
            .execute({
              operation: "ReviewGuideService.mergeBase",
              cwd,
              args: ["merge-base", "--end-of-options", source.baseRef, "HEAD"],
            })
            .pipe(Effect.map((result) => result.stdout.trim()));
    let head: string;
    if (source.kind === "unpushed") {
      head = yield* resolveCommit(cwd, "HEAD");
    } else {
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const checkpointRef = CheckpointRef.make(`refs/t3/review-guide/${id}`);
      const { checkpoints } = (yield* vcsRegistry.resolve({ cwd })).driver;
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
      yield* Effect.addFinalizer(() =>
        checkpoints
          .deleteCheckpointRefs({ cwd, checkpointRefs: [checkpointRef] })
          .pipe(Effect.ignore({ log: true })),
      );
      head = yield* resolveCommit(cwd, checkpointRef);
    }
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: config.worktreesDir,
      prefix: "review-guide-",
    });
    const path = `${directory}/checkout`;
    yield* git.execute({
      operation: "ReviewGuideService.addWorktree",
      cwd,
      args: ["worktree", "add", "--detach", "--quiet", path, head],
      timeoutMs: 5 * 60_000,
    });
    yield* Effect.addFinalizer(() =>
      git.removeWorktree({ cwd, path, force: true }).pipe(Effect.ignore({ log: true })),
    );
    return { path, baseCommit };
  });

  const readChange = Effect.fn("ReviewGuideService.readChange")(function* (
    cwd: string,
    baseCommit: string,
  ) {
    const diff = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "ReviewGuideService.readChange",
          cwd,
          // Override user diff prefixes so the parser can find headers.
          args: [
            "-c",
            "core.quotePath=false",
            "diff",
            ...PATCH_RENDER_PREFIX_ARGS,
            ...args,
            baseCommit,
            "HEAD",
          ],
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024 * 1024,
        })
        .pipe(Effect.map((result) => result.stdout));
    const [nameOnly, patch] = yield* Effect.all(
      [
        diff(["--name-only", "-z"]),
        diff(["--unified=0", "--no-color", "--no-ext-diff", "--no-textconv"]),
      ],
      { concurrency: "unbounded" },
    );
    return parseReviewGuideChange(nameOnly, patch);
  });

  const write = Effect.fn("ReviewGuideService.write")(function* (
    input: ReviewGenerateGuideInput,
    key: string,
    source: ReviewDiffPreviewSource,
  ) {
    const [settings, providers] = yield* Effect.all(
      [serverSettings.getSettings, providerRegistry.getProviders],
      { concurrency: "unbounded" },
    );
    const projectSettings = resolveProjectSettings(settings, input.projectId).settings;
    const modelSelection = ServerSettings.resolveReviewGuideModelSelection(
      projectSettings,
      providers,
      input.projectId,
    );
    const { generated, change } = yield* checkout(input.cwd, source).pipe(
      Effect.flatMap(({ path, baseCommit }) =>
        Effect.all(
          {
            generated: textGeneration.generateReviewGuide({
              cwd: path,
              baseCommit,
              local: {
                scope: describeScope(input.sourceKind, source.headRef),
                base: source.kind === "working-tree" ? "HEAD" : (source.baseRef ?? "HEAD"),
              },
              instructions: projectSettings.reviewGuideInstructions,
              modelSelection,
            }),
            change: readChange(path, baseCommit),
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
    );
    const { summary, stops } = normalizeReviewGuide(generated, change);
    yield* store.set(key, {
      summary: summary?.trim() ?? "",
      groups: stops.flatMap((stop) =>
        stop.files.length === 0
          ? []
          : [{ title: stop.title, files: stop.files.map((file) => file.path) }],
      ),
      diffHash: source.diffHash,
      generatedAt: yield* nowIso,
      modelSelection,
    });
  });

  const generate: ReviewGuideService["Service"]["generate"] = Effect.fn(
    "ReviewGuideService.generate",
  )(function* (input) {
    // Also confirms the cwd is a known workspace before anything runs in it.
    const preview = yield* review.getDiffPreview({
      cwd: input.cwd,
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      ...(input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace }),
      ...(input.sourceKind === "unpushed" ? { unpushed: true } : {}),
    });
    const source = preview.sources.find((candidate) => candidate.kind === input.sourceKind);
    if (source === undefined || source.diff.trim() === "") {
      return yield* new ReviewGuideError({ detail: "There are no changes to guide you through." });
    }
    const key = yield* keyFor(input);
    const running: ReviewGuideRun = { _tag: "Running", startedAt: yield* nowIso };
    const claimed = yield* Ref.modify(runs, (current) => {
      const existing = current.get(key);
      if (existing?._tag === "Running") return [existing, current] as const;
      return [running, new Map(current).set(key, running)] as const;
    });
    const guide = yield* readStored(key);
    if (claimed !== running) return { guide, run: claimed };

    const finish = (next: ReviewGuideRun | null) =>
      Ref.update(runs, (current) => {
        if (current.get(key) !== running) return current;
        const updated = new Map(current);
        if (next === null) updated.delete(key);
        else updated.set(key, next);
        return updated;
      });
    yield* write(input, key, source).pipe(
      Effect.andThen(finish(null)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? finish(null)
          : Effect.logWarning("Review guide generation failed", {
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((failedAt) =>
                finish({ _tag: "Failed", failedAt, detail: failureDetail(cause) }),
              ),
            ),
      ),
      Effect.forkIn(serviceScope),
    );
    return { guide, run: running };
  });

  return ReviewGuideService.of({ get, generate });
});

const layerStore = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return KeyValueStore.layerFileSystem(path.join(config.stateDir, "review-guides")).pipe(
      Layer.catch(() =>
        Layer.effectDiscard(
          Effect.logWarning("Review guide directory unavailable; keeping guides in memory"),
        ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
      ),
    );
  }),
);

export const layer = Layer.effect(ReviewGuideService, make).pipe(Layer.provide(layerStore));
