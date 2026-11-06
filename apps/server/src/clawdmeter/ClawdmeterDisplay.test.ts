import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { ClawdmeterDisplay, type ClawdmeterThread } from "./ClawdmeterDisplay.ts";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(T0 + ms);

const thread = (id: string, overrides: Partial<ClawdmeterThread> = {}): ClawdmeterThread => ({
  id: id as ThreadId,
  lineage: { rootThreadId: id as ThreadId, parentThreadId: null, relationshipToParent: null },
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  status: "idle",
  pendingRuntimeRequest: null,
  settledOverride: null,
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

const ask = (id: string, kind: "user_input" | "command") => ({
  pendingRuntimeRequest: { id: RuntimeRequestId.make(id), kind, createdAt: at(2_000) },
});

const write = (display: ClawdmeterDisplay, nowMs: number) => {
  const json = display.nextWrite(T0 + nowMs);
  display.markWritten();
  return json === null ? null : JSON.parse(json);
};

describe("ClawdmeterDisplay", () => {
  it("writes on state changes, not on seconds, and heartbeats once a minute", () => {
    const display = new ClawdmeterDisplay();
    expect(write(display, 0)).toBeNull();
    display.update([thread("fix", { status: "running", activityRunStartedAt: at(-5_000) })], T0);
    expect(write(display, 0)).toEqual({ ok: true, a: 1, ss: [["fix", "w", 5]] });
    expect(write(display, 30_000)).toBeNull();
    expect(write(display, 60_000)).toEqual({ ok: true, a: 1, rp: 1, ss: [["fix", "w", 65]] });
  });

  it("raises turn events and alerts, and clears an answered alert", () => {
    const display = new ClawdmeterDisplay();
    display.update([], T0);
    write(display, 0);
    display.update([thread("t", { status: "running" })], T0 + 1_000);
    expect(write(display, 1_000)).toMatchObject({ e: "p", es: 1 });

    display.update([thread("t", ask("r1", "user_input"))], T0 + 2_000);
    expect(write(display, 2_000)).toMatchObject({ m: "Question for you", ss: [["t", "a", 0]] });
    display.update([thread("t", ask("r1", "user_input"))], T0 + 2_500);
    expect(write(display, 2_500)).toBeNull();

    display.update([thread("t", { status: "running" })], T0 + 3_000);
    expect(write(display, 3_000)).toMatchObject({ x: 1 });

    const failed = { status: "failed" as const, latestRunCompletedAt: at(4_000) };
    display.update([thread("t", failed)], T0 + 4_000);
    expect(write(display, 4_000)).toMatchObject({ m: "Run failed!", e: "s", es: 2 });
    display.update([thread("t", { ...failed, settledOverride: "settled" })], T0 + 5_000);
    expect(write(display, 5_000)).toMatchObject({ x: 1, ss: [] });
  });

  it("lets the device dismiss an alert without sending a clear", () => {
    const display = new ClawdmeterDisplay();
    display.update([], T0);
    display.update([thread("t", ask("r1", "command"))], T0);
    expect(write(display, 0)).toMatchObject({ m: "Permission needed!" });
    display.dismissed();
    display.update([thread("t", { status: "running" })], T0 + 1_000);
    expect(write(display, 1_000)).not.toHaveProperty("x");
  });

  it("orders tiles, keeps waiting threads and turns done into idle", () => {
    const display = new ClawdmeterDisplay();
    const working = Array.from({ length: 6 }, (_, i) =>
      thread(`w${i}`, {
        status: "running",
        activityRunStartedAt: at(10_000),
        createdAt: at(-i * 1_000),
        updatedAt: at(i * 1_000),
      }),
    );
    const done = thread("done", { status: "completed", latestRunCompletedAt: at(100_000) });
    const waiting = thread("waiting", { ...ask("r", "user_input"), title: "Fixe den Übergang" });
    display.update([...working, done, waiting], T0);
    const rows = write(display, 159_000).ss;
    expect(rows.map((row: unknown[]) => row.slice(0, 2))).toEqual([
      ["Fixe den Ubergang", "a"],
      ["w5", "w"],
      ["w4", "w"],
      ["w3", "w"],
      ["w2", "w"],
      ["w1", "w"],
    ]);

    const alone = new ClawdmeterDisplay();
    alone.update([done], T0);
    expect(write(alone, 159_000).ss).toEqual([["done", "d", 59]]);
    expect(write(alone, 160_000).ss).toEqual([["done", "i", 60]]);
  });
});
