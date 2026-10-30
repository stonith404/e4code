import * as Schema from "effect/Schema";

import { reviewGuidePreferences } from "./textGenerationPrompts.ts";

export interface LocalReviewGuidePromptInput {
  /** What is reviewed, like "the uncommitted changes". */
  scope: string;
  /** The ref the changes are measured against, like "HEAD" or "origin/main". */
  base: string;
  baseCommit: string;
  instructions?: string | undefined;
}

export function buildLocalReviewGuidePrompt(input: LocalReviewGuidePromptInput) {
  const base = input.baseCommit;
  const diff = `git diff ${base} HEAD`;
  const prompt = [
    `You summarize ${input.scope} and put the changed files in a good order for reading them.`,
    `The changes are checked out in the current directory. They are measured against \`${input.base}\` at commit ${base}; only ${diff} belongs to them. A last commit named "t3 checkpoint" is a snapshot of work that was not committed yet, not a real commit.`,
    "",
    "Investigate before you answer, read-only. Change nothing. Start from:",
    `- git diff --stat ${base} HEAD`,
    `- git log --oneline ${base}..HEAD`,
    `Then read what you need with ${diff} -- <path> and the surrounding code. Skim tests, fixtures, generated files and lockfiles.`,
    "",
    "Return a JSON object with two keys, summary and groups.",
    "- summary: Markdown that explains the change to someone about to read it: what it does as a whole and how the parts fit together. Describe; never tell the reader what to check or review. Start with one to three plain sentences, then at most a few short bullets if they help. No headings. Stay under 150 words, not counting a diagram.",
    "- A diagram belongs in the summary only when the change has a flow, structure or relationship across files that a picture shows more clearly than words, such as a new data flow between modules or a state machine. Most changes need none; never add one for its own sake. When you add one, write a single fenced ```mermaid block with a small flowchart or sequence diagram that names the real modules or functions.",
    "- groups: the changed files in the order to read them, as [{title, files}]. Put related files together: contracts and data shapes first, then the code that implements them, then callers and UI. A test goes in the group of the code it tests. Mechanical changes (renames repeated across files, snapshots, fixtures, lockfiles, generated files, docs) go last. One group for a small change, usually 2 to 6.",
    '- title: a few words naming what the group changes, like "Discount model" or "Settings UI". Not an instruction and not a file name.',
    "- files: paths exactly as git diff --name-only prints them. Every changed file appears in exactly one group.",
    ...reviewGuidePreferences(input.instructions),
  ].join("\n");

  const outputSchema = Schema.Struct({
    summary: Schema.String,
    groups: Schema.Array(
      Schema.Struct({ title: Schema.String, files: Schema.Array(Schema.String) }),
    ),
  });

  return { prompt, outputSchema };
}
