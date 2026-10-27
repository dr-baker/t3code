import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { modelCapacityRecoveryDeadline } from "./ModelCapacityRecovery.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const recover = Effect.fn("ModelCapacityRecoveryWorker.recover")(
    function* (threadId: ThreadId, runId: RunId) {
      yield* Effect.annotateCurrentSpan({ threadId, runId });
      let delayMs = 15_000;
      let announced = false;
      while (true) {
        const projection = yield* projections.getThreadRecords(
          threadId,
          ["runs", "turnItems", "providerThreads", "runtimeRequests"],
          { turnItemTypes: ["error", "run_interrupt_request"], turnItemRunIds: [runId] },
        );
        const deadline = modelCapacityRecoveryDeadline(projection, runId);
        if (
          deadline === null ||
          projection.turnItems.some((item) => item.type === "run_interrupt_request")
        )
          return;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (nowMs >= deadline) {
          const identity = `model-capacity:${threadId}:${runId}`;
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(identity),
            messageId: MessageId.make(identity),
            threadId,
            capacityContinuationOfRunId: runId,
            text: "continue",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
          });
          yield* Effect.logInfo("Model capacity recovery dispatched", { threadId, runId });
          return;
        }
        if (!announced) {
          yield* Effect.logInfo("Model capacity recovery waiting", { threadId, runId, deadline });
          announced = true;
        }
        // A terminal failure means Codex has finished its own retries; this is the extra backoff.
        yield* Effect.sleep(Duration.millis(Math.min(delayMs, deadline - nowMs)));
        delayMs = Math.min(delayMs * 2, 240_000);
      }
    },
    (effect, threadId, runId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Model capacity recovery skipped", { threadId, runId, cause }),
        ),
      ),
  );

  const start = Effect.fn("ModelCapacityRecoveryWorker.start")(function* () {
    const timers = yield* FiberMap.make<RunId>();
    const afterSequence = yield* events.latestSequence();
    const schedule = (threadId: ThreadId, runId: RunId) =>
      FiberMap.run(timers, runId, recover(threadId, runId), { onlyIfMissing: true });
    yield* forkParked(
      Stream.runForEach(
        orchestrator.streamStoredEventsFrom({ afterSequence, eventType: "run.updated" }),
        ({ event }) =>
          event.type === "run.updated" && event.payload.status === "failed"
            ? schedule(event.threadId, event.payload.id)
            : Effect.void,
      ),
    );
    yield* forkParked(
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        for (const threadId of yield* projections.getRecoveryThreadIds("model-capacity")) {
          const projection = yield* projections.getThreadRecords(
            threadId,
            ["runs", "turnItems", "providerThreads", "runtimeRequests"],
            { turnItemTypes: ["error", "run_interrupt_request"] },
          );
          const run = latestExecutedRun(projection.runs);
          if (run === null) continue;
          const deadline = modelCapacityRecoveryDeadline(projection, run.id);
          // Restore a pending wait after restart without reviving historical failures.
          if (deadline !== null && deadline >= nowMs) yield* schedule(threadId, run.id);
        }
      }),
    );
  });
  return { recover, start };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* make;
    yield* worker.start();
  }),
);
