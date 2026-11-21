import {
  CommandId,
  EventId,
  MessageId,
  NonNegativeInt,
  THREAD_WATCH_LIMITS,
  THREAD_WATCH_OVERSIGHT_DEFAULTS,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  type ThreadWatch,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { turnItemCanChangeUserWait } from "@t3tools/shared/agentAwareness";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  formatOversightOutlineDelta,
  isOversightCommentaryItem,
  isOversightCountedStep,
  isTurnItemSettled,
} from "./threadOutline.ts";
import {
  threadWatchChange,
  threadWatchHasPendingWork,
  threadWatchWakePath,
} from "./threadWatch.ts";

const encodeTitle = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const WATCH_EVENT_TYPES = [
  "run.updated",
  "thread.settled",
  "thread.archived",
  "thread.deleted",
] as const satisfies ReadonlyArray<OrchestrationV2DomainEvent["type"]>;

export class ThreadWatchReactor extends Context.Service<
  ThreadWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWatchReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* OrchestrationEventStore.OrchestrationEventStore;
  const lock = yield* Semaphore.make(1);
  let watchedIds = new Set<ThreadId>();
  let oversightWatchedIds = new Set<ThreadId>();

  const readWatch = Effect.fn("ThreadWatchReactor.readWatch")(function* (
    ownerId: ThreadId,
    watch: ThreadWatch,
  ) {
    const progress = watch.progress ?? { cursor: 0, reported: [], baselinePending: true };
    const through = yield* store.latestAgentSequence(watch.threadId);
    const target = yield* projections.getThreadShell(watch.threadId);
    const workPending = threadWatchHasPendingWork(target);
    if (
      !progress.baselinePending &&
      through <= progress.cursor &&
      (watch.oversight === undefined || !workPending)
    )
      return;
    const batches = yield* Effect.forEach(WATCH_EVENT_TYPES, (eventType) =>
      store
        .readAgentEvents({
          threadId: watch.threadId,
          afterSequence: progress.cursor,
          throughSequence: through,
          eventType,
        })
        .pipe(Stream.runCollect),
    );
    const stored = batches.flat().sort((a, b) => a.sequence - b.sequence);
    const reported = new Set(progress.reported);
    const changes: Array<NonNullable<ReturnType<typeof threadWatchChange>>> = [];
    let causalThreadIds = [watch.threadId, ownerId];
    let ended = false;
    const isOwnedDelegateOversight = watch.oversight?.ownedDelegate === true;

    const record = Effect.fn("ThreadWatchReactor.recordChange")(function* (
      event: OrchestrationV2DomainEvent,
    ) {
      const change = threadWatchChange(event);
      if (change === null || ended) return;
      const identity = `${event.type}:${"id" in event.payload ? event.payload.id : event.threadId}:${change.text}`;
      if (reported.has(identity)) return;
      if (event.type === "run.updated") {
        if (
          (change.outcome === "completed" && workPending) ||
          (watch.until === "turn" && event.payload.id !== target?.latestRunId) ||
          (yield* engine.restartContinuationPending(event.payload))
        )
          return;
        const message = yield* projections.getRunMessage(event.threadId, event.payload.id);
        const path = threadWatchWakePath(watch.threadId, ownerId, message?.notification?.source);
        if (path === null) return;
        causalThreadIds = path;
        ended = watch.until === "turn";
      }
      reported.add(identity);
      changes.push(change);
      ended ||= change.ended;
    });

    if (
      target === null ||
      target.deletedAt !== null ||
      target.archivedAt !== null ||
      target.settledAt !== null ||
      target.settledOverride === "settled"
    ) {
      ended = true;
      changes.push({ text: "is no longer active", outcome: "completed", ended: true });
    }
    for (const item of stored) yield* record(item.event);
    if (!ended && target !== null) {
      if (target.latestRunId !== null && target.status !== "idle") {
        const run = yield* projections.getRun(watch.threadId, target.latestRunId);
        if (run !== undefined) {
          yield* record({
            type: "run.updated",
            id: EventId.make(`thread-watch-baseline:${watch.id}`),
            threadId: watch.threadId,
            providerInstanceId: target.providerInstanceId,
            runId: run.id,
            occurredAt: run.completedAt ?? run.requestedAt,
            payload: run,
          });
        }
      }
      const request = target?.pendingRuntimeRequest;
      if (
        !ended &&
        !isOwnedDelegateOversight &&
        request != null &&
        !reported.has(`request:${request.id}`)
      ) {
        const change = request.userOnly
          ? { text: "needs the user", outcome: "updated" as const, ended: false }
          : threadWatchChange({
              type: "runtime-request.updated",
              payload: { kind: request.kind, status: "pending" },
            });
        if (change !== null) {
          const runId = target.activeRunId ?? target.latestRunId;
          const message =
            runId === null ? undefined : yield* projections.getRunMessage(watch.threadId, runId);
          const path = threadWatchWakePath(watch.threadId, ownerId, message?.notification?.source);
          if (path !== null) {
            causalThreadIds = path;
            reported.add(`request:${request.id}`);
            changes.push(change);
          }
        }
      }
    }
    if (isOwnedDelegateOversight) {
      // Owned delegates already deliver completion and question wakes through delegate_task.
      changes.length = 0;
    }

    let nextLastOutlinePosition = progress.lastOutlinePosition;
    let nextLastCheckInAtMs = progress.lastCheckInAtMs;
    let oversightWake:
      | {
          readonly reason: string;
          readonly outline: string;
          readonly wakeStamp: string;
        }
      | undefined;

    if (
      !ended &&
      watch.oversight !== undefined &&
      target !== null &&
      workPending &&
      changes.length === 0
    ) {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const lastCheckInAtMs = progress.lastCheckInAtMs ?? nowMs;
      const page = yield* projections.getTimelinePage(watch.threadId, {
        afterPosition: progress.lastOutlinePosition ?? -1,
        limit: Math.max(
          watch.oversight.everyItems + THREAD_WATCH_OVERSIGHT_DEFAULTS.inlineOutlineMaxItems,
          50,
        ),
        view: "activity",
      });
      const settledRows = page.items.filter((row) => isTurnItemSettled(row.item));
      const commentaryDue = settledRows.some((row) =>
        isOversightCommentaryItem(row.item, target.activeRunId !== null),
      );
      const countedSteps = settledRows.filter((row) => isOversightCountedStep(row.item)).length;
      const itemsDue = countedSteps >= watch.oversight.everyItems;
      const elapsedMs = nowMs - lastCheckInAtMs;
      const timeDue = elapsedMs >= watch.oversight.everySeconds * 1000;
      if (commentaryDue || itemsDue || timeDue) {
        const runId = target.activeRunId ?? target.latestRunId;
        const message =
          runId === null ? undefined : yield* projections.getRunMessage(watch.threadId, runId);
        const path = threadWatchWakePath(watch.threadId, ownerId, message?.notification?.source);
        if (path !== null) {
          causalThreadIds = path;
          const latestSettled = settledRows.at(-1);
          if (latestSettled !== undefined) {
            nextLastOutlinePosition = NonNegativeInt.make(latestSettled.position);
          }
          nextLastCheckInAtMs = NonNegativeInt.make(nowMs);
          const reason = commentaryDue
            ? "commentary update"
            : itemsDue
              ? `${countedSteps} new steps`
              : `${Math.max(1, Math.round(elapsedMs / 60_000))}m elapsed`;
          const deltaText = formatOversightOutlineDelta(settledRows);
          oversightWake = {
            reason,
            outline:
              deltaText.length > 0
                ? deltaText
                : "(still working; no new settled steps since last check-in)",
            wakeStamp: `${nextLastOutlinePosition ?? -1}:${nowMs}`,
          };
        }
      }
    }

    const next = {
      ...watch,
      title: target?.title || watch.title,
      workPending,
      progress: {
        cursor: Math.max(progress.cursor, through),
        reported: [...reported].slice(-THREAD_WATCH_LIMITS.reportedChanges),
        baselinePending: false,
        ...(nextLastOutlinePosition === undefined
          ? {}
          : { lastOutlinePosition: nextLastOutlinePosition }),
        ...(nextLastCheckInAtMs === undefined ? {} : { lastCheckInAtMs: nextLastCheckInAtMs }),
      },
      ended,
    };
    // Progress-only updates would make reciprocal watches echo metadata forever.
    if (
      !progress.baselinePending &&
      changes.length === 0 &&
      oversightWake === undefined &&
      watch.title === next.title &&
      watch.workPending === next.workPending &&
      watch.ended === next.ended
    )
      return;
    const key =
      oversightWake !== undefined
        ? `${watch.id}:oversight:${oversightWake.wakeStamp}`
        : `${watch.id}:${next.progress.cursor}:${progress.baselinePending ? "baseline" : "events"}`;
    const last = changes.at(-1);
    const quotedTitle = yield* encodeTitle(next.title);
    const wake =
      oversightWake !== undefined
        ? {
            messageId: MessageId.make(`message:thread-watch:${key}`),
            causalThreadIds,
            oversightCheckIn: true,
            text: [
              `Oversight check-in on ${quotedTitle} (${watch.threadId}) (${oversightWake.reason}):`,
              oversightWake.outline,
              "",
              `If progress looks healthy, reply \`${THREAD_WATCH_OVERSIGHT_DEFAULTS.quietAckToken}\` (with an optional 1-line note) and end your turn.`,
              `If something looks off or uncertain, question it first via \`t3_thread_send\` (\`mode:"steer"\`) asking for a brief commentary reply before overruling. Inspect raw details with \`t3_thread_read\` (\`view:"activity"\`, \`itemId\`).`,
            ].join("\n"),
            notification: {
              source: { kind: "monitor" as const },
              outcome: "updated" as const,
              summary: `${next.title} (${oversightWake.reason})`,
            },
          }
        : last === undefined
          ? undefined
          : {
              messageId: MessageId.make(`message:thread-watch:${key}`),
              causalThreadIds,
              text: `Watched thread ${quotedTitle} (${watch.threadId}):\n${[...new Set(changes.map((change) => change.text))].map((text) => `- ${text}`).join("\n")}\nRead its current state with t3_thread_read before acting.${ended ? " This watch has ended." : " The watch remains active."}`,
              notification: {
                source: { kind: "monitor" as const },
                outcome: last.outcome,
                summary: `${next.title} ${last.text}`,
              },
            };
    yield* engine.dispatch({
      type: "thread.watch.sync",
      threadId: ownerId,
      commandId: CommandId.make(`server:thread-watch:${key}`),
      expectedCursor: progress.cursor,
      watch: next,
      ...(wake === undefined ? {} : { wake }),
    });
  });

  const sweep = Effect.fn("ThreadWatchReactor.sweep")(
    function* () {
      const owners = yield* projections.getThreadsWithWatches();
      watchedIds = new Set(
        owners.flatMap((owner) =>
          (owner.threadWatches ?? [])
            .filter((watch) => !watch.ended)
            .map((watch) => watch.threadId),
        ),
      );
      oversightWatchedIds = new Set(
        owners.flatMap((owner) =>
          (owner.threadWatches ?? [])
            .filter((watch) => !watch.ended && watch.oversight !== undefined)
            .map((watch) => watch.threadId),
        ),
      );
      for (const owner of owners) {
        for (const watch of owner.threadWatches ?? []) {
          if (!watch.ended)
            yield* readWatch(owner.id, watch).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Thread watch reconciliation failed", {
                  ownerId: owner.id,
                  targetId: watch.threadId,
                  cause,
                }),
              ),
            );
        }
      }
    },
    lock.withPermit,
    Effect.catchCause((cause) => Effect.logWarning("Thread watch sweep failed", { cause })),
  );

  const start = Effect.fn("ThreadWatchReactor.start")(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        const afterSequence = yield* store.latestApplicationSequence;
        yield* engine.streamStoredEventsFrom({ afterSequence }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.watches-updated" ||
              (oversightWatchedIds.has(event.threadId) && event.type === "turn-item.updated") ||
              (watchedIds.has(event.threadId) &&
                (threadWatchChange(event) !== null ||
                  event.type === "runtime-request.updated" ||
                  event.type === "provider-thread.updated" ||
                  event.type === "subagent.updated" ||
                  (event.type === "turn-item.updated" &&
                    turnItemCanChangeUserWait(event.payload)))),
          ),
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.runForEach(() => sweep()),
          Effect.retry(Schedule.spaced("1 second")),
          Effect.forkScoped,
        );
        // Reconcile missed events on startup, and retry failed reads even when the target stays quiet.
        yield* sweep().pipe(Effect.repeat(Schedule.spaced("1 minute")));
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Thread watcher stopped", { cause }))),
    );
  });
  return { start, sweep: sweep() } satisfies ThreadWatchReactor["Service"];
});

export const layer = Layer.effect(ThreadWatchReactor, make);
