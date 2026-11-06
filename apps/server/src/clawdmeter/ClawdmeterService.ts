import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClawdmeterDisplay } from "./ClawdmeterDisplay.ts";
import { connectClawdmeter } from "./ClawdmeterLink.ts";

class ClawdmeterError extends Schema.TaggedError<ClawdmeterError>()("ClawdmeterError", {
  cause: Schema.Defect(),
}) {}

const TICK = Duration.millis(500);
const RETRY = Duration.seconds(10);
const CONNECT_TIMEOUT = Duration.seconds(30);

/**
 * Shows the thread list on a Clawdmeter, a desk display paired with this computer over Bluetooth,
 * while `clawdmeterEnabled` is on.
 */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const session = Effect.fn("ClawdmeterService.session")(function* () {
    const display = new ClawdmeterDisplay();
    const state = { connected: true };
    const link = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          connectClawdmeter(
            {
              onRefresh: () => display.resend(),
              onDismiss: () => display.dismissed(),
              onDisconnect: () => {
                state.connected = false;
              },
            },
            signal,
          ),
        catch: (cause) => new ClawdmeterError({ cause }),
      }).pipe(Effect.timeout(CONNECT_TIMEOUT)),
      (link) => Effect.promise(() => link.close().catch(() => undefined)),
    );
    yield* Effect.logInfo("Clawdmeter connected");

    const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
    const show = Effect.gen(function* () {
      display.update([...shells.values()], yield* Clock.currentTimeMillis);
    });
    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.filter(threads.streamDomainEvents, shouldPublishAgentAwarenessEvent),
        (event) =>
          threads.getThreadShell(event.threadId).pipe(
            Effect.flatMap((thread) => {
              if (thread === null || thread.archivedAt !== null) shells.delete(event.threadId);
              else shells.set(thread.id, thread);
              return show;
            }),
          ),
      ),
    );
    for (const thread of (yield* threads.getShellSnapshot({ location: "active" })).threads) {
      shells.set(thread.id, thread);
    }
    yield* show;

    while (state.connected) {
      const json = display.nextWrite(yield* Clock.currentTimeMillis);
      if (json !== null) {
        yield* Effect.tryPromise({
          try: () => link.write(json),
          catch: (cause) => new ClawdmeterError({ cause }),
        });
        display.markWritten();
      }
      yield* Effect.sleep(TICK);
    }
    yield* Effect.logInfo("Clawdmeter disconnected");
  });

  const follow = session().pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.logDebug("Clawdmeter unavailable", { cause: error })),
    Effect.repeat(Schedule.spaced(RETRY)),
  );

  const start = Effect.fn("ClawdmeterService.start")(function* () {
    const changes = yield* settings.subscribeChanges;
    const current = yield* settings.getSettings;
    yield* forkParked(
      Stream.concat(Stream.succeed(current), changes).pipe(
        Stream.map((s) => s.clawdmeterEnabled),
        Stream.changes,
        Stream.switchMap((enabled) => (enabled ? Stream.fromEffect(follow) : Stream.empty)),
        Stream.runDrain,
      ),
    );
  });
  return { start };
});
