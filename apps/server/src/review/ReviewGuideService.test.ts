import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";
import {
  ProjectId,
  type ReviewDiffPreviewSource,
  type ReviewGenerateGuideInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ReviewGuideService from "./ReviewGuideService.ts";
import * as ReviewService from "./ReviewService.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

// main has base.txt; feature commits committed.txt, edits base.txt and adds untracked.txt without committing.
const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-review-guide-" });
  const workspace = `${root}/workspace`;
  yield* fs.makeDirectory(workspace);
  yield* git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(workspace, ["config", "user.email", "test@example.com"]);
  yield* git(workspace, ["config", "user.name", "Test"]);
  yield* fs.writeFileString(`${workspace}/base.txt`, "base\n");
  yield* git(workspace, ["add", "base.txt"]);
  yield* git(workspace, ["commit", "--quiet", "-m", "base"]);
  yield* git(workspace, ["checkout", "--quiet", "-b", "feature"]);
  yield* fs.writeFileString(`${workspace}/committed.txt`, "committed\n");
  yield* git(workspace, ["add", "committed.txt"]);
  yield* git(workspace, ["commit", "--quiet", "-m", "feature"]);
  yield* fs.writeFileString(`${workspace}/base.txt`, "base\nedited\n");
  yield* fs.writeFileString(`${workspace}/untracked.txt`, "untracked\n");
  return { root, workspace };
});

const source: ReviewDiffPreviewSource = {
  id: "branch-range",
  kind: "branch-range",
  title: "Changes vs main",
  baseRef: "main",
  headRef: "feature",
  diff: "diff --git a/base.txt b/base.txt\n",
  diffHash: "hash-1",
  truncated: false,
};

const makeLayer = (input: {
  readonly root: string;
  readonly generate: TextGeneration.TextGeneration["Service"]["generateReviewGuide"];
}) =>
  ReviewGuideService.layer.pipe(
    Layer.provide(
      Layer.mock(ReviewService.ReviewService)({
        getDiffPreview: (request) =>
          Effect.succeed({
            cwd: request.cwd,
            generatedAt: DateTime.makeUnsafe(0),
            sources: [source],
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({ generateReviewGuide: input.generate }),
    ),
    Layer.provide(VcsDriverRegistry.layer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(input.root, { prefix: "t3-local-review-guide-config-" })),
  );

const layerBase = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-review-guide-git-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

// A run forks into the service's scope, so a test learns it settled when its `write` span ends.
const watchRuns = Effect.gen(function* () {
  const ended = yield* Queue.unbounded<void>();
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      if (options.name !== "ReviewGuideService.write") return span;
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        Queue.offerUnsafe(ended, undefined);
      };
      return span;
    },
  });
  return {
    generate: (
      service: ReviewGuideService.ReviewGuideService["Service"],
      input: ReviewGenerateGuideInput,
    ) => service.generate(input).pipe(Effect.withTracer(tracer)),
    settled: Queue.take(ended),
  };
});

it.layer(layerBase, { excludeTestServices: true })("ReviewGuideService", (it) => {
  it.effect("guides a snapshot of uncommitted work without touching the workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, workspace } = yield* makeRepository;
        // The local guide measures real blobs, like the upstream PR guide, not textconv output.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${workspace}/.git/info/attributes`, "*.txt diff=review-guide\n");
        yield* git(workspace, ["config", "diff.review-guide.textconv", "false"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const changed = yield* Deferred.make<string>();
        const context = yield* Layer.build(
          makeLayer({
            root,
            generate: (generation) =>
              git(generation.cwd, ["diff", "--name-only", generation.baseCommit, "HEAD"]).pipe(
                Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
                Effect.orDie,
                Effect.flatMap((names) => Deferred.succeed(changed, names)),
                Effect.as({
                  summary: " Adds the feature. ",
                  stops: [
                    {
                      title: "The feature",
                      summary: "",
                      attention: null,
                      excerpts: [],
                      files: [{ path: "committed.txt" }, { path: "gone.txt" }],
                      notes: [],
                      questions: [],
                    },
                  ],
                }),
              ),
          }),
        );
        const service = Context.get(context, ReviewGuideService.ReviewGuideService);
        const runs = yield* watchRuns;
        const input = {
          cwd: workspace,
          sourceKind: "branch-range",
          projectId: ProjectId.make("project-1"),
        } as const;

        const started = yield* runs.generate(service, input);
        assert.strictEqual(started.run?._tag, "Running");
        yield* runs.settled;

        assert.deepStrictEqual((yield* Deferred.await(changed)).split("\n"), [
          "base.txt",
          "committed.txt",
          "untracked.txt",
        ]);
        const result = yield* service.get(input);
        assert.isNull(result.run);
        assert.strictEqual(result.guide?.summary, "Adds the feature.");
        assert.strictEqual(result.guide?.diffHash, "hash-1");
        assert.deepStrictEqual(result.guide?.groups, [
          { title: "The feature", files: ["committed.txt"] },
          { title: "Other files", files: ["base.txt", "untracked.txt"] },
        ]);
        assert.strictEqual(
          yield* git(workspace, ["status", "--porcelain"]),
          "M base.txt\n?? untracked.txt",
        );
        assert.strictEqual(yield* git(workspace, ["for-each-ref", "refs/t3/review-guide"]), "");
        assert.lengthOf(
          (yield* git(workspace, ["worktree", "list", "--porcelain"])).match(/^worktree /gm) ?? [],
          1,
        );
      }),
    ),
  );

  it.effect("shares one run between writes started while it runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, workspace } = yield* makeRepository;
        const release = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const context = yield* Layer.build(
          makeLayer({
            root,
            generate: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ summary: "", stops: [] }),
              ),
          }),
        );
        const service = Context.get(context, ReviewGuideService.ReviewGuideService);
        const runs = yield* watchRuns;
        const input = {
          cwd: workspace,
          sourceKind: "branch-range",
          projectId: ProjectId.make("project-1"),
        } as const;

        const first = yield* runs.generate(service, input);
        const second = yield* runs.generate(service, input);
        assert.deepStrictEqual(second.run, first.run);
        yield* Deferred.succeed(release, undefined);
        yield* runs.settled;

        assert.strictEqual(yield* Ref.get(calls), 1);
        assert.isNotNull((yield* service.get(input)).guide);
      }),
    ),
  );
});
