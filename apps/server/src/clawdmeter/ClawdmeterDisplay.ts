import { EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  projectThreadAwarenessV2,
  type AgentAwarenessPhase,
  type ProjectThreadAwarenessV2Input,
} from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";

/** The Clawdmeter firmware's receive buffer is 512 bytes. */
const MAX_WRITE = 500;
const ROWS = 6;
const NAME_CHARS = 24;
const DONE_MS = 60_000;
const EVENT_FRESH_MS = 60_000;
const BACK_AFTER_MS = 600_000;
const HEARTBEAT_MS = 60_000;
const ENVIRONMENT = EnvironmentId.make("clawdmeter");

export type ClawdmeterThread = ProjectThreadAwarenessV2Input["thread"] &
  Pick<
    OrchestrationV2ThreadShell,
    "activityRunStartedAt" | "createdAt" | "latestRunCompletedAt" | "latestRunStartedAt"
  >;

type RowState = "a" | "w" | "d" | "i";
type Row = [name: string, state: RowState, secs: number];
const ORDER: Record<RowState, number> = { a: 0, w: 1, d: 2, i: 3 };

interface Seen {
  readonly phase: AgentAwarenessPhase | null;
  readonly alert: { readonly key: string; readonly text: string } | null;
}

const millis = (date: DateTime.Utc | null | undefined) =>
  date ? DateTime.toEpochMillis(date) : undefined;

const phaseOf = (thread: ClawdmeterThread) =>
  projectThreadAwarenessV2({ environmentId: ENVIRONMENT, project: { title: "" }, thread })?.phase ??
  null;

const alertOf = (thread: ClawdmeterThread, phase: AgentAwarenessPhase | null) => {
  const request = thread.pendingRuntimeRequest;
  if (phase === "failed") return { key: "failed", text: "Run failed!" };
  if (request === null || (phase !== "waiting_for_input" && phase !== "waiting_for_approval"))
    return null;
  return {
    key: request.id,
    text: request.kind === "user_input" ? "Question for you" : "Permission needed!",
  };
};

const isActive = (phase: AgentAwarenessPhase | null) =>
  phase === "starting" ||
  phase === "running" ||
  phase === "waiting_for_input" ||
  phase === "waiting_for_approval";

// Device fonts are ASCII.
const deviceName = (title: string) => {
  const ascii = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (ascii.length === 0) return "Untitled";
  return ascii.length <= NAME_CHARS ? ascii : `${ascii.slice(0, NAME_CHARS - 3).trimEnd()}...`;
};

/**
 * What the Clawdmeter shows for the thread list, and when it needs a write. Keys follow the
 * firmware's `payload_parse()`: `ss` rows, `a` activity, `e`/`es` turn events, `m`/`x` alerts and
 * `rp` heartbeats.
 */
export class ClawdmeterDisplay {
  private threads: ReadonlyArray<ClawdmeterThread> = [];
  private seen = new Map<string, Seen>();
  private synced = false;
  private seq = 0;
  private latest: "p" | "s" | "b" | null = null;
  private latestAt = 0;
  private alert: { threadId: string; text: string } | null = null;
  private alertUnsent = false;
  private clearUnsent = false;
  private sentSignature: string | null = null;
  private sentSeq = 0;
  private lastWriteAt: number | null = null;
  private pending: { signature: string; nowMs: number } | null = null;

  /** Fold in the current thread list. The first list after a connect raises no events. */
  update(threads: ReadonlyArray<ClawdmeterThread>, nowMs: number): void {
    const next = new Map<string, Seen>();
    for (const thread of threads) {
      const phase = phaseOf(thread);
      next.set(thread.id, { phase, alert: alertOf(thread, phase) });
    }
    if (this.synced) {
      for (const id of new Set([...this.seen.keys(), ...next.keys()])) {
        this.transition(id, this.seen.get(id), next.get(id), nowMs);
      }
    }
    this.threads = threads;
    this.seen = next;
    this.synced = true;
  }

  private transition(id: string, before: Seen | undefined, after: Seen | undefined, nowMs: number) {
    const was = before?.phase ?? null;
    const now = after?.phase ?? null;
    if (!isActive(was) && (now === "starting" || now === "running")) {
      this.bump(this.latestAt > 0 && nowMs - this.latestAt >= BACK_AFTER_MS ? "b" : "p", nowMs);
    }
    if (isActive(was) && (now === "completed" || now === "failed")) this.bump("s", nowMs);
    if (before?.alert?.key === after?.alert?.key) return;
    if (this.alert?.threadId === id) this.endAlert();
    if (after?.alert) {
      this.alert = { threadId: id, text: after.alert.text };
      this.alertUnsent = true;
      this.clearUnsent = false;
    }
  }

