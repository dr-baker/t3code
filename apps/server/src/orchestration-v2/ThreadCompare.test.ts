import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GuestShareId,
  isActiveCompareHost,
  isListedThreadLineage,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const codexDriver = ProviderDriverKind.make("codex");
const codexInstanceId = ProviderInstanceId.make(codexDriver);
const modelA = { instanceId: codexInstanceId, model: "model-a" };
const modelB = { instanceId: codexInstanceId, model: "model-b" };
const projectId = ProjectId.make("compare-project");

const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: codexInstanceId,
  driver: codexDriver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Not used in pure orchestration compare tests"),
};

const testLayer = (name: string) =>
  ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

const createThread = Effect.fnUntraced(function* (input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly modelSelection?: typeof modelA;
  readonly compareParentThreadId?: ThreadId;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${input.id}`),
    threadId: input.id,
    projectId,
    title: input.title,
    modelSelection: input.modelSelection ?? modelA,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    ...(input.compareParentThreadId !== undefined
      ? { compareParentThreadId: input.compareParentThreadId }
      : {}),
  });
});

it.effect(
  "hides compare contenders, picks a winner inheriting host metadata, and undoes cleanly",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hostId = ThreadId.make("compare-host");
      const c1 = ThreadId.make("compare-c1");
      const c2 = ThreadId.make("compare-c2");

      yield* createThread({ id: hostId, title: "Compare benchmark" });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("pin-host"),
        threadId: hostId,
      });
      yield* createThread({
        id: c1,
        title: "Compare benchmark",
        modelSelection: modelA,
        compareParentThreadId: hostId,
      });
      yield* createThread({
        id: c2,
        title: "Compare benchmark",
        modelSelection: modelB,
        compareParentThreadId: hostId,
      });

      const hostBefore = yield* orchestrator.getThreadShell(hostId);
      const c1Before = yield* orchestrator.getThreadShell(c1);
      const c2Before = yield* orchestrator.getThreadShell(c2);
      assert.isNotNull(hostBefore);
      assert.isNotNull(c1Before);
      assert.isNotNull(c2Before);
      assert.isTrue(isListedThreadLineage(hostBefore.lineage));
      assert.isTrue(isActiveCompareHost(hostBefore));
      assert.deepEqual(hostBefore.compare?.contenderThreadIds, [c1, c2]);
      assert.isFalse(isListedThreadLineage(c1Before.lineage));
      assert.isFalse(isListedThreadLineage(c2Before.lineage));
      assert.strictEqual(c1Before.lineage.compare, true);
      assert.strictEqual(c1Before.lineage.sideChat, undefined);
      assert.strictEqual(c1Before.lineage.parentThreadId, hostId);
      assert.isNotNull(hostBefore.pinnedAt);

      // Pick c2 as winner under a ticking clock (like real wall time between loser and host archive).
      const baseClock = yield* Clock.Clock;
      let tickMs = 1_700_000_000_000;
      const tickingClock: Clock.Clock = {
        ...baseClock,
        currentTimeMillisUnsafe: () => ++tickMs,
        currentTimeMillis: Effect.sync(() => ++tickMs),
      };
      yield* orchestrator
        .dispatch({
          type: "thread.compare.pick-winner",
          commandId: CommandId.make("pick-c2"),
          threadId: hostId,
          winnerThreadId: c2,
        })
        .pipe(Effect.provideService(Clock.Clock, tickingClock));

      const hostAfterPick = yield* orchestrator.getThreadShell(hostId);
      const c1AfterPick = yield* orchestrator.getThreadShell(c1);
      const c2AfterPick = yield* orchestrator.getThreadShell(c2);
      assert.isNotNull(hostAfterPick);
      assert.isNotNull(c1AfterPick);
      assert.isNotNull(c2AfterPick);
      assert.isTrue(isListedThreadLineage(c2AfterPick.lineage));
      assert.strictEqual(c2AfterPick.lineage.compare, undefined);
      assert.deepEqual(c2AfterPick.pinnedAt, hostBefore.pinnedAt);
      assert.strictEqual(c2AfterPick.title, "Compare benchmark");
      assert.isNotNull(hostAfterPick.archivedAt);
      assert.strictEqual(hostAfterPick.settledOverride, "settled");
      assert.strictEqual(hostAfterPick.compare?.selectedWinnerThreadId, c2);
      assert.isFalse(isActiveCompareHost(hostAfterPick));
      assert.isNotNull(c1AfterPick.archivedAt);
      assert.deepEqual(c1AfterPick.archivedAt, hostAfterPick.archivedAt);
      assert.strictEqual(c1AfterPick.settledOverride, "settled");

      // Undo restores the exact compare state including unsettled loser state.
      yield* orchestrator.dispatch({
        type: "thread.compare.undo-pick",
        commandId: CommandId.make("undo-pick"),
        threadId: hostId,
      });

      const hostAfterUndo = yield* orchestrator.getThreadShell(hostId);
      const c1AfterUndo = yield* orchestrator.getThreadShell(c1);
      const c2AfterUndo = yield* orchestrator.getThreadShell(c2);
      assert.isNotNull(hostAfterUndo);
      assert.isNotNull(c1AfterUndo);
      assert.isNotNull(c2AfterUndo);
      assert.isNull(hostAfterUndo.archivedAt);
      assert.isNull(hostAfterUndo.settledAt);
      assert.strictEqual(hostAfterUndo.settledOverride, "active");
      assert.isTrue(isActiveCompareHost(hostAfterUndo));
      assert.deepEqual(hostAfterUndo.compare?.contenderThreadIds, [c1, c2]);
      assert.isNull(c1AfterUndo.archivedAt);
      assert.isNull(c1AfterUndo.settledAt);
      assert.strictEqual(c1AfterUndo.settledOverride, "active");
      assert.isFalse(isListedThreadLineage(c1AfterUndo.lineage));
      assert.isFalse(isListedThreadLineage(c2AfterUndo.lineage));
      assert.strictEqual(c2AfterUndo.lineage.compare, true);
      assert.isNull(c2AfterUndo.pinnedAt);
    }).pipe(Effect.provide(testLayer("compare-pick-and-undo"))),
);

it.effect("pop-out and drop clean up an empty host while preserving remaining contenders", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const hostId = ThreadId.make("popout-host");
    const c1 = ThreadId.make("popout-c1");
    const c2 = ThreadId.make("popout-c2");

    yield* createThread({ id: hostId, title: "Explore" });
    yield* createThread({
      id: c1,
      title: "Explore",
      modelSelection: modelA,
      compareParentThreadId: hostId,
    });
    yield* createThread({
      id: c2,
      title: "Explore",
      modelSelection: modelB,
      compareParentThreadId: hostId,
    });

    // Pop out c1: c1 becomes listed, c2 stays in host.
    yield* orchestrator.dispatch({
      type: "thread.compare.pop-out",
      commandId: CommandId.make("popout-c1"),
      threadId: hostId,
      contenderThreadId: c1,
    });
    const hostMid = yield* orchestrator.getThreadShell(hostId);
    const c1Mid = yield* orchestrator.getThreadShell(c1);
    assert.isTrue(isListedThreadLineage(c1Mid!.lineage));
    assert.strictEqual(c1Mid!.lineage.compare, undefined);
    assert.deepEqual(hostMid!.compare?.contenderThreadIds, [c2]);
    assert.isNull(hostMid!.archivedAt);

    // Drop last contender c2: empty 0-run host archives itself.
    yield* orchestrator.dispatch({
      type: "thread.compare.drop",
      commandId: CommandId.make("drop-c2"),
      threadId: hostId,
      contenderThreadId: c2,
    });
    const hostEnd = yield* orchestrator.getThreadShell(hostId);
    const c2End = yield* orchestrator.getThreadShell(c2);
    assert.isNotNull(c2End!.archivedAt);
    assert.isNotNull(hostEnd!.archivedAt);
    assert.isFalse(isActiveCompareHost(hostEnd!));
  }).pipe(Effect.provide(testLayer("compare-popout-drop"))),
);

it.effect("mid-thread compare fork inherits parent history and cascades archive/unarchive", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const hostId = ThreadId.make("mid-host");
    const runId = RunId.make("mid-run-1");
    const providerThreadId = ProviderThreadId.make("mid-host-provider-thread");
    const c1 = ThreadId.make("mid-c1");
    const c2 = ThreadId.make("mid-c2");

    yield* createThread({ id: hostId, title: "Existing thread" });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("mid-provider-thread"),
          type: "provider-thread.updated",
          threadId: hostId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: codexDriver,
            providerInstanceId: codexInstanceId,
            providerSessionId: null,
            appThreadId: hostId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: codexDriver,
              nativeId: "native-mid-host",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("mid-run-created"),
          type: "run.created",
          threadId: hostId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: hostId,
            ordinal: 1,
            providerInstanceId: codexInstanceId,
            modelSelection: modelA,
            providerThreadId,
            userMessageId: MessageId.make("mid-user-1"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("mid-item-user"),
          type: "turn-item.updated",
          threadId: hostId,
          runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("mid-turn-item-1"),
            threadId: hostId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: MessageId.make("mid-user-1"),
            text: "Initial question",
            attachments: [],
          },
        },
      ],
    });

    for (const [targetThreadId, modelSelection] of [
      [c1, modelA],
      [c2, modelB],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`fork-${targetThreadId}`),
        sourceThreadId: hostId,
        targetThreadId,
        sourcePoint: { type: "run", runId },
        createdBy: "user",
        creationSource: "web",
        compare: true,
        modelSelection,
      });
    }

    const c1Projection = yield* orchestrator.getThreadProjection(c1);
    assert.isNotNull(c1Projection);
    assert.strictEqual(c1Projection.thread.lineage.compare, true);
    assert.strictEqual(c1Projection.thread.modelSelection.model, "model-a");
    assert.isTrue(
      c1Projection.visibleTurnItems.some(
        (projected) =>
          projected.item.type === "user_message" && projected.item.text === "Initial question",
      ),
    );

    // Archiving host cascades to contenders; unarchiving host restores them.
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-mid-host"),
      threadId: hostId,
    });
    assert.isNotNull((yield* orchestrator.getThreadShell(c1))?.archivedAt);
    assert.isNotNull((yield* orchestrator.getThreadShell(c2))?.archivedAt);

    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive-mid-host"),
      threadId: hostId,
    });
    assert.isNull((yield* orchestrator.getThreadShell(c1))?.archivedAt);
    assert.isNull((yield* orchestrator.getThreadShell(c2))?.archivedAt);

    // Deferring start on a forked compare contender leaves the run in "preparing" for worktree setup.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("mid-c1-defer-worktree"),
      threadId: c1,
      messageId: MessageId.make("mid-c1-msg-1"),
      text: "Try an alternative approach",
      attachments: [],
      modelSelection: modelA,
      dispatchMode: {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      },
      createdBy: "user",
      creationSource: "web",
    });
    const c1AfterDispatch = yield* orchestrator.getThreadProjection(c1);
    assert.strictEqual(c1AfterDispatch?.runs[0]?.status, "preparing");
    assert.deepEqual(c1AfterDispatch?.runs[0]?.workspacePreparation, {
      type: "worktree",
      baseRef: "main",
    });
  }).pipe(Effect.provide(testLayer("compare-mid-thread-fork"))),
);

it.effect(
  "validates compare membership, guards resolved mutations, and does not revive guest share",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hostId = ThreadId.make("guard-host");
      const c1 = ThreadId.make("guard-c1");
      const c2 = ThreadId.make("guard-c2");
      const unrelated = ThreadId.make("guard-unrelated");

      yield* createThread({ id: hostId, title: "Guarded compare" });
      yield* createThread({ id: unrelated, title: "Unrelated thread" });
      yield* createThread({
        id: c1,
        title: "Guarded compare",
        modelSelection: modelA,
        compareParentThreadId: hostId,
      });
      yield* createThread({
        id: c2,
        title: "Guarded compare",
        modelSelection: modelB,
        compareParentThreadId: hostId,
      });

      // Self-reference and nested-host contender creation are rejected.
      const selfAttach = yield* Effect.exit(
        createThread({
          id: ThreadId.make("self-parent"),
          title: "Invalid self",
          compareParentThreadId: ThreadId.make("self-parent"),
        }),
      );
      assert.strictEqual(selfAttach._tag, "Failure");

      const nestedHost = yield* Effect.exit(
        createThread({
          id: ThreadId.make("nested-child"),
          title: "Invalid nested",
          compareParentThreadId: c1,
        }),
      );
      assert.strictEqual(nestedHost._tag, "Failure");

      assert.isTrue(isActiveCompareHost((yield* orchestrator.getThreadShell(hostId))!));
      assert.isNotNull(yield* orchestrator.getThreadShell(unrelated));

      // Enable guest share on host before picking winner, then verify Pick + Undo does not revive it.
      yield* orchestrator.dispatch({
        type: "thread.guest-share.open",
        commandId: CommandId.make("enable-guest"),
        threadId: hostId,
        shareId: GuestShareId.make("share-test-1"),
        host: "https://example.test",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(hostId))?.thread.guestShare);

      yield* orchestrator.dispatch({
        type: "thread.compare.pick-winner",
        commandId: CommandId.make("guard-pick"),
        threadId: hostId,
        winnerThreadId: c1,
      });

      // Pop-out and drop on a resolved comparison are rejected.
      const stalePop = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.compare.pop-out",
          commandId: CommandId.make("stale-pop"),
          threadId: hostId,
          contenderThreadId: c1,
        }),
      );
      assert.strictEqual(stalePop._tag, "Failure");

      const staleDrop = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.compare.drop",
          commandId: CommandId.make("stale-drop"),
          threadId: hostId,
          contenderThreadId: c2,
        }),
      );
      assert.strictEqual(staleDrop._tag, "Failure");

      // Undo restores comparison without reviving the revoked guest share.
      yield* orchestrator.dispatch({
        type: "thread.compare.undo-pick",
        commandId: CommandId.make("guard-undo"),
        threadId: hostId,
      });
      const hostAfterUndo = yield* orchestrator.getThreadProjection(hostId);
      assert.isNull(hostAfterUndo?.thread.guestShare ?? null);

      // Pick again, delete the promoted winner, and verify selectedWinnerThreadId is cleared and Undo refuses.
      yield* orchestrator.dispatch({
        type: "thread.compare.pick-winner",
        commandId: CommandId.make("guard-pick-2"),
        threadId: hostId,
        winnerThreadId: c1,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-promoted-winner"),
        threadId: c1,
      });
      const hostAfterWinnerDeleted = yield* orchestrator.getThreadShell(hostId);
      assert.isNull(hostAfterWinnerDeleted?.compare?.selectedWinnerThreadId ?? null);

      const undoAfterWinnerDeleted = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.compare.undo-pick",
          commandId: CommandId.make("undo-after-delete"),
          threadId: hostId,
        }),
      );
      assert.strictEqual(undoAfterWinnerDeleted._tag, "Failure");
    }).pipe(Effect.provide(testLayer("compare-guards-and-guest-share"))),
);

it.effect(
  "blocks sends while worktree prepares, blocks fork during active host run, restores side chats on undo, and deletes dropped contenders with host",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const hostId = ThreadId.make("hardening-host");
      const finishedRunId = RunId.make("hardening-run-1");
      const activeRunId = RunId.make("hardening-run-2");
      const providerThreadId = ProviderThreadId.make("hardening-pt");

      yield* createThread({ id: hostId, title: "Hardening host" });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("h-pt"),
            type: "provider-thread.updated",
            threadId: hostId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: codexDriver,
              providerInstanceId: codexInstanceId,
              providerSessionId: null,
              appThreadId: hostId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: codexDriver,
                nativeId: "native-hardening",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("h-run-1"),
            type: "run.created",
            threadId: hostId,
            runId: finishedRunId,
            occurredAt: now,
            payload: {
              id: finishedRunId,
              threadId: hostId,
              ordinal: 1,
              providerInstanceId: codexInstanceId,
              modelSelection: modelA,
              providerThreadId,
              userMessageId: MessageId.make("h-u1"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("h-run-2"),
            type: "run.created",
            threadId: hostId,
            runId: activeRunId,
            occurredAt: now,
            payload: {
              id: activeRunId,
              threadId: hostId,
              ordinal: 2,
              providerInstanceId: codexInstanceId,
              modelSelection: modelA,
              providerThreadId,
              userMessageId: MessageId.make("h-u2"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      // Comparing an older finished run is rejected while a newer host run is active.
      const blockedByActiveRun = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork-while-running"),
          sourceThreadId: hostId,
          targetThreadId: ThreadId.make("hardening-blocked"),
          sourcePoint: { type: "run", runId: finishedRunId },
          createdBy: "user",
          creationSource: "web",
          compare: true,
          modelSelection: modelB,
        }),
      );
      assert.strictEqual(blockedByActiveRun._tag, "Failure");

      // Mark run 2 completed, fork with pendingWorkspacePreparation, and verify stray sends are rejected until bound.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("h-run-2-done"),
            type: "run.updated",
            threadId: hostId,
            runId: activeRunId,
            occurredAt: now,
            payload: {
              id: activeRunId,
              threadId: hostId,
              ordinal: 2,
              providerInstanceId: codexInstanceId,
              modelSelection: modelA,
              providerThreadId,
              userMessageId: MessageId.make("h-u2"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      const sideChatId = ThreadId.make("hardening-sidechat");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-sidechat"),
        sourceThreadId: hostId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "run", runId: activeRunId },
        createdBy: "user",
        creationSource: "web",
        sideChat: true,
      });

      const c1 = ThreadId.make("hardening-c1");
      const c2 = ThreadId.make("hardening-c2");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-c1"),
        sourceThreadId: hostId,
        targetThreadId: c1,
        sourcePoint: { type: "run", runId: finishedRunId },
        createdBy: "user",
        creationSource: "web",
        compare: true,
        clearWorktree: true,
        pendingWorkspacePreparation: true,
        modelSelection: modelA,
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-c2"),
        sourceThreadId: hostId,
        targetThreadId: c2,
        sourcePoint: { type: "run", runId: finishedRunId },
        createdBy: "user",
        creationSource: "web",
        compare: true,
        modelSelection: modelB,
      });

      const straySend = yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("stray-send-before-wt"),
          threadId: c1,
          messageId: MessageId.make("stray-msg"),
          text: "Too early",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.strictEqual(straySend._tag, "Failure");

      // Binding worktreePath clears pendingWorkspacePreparation and allows normal sends.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("bind-c1-wt"),
        threadId: c1,
        worktreePath: "/tmp/wt-c1",
      });
      const c1Bound = yield* orchestrator.getThreadProjection(c1);
      assert.strictEqual(c1Bound?.thread.pendingWorkspacePreparation, undefined);

      // Pick winner archives the host's ordinary side chat; Undo restores both loser and side chat.
      yield* orchestrator.dispatch({
        type: "thread.compare.pick-winner",
        commandId: CommandId.make("hardening-pick"),
        threadId: hostId,
        winnerThreadId: c1,
      });
      assert.isNotNull((yield* orchestrator.getThreadShell(sideChatId))?.archivedAt);

      yield* orchestrator.dispatch({
        type: "thread.compare.undo-pick",
        commandId: CommandId.make("hardening-undo"),
        threadId: hostId,
      });
      assert.isNull((yield* orchestrator.getThreadShell(c2))?.archivedAt);
      assert.isNull((yield* orchestrator.getThreadShell(sideChatId))?.archivedAt);

      // Deleting a fresh compare host also deletes dropped new-mode contenders while preserving popped-out ones.
      const freshHost = ThreadId.make("fresh-delete-host");
      const droppedContender = ThreadId.make("fresh-dropped-c1");
      const poppedContender = ThreadId.make("fresh-popped-c2");
      const remainingContender = ThreadId.make("fresh-active-c3");
      yield* createThread({ id: freshHost, title: "Fresh host" });
      yield* createThread({
        id: droppedContender,
        title: "C1",
        modelSelection: modelA,
        compareParentThreadId: freshHost,
      });
      yield* createThread({
        id: poppedContender,
        title: "C2",
        modelSelection: modelB,
        compareParentThreadId: freshHost,
      });
      yield* createThread({
        id: remainingContender,
        title: "C3",
        modelSelection: modelA,
        compareParentThreadId: freshHost,
      });
      yield* orchestrator.dispatch({
        type: "thread.compare.drop",
        commandId: CommandId.make("fresh-drop-c1"),
        threadId: freshHost,
        contenderThreadId: droppedContender,
      });
      yield* orchestrator.dispatch({
        type: "thread.compare.pop-out",
        commandId: CommandId.make("fresh-pop-c2"),
        threadId: freshHost,
        contenderThreadId: poppedContender,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-fresh-host"),
        threadId: freshHost,
      });
      assert.isNotNull((yield* orchestrator.getThreadShell(droppedContender))?.deletedAt);
      assert.isNotNull((yield* orchestrator.getThreadShell(remainingContender))?.deletedAt);
      assert.isNull((yield* orchestrator.getThreadShell(poppedContender))?.deletedAt);
    }).pipe(Effect.provide(testLayer("compare-hardening"))),
);