  private bump(code: "p" | "s" | "b", nowMs: number) {
    this.latest = code;
    this.latestAt = nowMs;
    this.seq += 1;
  }

  private endAlert() {
    if (this.alert === null) return;
    this.clearUnsent = !this.alertUnsent;
    this.alert = null;
    this.alertUnsent = false;
  }

  /** The device ended the alert itself (a tap or its own timeout). */
  dismissed(): void {
    if (!this.alertUnsent) this.alert = null;
  }

  /** A new connection or the device's refresh request: send everything again. */
  resend(): void {
    this.sentSignature = null;
  }

  private rows(nowMs: number): Row[] {
    const rows = this.threads.flatMap((thread) => {
      const phase = this.seen.get(thread.id)?.phase ?? null;
      const ended = millis(thread.latestRunCompletedAt) ?? millis(thread.updatedAt) ?? nowMs;
      let state: RowState;
      let since: number;
      switch (phase) {
        case "waiting_for_input":
        case "waiting_for_approval":
          state = "a";
          since = millis(thread.pendingRuntimeRequest?.createdAt) ?? ended;
          break;
        case "failed":
          state = "a";
          since = ended;
          break;
        case "starting":
        case "running":
          state = "w";
          since =
            millis(thread.activityRunStartedAt) ??
            millis(thread.latestRunStartedAt) ??
            millis(thread.updatedAt) ??
            nowMs;
          break;
        case "completed":
          state = nowMs - ended < DONE_MS ? "d" : "i";
          since = ended;
          break;
        default:
          return [];
      }
      return [{ thread, state, since }];
    });
    // Waiting threads are kept first, then the most recently updated; tiles keep their order.
    rows.sort(
      (a, b) =>
        Number(a.state !== "a") - Number(b.state !== "a") ||
        (millis(b.thread.updatedAt) ?? 0) - (millis(a.thread.updatedAt) ?? 0),
    );
    return rows
      .slice(0, ROWS)
      .sort(
        (a, b) =>
          ORDER[a.state] - ORDER[b.state] ||
          (millis(a.thread.createdAt) ?? 0) - (millis(b.thread.createdAt) ?? 0) ||
          a.thread.id.localeCompare(b.thread.id),
      )
      .map((row): Row => [
        deviceName(row.thread.title),
        row.state,
        Math.max(0, Math.floor((nowMs - row.since) / 1000)),
      ]);
  }

  /**
   * The JSON for the next write, or null when the device is up to date. A change in seconds alone
   * doesn't write; a heartbeat (`rp`) keeps the device's 90 s freshness window open.
   */
  nextWrite(nowMs: number): string | null {
    if (!this.synced) return null;
    const rows = this.rows(nowMs);
    const signature = JSON.stringify(rows.map(([name, state]) => [name, state]));
    const eventFresh = this.latest !== null && nowMs - this.latestAt < EVENT_FRESH_MS;
    const changed =
      signature !== this.sentSignature ||
      (eventFresh && this.seq !== this.sentSeq) ||
      this.alertUnsent ||
      this.clearUnsent;
    const heartbeat = this.lastWriteAt !== null && nowMs - this.lastWriteAt >= HEARTBEAT_MS;
    if (!changed && !heartbeat) return null;
    const payload = {
      ok: true,
      ...(this.alertUnsent && this.alert ? { m: this.alert.text } : {}),
      ...(this.clearUnsent ? { x: 1 } : {}),
      a: Math.min(rows.filter((row) => row[1] === "w").length, 3),
      // The firmware never fires an event from a replay.
      ...(changed && eventFresh ? { e: this.latest, es: this.seq } : {}),
      ...(changed ? {} : { rp: 1 }),
      ss: rows,
    };
    let json = JSON.stringify(payload);
    while (json.length > MAX_WRITE && payload.ss.length > 0) {
      const drop = payload.ss.findLastIndex((row) => row[1] !== "a");
      payload.ss.splice(drop === -1 ? payload.ss.length - 1 : drop, 1);
      json = JSON.stringify(payload);
    }
    this.pending = { signature, nowMs };
    return json;
  }

  /** The JSON from {@link nextWrite} reached the device. */
  markWritten(): void {
    if (this.pending === null) return;
    this.sentSignature = this.pending.signature;
    this.lastWriteAt = this.pending.nowMs;
    this.sentSeq = this.seq;
    this.alertUnsent = false;
    this.clearUnsent = false;
    this.pending = null;
  }
}
