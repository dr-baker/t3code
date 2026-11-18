import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  CodexProviderCapabilitiesV2,
  resolveCodexForkBoundary,
} from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (
  [
    ["codex", "interrupted"],
    ["claudeAgent", "failed"],
  ] as const
).map(([driverName, status]) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return { driver, status, instanceId, modelSelection, adapter, layer };
});

it.effect("forks leave watch registrations with their parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
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
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchedThreadId = ThreadId.make("fork-watched-thread");
    yield* createParent(watchedThreadId);
    yield* orchestrator.dispatch({
      type: "thread.watch",
      commandId: CommandId.make("fork-watch-owner"),
      threadId: sourceThreadId,
      targetThreadId: watchedThreadId,
      watching: true,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 2);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.lengthOf(parentBefore?.threadWatches ?? [], 1);
    assert.lengthOf(fork.threadWatches ?? [], 0);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    const [forkLink] = fork.pullRequests ?? [];
    assert.isDefined(forkLink);
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...forkLink, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");
      const grandparentThreadId = ThreadId.make("fork-boundary-grandparent");
      const grandparentRunId = RunId.make("fork-boundary-grandparent-run");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-grandparent"),
        threadId: grandparentThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary grandparent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* writeParentRun({
        threadId: grandparentThreadId,
        runId: RunId.make("fork-boundary-grandparent-rolled-back-run"),
        ordinal: 1,
        status: "rolled_back",
        text: "ROLLED_BACK_MARKER",
      });
      yield* writeParentRun({
        threadId: grandparentThreadId,
        runId: grandparentRunId,
        ordinal: 2,
        status: "completed",
        text: "GRANDPARENT_MARKER",
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-grandparent"),
        sourceThreadId: grandparentThreadId,
        targetThreadId: sourceThreadId,
        sourcePoint: { type: "run", runId: grandparentRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 2,
              lastRunOrdinal: 3,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      yield* writeParentRun({
        threadId: sourceThreadId,
        runId: RunId.make("fork-boundary-source-rolled-back-run"),
        ordinal: 1,
        status: "rolled_back",
        text: "SOURCE_ROLLED_BACK_MARKER",
      });
      for (const ordinal of [2, 3]) {
        const runId = ordinal === 2 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 2 && status === "interrupted" ? attemptId : null,
                status: ordinal === 2 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 2 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "GRANDPARENT_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "SOURCE_ROLLED_BACK_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "ROLLED_BACK_MARKER");
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { execution: "portable_context", rejected: true },
  { execution: "native_fork", rejected: false },
] as const)(
  "a $execution fork's first /compact is rejected only when no history reaches it: $rejected",
  ({ execution, rejected }) => {
    const opened: Array<ProviderInstanceId> = [];
    const adapter = (driverName: "claudeAgent" | "codex") => {
      const driver = ProviderDriverKind.make(driverName);
      const instanceId = ProviderInstanceId.make(driverName);
      return {
        instanceId,
        driver,
        getCapabilities: () =>
          Effect.succeed(
            driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          ),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.sync(() => opened.push(instanceId)).pipe(
            Effect.andThen(
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
              }),
            ),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    };
    const claude = adapter("claudeAgent");
    const target = execution === "portable_context" ? adapter("codex") : claude;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-compact-source");
      const targetThreadId = ThreadId.make("fork-compact-target");
      const providerThreadId = ProviderThreadId.make("fork-compact-native-thread");
      const sourceRunId = RunId.make("fork-compact-source-run");
      const userMessageId = MessageId.make("fork-compact-source-message");
      const sourceSelection = { instanceId: claude.instanceId, model: "test-model" };

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fork-compact-create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-compact-project"),
        title: "Fork compact source",
        modelSelection: sourceSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const item = {
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("fork-compact-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: claude.driver,
              providerInstanceId: claude.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: claude.driver,
                nativeId: "native-fork-compact-source",
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
            id: EventId.make("fork-compact-source-run"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: claude.instanceId,
              modelSelection: sourceSelection,
              providerThreadId,
              userMessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          // Each message alone exceeds the default 16k handoff budget, so a
          // portable handoff omits both whole items.
          {
            id: EventId.make("fork-compact-user-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-user-item"),
              ordinal: 1,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: userMessageId,
              text: "u".repeat(17_000),
              attachments: [],
            },
          },
          {
            id: EventId.make("fork-compact-assistant-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-assistant-item"),
              ordinal: 2,
              type: "assistant_message",
              messageId: MessageId.make("fork-compact-assistant-message"),
              text: "a".repeat(17_000),
              streaming: false,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-compact-fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-compact-compact"),
        threadId: targetThreadId,
        messageId: MessageId.make("fork-compact-compact"),
        text: "/compact",
        attachments: [],
        modelSelection: { instanceId: target.instanceId, model: "test-model" },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();

      const projection = yield* orchestrator.getThreadProjection(targetThreadId);
      if (execution === "portable_context") {
        assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "portable_context");
        assert.deepEqual(projection.contextHandoffs[0]?.history?.messages, []);
      } else {
        assert.isEmpty(projection.contextHandoffs);
      }
      const emptyCompaction = projection.turnItems.some(
        (turnItem) =>
          turnItem.type === "error" &&
          turnItem.failure.message === "Start a conversation before compacting this thread.",
      );
      assert.equal(emptyCompaction, rejected);
      assert.deepEqual(opened, rejected ? [] : [target.instanceId]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `fork-compact-${execution}` },
          ProviderAdapterRegistry.layerFromAdapters(
            target === claude ? [claude] : [claude, target],
          ),
        ),
      ),
    );
  },
);

const writeParentRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  /** Preparing, failed, and interrupted runs asked for a new worktree. */
  readonly status:
    | "preparing"
    | "running"
    | "queued"
    | "completed"
    | "rolled_back"
    | "failed"
    | "interrupted";
  readonly text: string;
  readonly providerThreadId?: ProviderThreadId;
  readonly nativeBoundary?: "recorded" | "missing";
  /** A checkpointed run on a native provider thread, which `latest_stable` forks start from. */
  readonly stable?: boolean;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { driver, instanceId, modelSelection } = forkCases[0]!;
    const messageId = MessageId.make(`${input.runId}:message`);
    const providerThreadId =
      input.providerThreadId ??
      (input.stable ? ProviderThreadId.make(`${input.runId}:provider-thread`) : null);
    const attemptId = RunAttemptId.make(`${input.runId}:attempt`);
    const providerTurnId = ProviderTurnId.make(`${input.runId}:turn`);
    const rootNodeId = NodeId.make(`${input.runId}:root`);
    yield* eventSink.write({
      events: [
        ...(providerThreadId === null || input.providerThreadId !== undefined
          ? []
          : [
              {
                id: EventId.make(`${input.runId}:provider-thread`),
                type: "provider-thread.updated" as const,
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  appThreadId: input.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `${input.runId}:native`,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: input.ordinal,
                  lastRunOrdinal: input.ordinal,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageId,
            rootNodeId: input.nativeBoundary ? rootNodeId : null,
            activeAttemptId: input.nativeBoundary ? attemptId : null,
            status: input.status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt:
              input.status === "preparing" ||
              input.status === "running" ||
              input.status === "queued"
                ? null
                : now,
            checkpointId: input.stable ? CheckpointId.make(`${input.runId}:checkpoint`) : null,
            contextHandoffId: null,
            ...(input.status === "preparing" ||
            input.status === "failed" ||
            input.status === "interrupted"
              ? { workspacePreparation: { type: "worktree" as const, baseRef: "main" } }
              : {}),
          },
        },
        ...(input.nativeBoundary && providerThreadId
          ? [
              {
                id: EventId.make(attemptId),
                type: "run-attempt.created" as const,
                threadId: input.threadId,
                runId: input.runId,
                occurredAt: now,
                payload: {
                  id: attemptId,
                  runId: input.runId,
                  attemptOrdinal: 1,
                  rootNodeId,
                  providerInstanceId: instanceId,
                  providerThreadId,
                  providerTurnId,
                  reason: "initial" as const,
                  status: "completed" as const,
                  startedAt: now,
                  completedAt: now,
                },
              },
              ...(input.nativeBoundary === "recorded"
                ? [
                    {
                      id: EventId.make(providerTurnId),
                      type: "provider-turn.updated" as const,
                      threadId: input.threadId,
                      runId: input.runId,
                      occurredAt: now,
                      payload: {
                        id: providerTurnId,
                        providerThreadId,
                        nodeId: rootNodeId,
                        runAttemptId: attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `${input.runId}:native-turn`,
                          strength: "strong" as const,
                        },
                        ordinal: input.ordinal,
                        status: "completed" as const,
                        startedAt: now,
                        completedAt: now,
                      },
                    },
                  ]
                : []),
            ]
          : []),
        {
          id: EventId.make(`${input.runId}:item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${input.runId}:item`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId,
            text: input.text,
            attachments: [],
          },
        },
      ],
    });
  });

/** Marks `threadId` as imported from V1 and gives it one runless imported user message. */
const writeImportedHistory = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${threadId}:imported`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, historyOrigin: "v1_import" },
        },
        {
          id: EventId.make(`${threadId}:imported-item`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${threadId}:imported-item`),
            threadId,
            runId: null,
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
            messageId: MessageId.make(`${threadId}:imported-message`),
            text,
            attachments: [],
          },
        },
      ],
    });
  });

const createParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection: forkCases[0]!.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const forkSideChat = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(commandId),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "latest_stable" },
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });
  });

const askSideChat = (
  threadId: ThreadId,
  commandId: string,
  modelSelection?: (typeof forkCases)[number]["modelSelection"],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      threadId,
      messageId: MessageId.make(commandId),
      text: "What is the main thread doing?",
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

function recordingForkAdapter(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  calls: {
    readonly onStart: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => Effect.Effect<void>;
    readonly onFork?: (
      fork: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterForkThreadError>;
  },
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const { instanceId, driver } = adapter;
  return {
    ...adapter,
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const capabilities = yield* adapter.getCapabilities();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/tmp/fork-test",
            model: "test-model",
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: { driver, nativeId: `fresh:${threadId}`, strength: "strong" },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: calls.onStart,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: (fork) =>
            (calls.onFork?.(fork) ?? Effect.void).pipe(
              Effect.as({
                ...fork.sourceProviderThread,
                appThreadId: fork.targetThreadId,
                nativeThreadRef: {
                  driver,
                  nativeId: `forked:${fork.targetThreadId}`,
                  strength: "strong",
                },
                updatedAt: now,
              }),
            ),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
}

type AnswerOutput =
  | Pick<
      Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>,
      "type" | "messageId" | "text" | "streaming"
    >
  | Pick<
      Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
      "type" | "toolName" | "input" | "output"
    >;

const writeAnswer = Effect.fn("ThreadForkTest.writeAnswer")(function* (
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  output: AnswerOutput,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const id = `${runId}:answer:${ordinal}`;
  yield* sink.write({
    events: [
      {
        id: EventId.make(id),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          ...output,
          id: TurnItemId.make(id),
          threadId,
          runId,
          ordinal,
          status: "completed",
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});

const assistantAnswer = (text: string, id: string) =>
  ({
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: false,
  }) satisfies AnswerOutput;

it.effect("a rewrite council starts atomically and brings only the chosen run back", () => {
  const starts = new Map<MessageId, ProviderAdapter.ProviderAdapterV2TurnInput>();
  const first = forkCases[0]!;
  const second = forkCases[1]!;
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: "rewrite-selection" },
    ProviderAdapterRegistry.layerFromAdapters([
      recordingForkAdapter(first.adapter, {
        onStart: (turn) =>
          Effect.sync(() => {
            starts.set(turn.message.messageId, turn);
          }),
      }),
      second.adapter,
    ]),
    { runEffectWorker: false },
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const settings = yield* ServerSettingsService;
    const threadId = ThreadId.make("rewrite-parent");
    const runId = RunId.make("rewrite-source");
    const projectId = ProjectId.make("side-chat-project");
    const firstModel = first.modelSelection;
    const secondModel = { ...second.modelSelection, options: [{ id: "effort", value: "high" }] };
    yield* settings.updateSettings({
      rewriteCouncil: [firstModel, secondModel],
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [second.instanceId]: { enabled: false } } },
      },
    });
    yield* createParent(threadId);
    yield* writeParentRun({
      threadId,
      runId,
      ordinal: 1,
      status: "completed",
      text: "Original request",
      stable: true,
    });
    yield* writeAnswer(
      threadId,
      runId,
      101,
      assistantAnswer("Original source answer", "original-answer"),
    );
    const laterRunId = RunId.make("later-source");
    yield* writeParentRun({
      threadId,
      runId: laterRunId,
      ordinal: 2,
      status: "completed",
      text: "LATER_SOURCE_SENTINEL",
    });
    yield* writeAnswer(
      threadId,
      laterRunId,
      201,
      assistantAnswer("LATER_ANSWER_SENTINEL", "later-answer"),
    );
    const base = { threadId, runId, createdBy: "user" as const, creationSource: "web" as const };
    const start = (id: string) =>
      orchestrator.dispatch({
        ...base,
        type: "thread.rewrites.start",
        commandId: CommandId.make(id),
      });
    const select = (id: string, candidateThreadId: ThreadId | null) =>
      orchestrator.dispatch({
        ...base,
        type: "thread.rewrites.select",
        commandId: CommandId.make(id),
        candidateThreadId,
      });
    const readParent = () => orchestrator.getThreadProjection(threadId);
    const readRun = Effect.map(readParent(), (projection) =>
      projection.runs.find((r) => r.id === runId)!,
    );
    const originalRun = yield* readRun;

    const disabled = yield* start("disabled-seat").pipe(Effect.flip);
    assert.include(String(disabled.cause), `${second.instanceId} is disabled`);
    assert.isUndefined((yield* readRun).rewrites);
    assert.isNull(yield* orchestrator.getThreadShell(ThreadId.make("rewrite-disabled-seat-1")));
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [second.instanceId]: { enabled: true } } },
      },
    });
    yield* Effect.all([start("generate"), start("concurrent-start")], { concurrency: "unbounded" });
    const group = (yield* readRun).rewrites!;
    assert.deepEqual(
      group.candidates.map((c) => c.modelSelection),
      [firstModel, secondModel],
    );
    const winningStart =
      group.candidates[0]?.threadId === "rewrite-generate-1" ? "generate" : "concurrent-start";
    const losingStart = winningStart === "generate" ? "concurrent-start" : "generate";
    assert.isNull(yield* orchestrator.getThreadShell(ThreadId.make(`rewrite-${losingStart}-1`)));
    yield* start("reopen");
    assert.deepEqual((yield* readRun).rewrites, group);

    const [textSeat, artifactSeat] = group.candidates;
    assert.isDefined(textSeat);
    assert.isDefined(artifactSeat);
    for (const candidate of group.candidates) {
      const child = yield* orchestrator.getThreadProjection(candidate.threadId);
      assert.deepEqual(child.thread.forkedFrom, { threadId, type: "run", runId });
      const history = child.contextHandoffs.find(
        (h) => h.strategy === "full_thread_summary",
      )?.history;
      const text = history?.messages.map((message) => message.text).join("\n");
      assert.include(text, "Original request");
      assert.include(text, "Original source answer");
      assert.notInclude(text, "_SENTINEL");
      const run = child.runs.find((r) => r.id === candidate.runId)!;
      assert.include(child.messages[0]!.text, "Skills used");
      if (candidate === textSeat) {
        yield* writeAnswer(
          child.thread.id,
          run.id,
          2,
          assistantAnswer("TEXT_SEAT_ANSWER", "text-seat-answer"),
        );
      } else {
        yield* writeAnswer(child.thread.id, run.id, 2, {
          type: "dynamic_tool",
          toolName: "mcp__t3-code__send_to_user",
          input: {},
          output: { sentMessage: "SENT_ANSWER_TEXT" },
        });
        yield* writeAnswer(child.thread.id, run.id, 3, {
          type: "dynamic_tool",
          toolName: "mcp__t3-code__html_render",
          input: {},
          output: {
            htmlRender: {
              attachmentId: "selected-chart-attachment",
              title: "Winner chart",
              height: 300,
            },
          },
        });
      }
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(candidate.threadId + ":finished"),
            type: "run.updated",
            threadId: child.thread.id,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* select("select-" + candidate.threadId, candidate.threadId);
      const parent = yield* readParent();
      assert.deepEqual(
        parent.contextTransfers
          .filter((t) => t.type === "merge_back" && t.status === "pending")
          .map((t) => [t.sourceThreadId, t.sourcePoint.runId]),
        [[candidate.threadId, candidate.runId]],
      );
      assert.equal((yield* readRun).rewrites?.selectedThreadId, candidate.threadId);
      assert.deepEqual(parent.thread.modelSelection, firstModel);
    }
    yield* select("restore", null);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("late-run-update"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: originalRun,
        },
      ],
    });
    assert.isNull((yield* readRun).rewrites?.selectedThreadId);
    assert.isFalse(
      (yield* readParent()).contextTransfers.some(
        (t) => t.type === "merge_back" && t.status === "pending",
      ),
    );

    yield* select("choose-again", artifactSeat.threadId);
    yield* askSideChat(threadId, "continue-after-rewrite", firstModel);
    yield* worker.drain();
    const followUpInput = starts.get(MessageId.make("continue-after-rewrite"));
    assert.isDefined(followUpInput);
    const delivered = JSON.stringify(followUpInput);
    assert.include(delivered, "SENT_ANSWER_TEXT");
    assert.include(delivered, "selected-chart-attachment");
    assert.notInclude(delivered, "TEXT_SEAT_ANSWER");
    const continued = yield* readParent();
    const followUp = continued.runs.find((r) => r.userMessageId === "continue-after-rewrite")!;
    assert.isTrue(
      continued.contextTransfers.some(
        (t) =>
          t.type === "merge_back" &&
          t.sourcePoint.runId === artifactSeat.runId &&
          t.targetRunId === followUp.id &&
          t.status === "consumed",
      ),
    );
    assert.deepEqual(followUp.modelSelection, firstModel);

    const finishParentRun = (run: typeof followUp) =>
      sink.write({
        events: [
          {
            id: EventId.make(`finish:${run.id}`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
    yield* finishParentRun(followUp);

    yield* select("choose-before-deletion", textSeat.threadId);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-only-unused-rewrite"),
      threadId: textSeat.threadId,
      onlyIfUnused: true,
    });
    assert.equal((yield* readRun).rewrites?.selectedThreadId, textSeat.threadId);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-chosen-rewrite"),
      threadId: textSeat.threadId,
    });
    yield* askSideChat(threadId, "continue-after-deletion", firstModel);
    yield* worker.drain();
    const afterDeletionInput = starts.get(MessageId.make("continue-after-deletion"));
    assert.isDefined(afterDeletionInput);
    assert.notInclude(JSON.stringify(afterDeletionInput), "TEXT_SEAT_ANSWER");
    assert.isNull((yield* readRun).rewrites?.selectedThreadId);
    assert.isTrue(
      (yield* readParent()).contextTransfers.some(
        (t) =>
          t.type === "merge_back" &&
          t.sourcePoint.runId === textSeat.runId &&
          t.status === "superseded",
      ),
    );
    yield* select("choose-deleted-rewrite", textSeat.threadId).pipe(Effect.flip);
    yield* finishParentRun(
      (yield* readParent()).runs.find((run) => run.id === afterDeletionInput.runId)!,
    );
    yield* select("choose-surviving-rewrite", artifactSeat.threadId);

    const laterChildRun = RunId.make("later-child-run");
    yield* writeParentRun({
      threadId: artifactSeat.threadId,
      runId: laterChildRun,
      ordinal: 2,
      status: "completed",
      text: "A separate Bring back",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.merge_back",
      commandId: CommandId.make("bring-back-later-child-run"),
      sourceThreadId: artifactSeat.threadId,
      targetThreadId: threadId,
      sourcePoint: { type: "run", runId: laterChildRun },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-rewrite-with-later-bring-back"),
      threadId: artifactSeat.threadId,
    });
    assert.isNull((yield* readRun).rewrites?.selectedThreadId);
    const transfersAfterDeletion = (yield* readParent()).contextTransfers;
    assert.isTrue(
      transfersAfterDeletion.some(
        (t) =>
          t.type === "merge_back" &&
          t.sourcePoint.runId === artifactSeat.runId &&
          t.targetRunId === followUp.id &&
          t.status === "consumed",
      ),
    );
    assert.isTrue(
      transfersAfterDeletion.some(
        (t) =>
          t.type === "merge_back" &&
          t.sourceThreadId === artifactSeat.threadId &&
          t.sourcePoint.runId === laterChildRun &&
          t.status === "pending",
      ),
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each(["recorded", "missing", "lost before startup"] as const)(
  "starts rewrite turns with the selected source when the native boundary is %s",
  (nativeBoundary) => {
    const starts = new Map<ThreadId, ProviderAdapter.ProviderAdapterV2TurnInput>();
    const nativeHistories = new Map<ThreadId, string[]>();
    const native = forkCases[0]!;
    const portable = forkCases[1]!;
    let boundaryLost = false;
    const threadId = ThreadId.make("rewrite-boundary-parent");
    const runId = RunId.make("rewrite-boundary-first");
    const laterRunId = RunId.make("rewrite-boundary-later");
    const answers = new Map([
      [`${runId}:native-turn`, "BOUNDARY_SOURCE_ANSWER"],
      [`${laterRunId}:native-turn`, "LATER_TURN_SENTINEL"],
    ]);
    const recordStart = (start: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.sync(() => {
        starts.set(start.threadId, start);
      });
    const layer = ProviderReplayHarness.layerWithRegistry(
      { name: `rewrite-boundary-${nativeBoundary}` },
      ProviderAdapterRegistry.layerFromAdapters([
        recordingForkAdapter(native.adapter, {
          onStart: recordStart,
          onFork: (fork) =>
            resolveCodexForkBoundary(fork).pipe(
              Effect.map(({ lastTurnId }) => {
                const turns = fork.sourceProviderTurns ?? [];
                const boundary = turns.find((turn) => turn.nativeTurnRef?.nativeId === lastTurnId);
                nativeHistories.set(
                  fork.targetThreadId,
                  turns
                    .filter((turn) => !boundary || turn.ordinal <= boundary.ordinal)
                    .flatMap((turn) => answers.get(turn.nativeTurnRef?.nativeId ?? "") ?? []),
                );
              }),
            ),
        }),
        recordingForkAdapter(portable.adapter, { onStart: recordStart }),
      ]),
      {
        runEffectWorker: false,
        wrapProjectionStore: (store) => ({
          ...store,
          getThreadRecords: (id, fields, filter) =>
            store.getThreadRecords(id, fields, filter).pipe(
              Effect.map((projection) => {
                if (!boundaryLost || id !== threadId || !("providerTurns" in projection))
                  return projection;
                return { ...projection, providerTurns: [] };
              }),
            ),
        }),
      },
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const settings = yield* ServerSettingsService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* settings.updateSettings({
        rewriteCouncil: [native.modelSelection, portable.modelSelection],
        projectSettingsOverrides: {
          [ProjectId.make("side-chat-project")]: {
            providerInstances: { [portable.instanceId]: { enabled: true } },
          },
        },
      });
      yield* createParent(threadId);
      const watchedThreadId = ThreadId.make("rewrite-watched-thread");
      yield* createParent(watchedThreadId);
      yield* orchestrator.dispatch({
        type: "thread.watch",
        commandId: CommandId.make("rewrite-watch-owner"),
        threadId,
        targetThreadId: watchedThreadId,
        watching: true,
      });
      yield* writeParentRun({
        threadId,
        runId,
        ordinal: 1,
        status: "completed",
        stable: true,
        text: "Original request",
        nativeBoundary: nativeBoundary === "missing" ? "missing" : "recorded",
      });
      yield* writeAnswer(
        threadId,
        runId,
        101,
        assistantAnswer("BOUNDARY_SOURCE_ANSWER", "boundary-answer"),
      );
      yield* writeParentRun({
        threadId,
        runId: laterRunId,
        ordinal: 2,
        status: "completed",
        providerThreadId: ProviderThreadId.make(`${runId}:provider-thread`),
        text: "Later request",
        nativeBoundary: "recorded",
      });
      yield* writeAnswer(
        threadId,
        laterRunId,
        201,
        assistantAnswer("LATER_TURN_SENTINEL", "later-sentinel"),
      );
      yield* orchestrator.dispatch({
        type: "thread.rewrites.start",
        commandId: CommandId.make("rewrite-boundary"),
        threadId,
        runId,
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const candidates = parent.runs.find((run) => run.id === runId)?.rewrites?.candidates ?? [];
      assert.lengthOf(candidates, 2);
      assert.lengthOf(parent.thread.threadWatches ?? [], 1);
      for (const candidate of candidates) {
        const child = yield* orchestrator.getThreadShell(candidate.threadId);
        assert.isNotNull(child);
        assert.lengthOf(child.threadWatches ?? [], 0);
      }
      boundaryLost = nativeBoundary === "lost before startup";
      yield* worker.drain();
      for (const candidate of candidates) {
        const started = starts.get(candidate.threadId);
        assert.isDefined(started);
        const usesNativeFork =
          nativeBoundary === "recorded" &&
          candidate.modelSelection.instanceId === native.instanceId;
        if (usesNativeFork) {
          assert.deepEqual(nativeHistories.get(candidate.threadId), ["BOUNDARY_SOURCE_ANSWER"]);
        } else {
          assert.isFalse(nativeHistories.has(candidate.threadId));
          assert.include(JSON.stringify(started), "BOUNDARY_SOURCE_ANSWER");
          assert.notInclude(JSON.stringify(started), "LATER_TURN_SENTINEL");
        }
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("resolves an explicit checkpoint fork to its source run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const parentId = ThreadId.make("checkpoint-fork-parent");
    const childId = ThreadId.make("checkpoint-fork-child");
    const runId = RunId.make("checkpoint-fork-run");
    const checkpointId = CheckpointId.make("checkpoint-fork-checkpoint");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId,
      ordinal: 1,
      status: "completed",
      text: "Work",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("checkpoint-fork-captured"),
          type: "checkpoint.captured",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId: parentId,
            scopeId: CheckpointScopeId.make("checkpoint-fork-scope"),
            runId,
            nodeId: NodeId.make("checkpoint-fork-node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: CheckpointRef.make("refs/t3/checkpoint-fork/1"),
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("checkpoint-fork"),
      sourceThreadId: parentId,
      targetThreadId: childId,
      sourcePoint: { type: "checkpoint", checkpointId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const child = yield* orchestrator.getThreadShell(childId);
    assert.deepEqual(child?.forkedFrom, { type: "run", threadId: parentId, runId });
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a fresh send in a fork that has not run yet starts without the fork's context", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("fresh-fork-parent");
    const forkId = ThreadId.make("fresh-fork-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("fresh-fork-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Work",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fresh-fork"),
      sourceThreadId: parentId,
      targetThreadId: forkId,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    const scheduled = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fresh-fork-scheduled"),
        threadId: forkId,
        messageId: MessageId.make("fresh-fork-scheduled"),
        scheduledTaskId: ScheduledTaskId.make("fresh-fork-task"),
        text: "Scheduled",
        attachments: [],
        freshContext: true,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(String(scheduled.cause), "still being applied");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fresh-fork-send"),
      threadId: forkId,
      messageId: MessageId.make("fresh-fork-send"),
      text: "Start over",
      attachments: [],
      freshContext: true,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const fork = yield* orchestrator.getThreadProjection(forkId);
    assert.isTrue(fork.runs.at(-1)?.freshContext === true);
    assert.deepEqual(
      fork.contextTransfers.filter((transfer) => transfer.type === "fork").map((t) => t.status),
      ["superseded"],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each([
  {
    name: "a fresh send queued behind a side chat's failed first run gives later sends no note",
    scheduled: false,
  },
  {
    name: "a scheduled fresh run queued behind a side chat's failed first run keeps the fork",
    scheduled: true,
  },
] as const)("$name", ({ scheduled }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const key = scheduled ? "queued-scheduled-side-chat" : "queued-fresh-side-chat";
    const parentId = ThreadId.make(`${key}-parent`);
    const sideChatId = ThreadId.make(`${key}-child`);
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make(`${key}-parent-run`),
      ordinal: 1,
      status: "completed",
      text: "Work",
      stable: true,
    });
    yield* forkSideChat(`${key}-fork`, parentId, sideChatId);
    const send = (name: string, freshContext = false) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${key}-${name}`),
        threadId: sideChatId,
        messageId: MessageId.make(`${key}-${name}`),
        text: name,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
        ...(freshContext ? { freshContext } : {}),
        ...(freshContext && scheduled
          ? { scheduledTaskId: ScheduledTaskId.make(`${key}-task`) }
          : {}),
      });
    const settle = (name: string, status: "failed" | "completed") =>
      Effect.gen(function* () {
        const run = (yield* orchestrator.getThreadProjection(sideChatId)).runs.find(
          (candidate) => candidate.userMessageId === MessageId.make(`${key}-${name}`),
        )!;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${key}-${name}-${status}`),
              type: "run.updated",
              threadId: sideChatId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status, completedAt: now },
            },
          ],
        });
      });
    yield* send("first");
    yield* send("fresh", true);
    // The first run fails before its provider forks the parent's session.
    yield* settle("first", "failed");
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`${key}-resume`),
      threadId: sideChatId,
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(sideChatId)).runs.find(
        (run) => run.userMessageId === MessageId.make(`${key}-fresh`),
      )?.status,
      "starting",
    );
    yield* settle("fresh", "completed");
    yield* send("next");

    const sideChat = yield* orchestrator.getThreadProjection(sideChatId);
    assert.deepEqual(
      sideChat.contextTransfers.filter((transfer) => transfer.type === "fork").map((t) => t.status),
      [scheduled ? "pending" : "superseded"],
    );
    if (scheduled) return;
    const next = sideChat.runs.find((run) => run.userMessageId === MessageId.make(`${key}-next`));
    // A fork still pending would give the next send a new note, with a digest of the main thread.
    assert.deepEqual(
      sideChat.contextHandoffs.filter((handoff) => handoff.targetRunId === next?.id),
      [],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of a busy parent points history recovery at the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-recovery-parent");
    const sideChatId = ThreadId.make("side-chat-recovery-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-recovery-stable-run"),
      ordinal: 1,
      status: "completed",
      text: "Earlier parent history",
      stable: true,
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-recovery-busy-run"),
      ordinal: 2,
      status: "running",
      text: "Parent work in progress",
    });
    yield* forkSideChat("side-chat-recovery-fork", parentId, sideChatId);
    yield* askSideChat(sideChatId, "side-chat-recovery-first-message");

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.equal(started.contextTransfers[0]?.resolution?.strategy, "portable_context");
    const handoff = started.contextHandoffs.find((item) => item.strategy === "full_thread_summary");
    const coverage = handoff?.history?.coverage ?? "";
    assert.include(coverage, `t3_thread_read({threadId:"${parentId}"`);
    assert.notInclude(coverage, `threadId:"${sideChatId}"`);
    assert.isFalse(started.turnItems.some((item) => item.type === "handoff"));
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of an idle parent still starts with the framing note", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-idle-parent");
    const sideChatId = ThreadId.make("side-chat-idle-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-idle-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });

    const reads: Array<string> = [];
    const recordReads: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (/^\s*SELECT/i.test(query)) reads.push(query);
      return Effect.succeed(statement);
    };
    yield* forkSideChat("side-chat-idle-fork", parentId, sideChatId).pipe(
      Effect.provideService(Statement.CurrentTransformer, recordReads),
    );
    assert.isEmpty(
      reads.filter(
        (query) =>
          query.includes("FROM orchestration_v2_projection_checkpoints") ||
          query.includes("FROM orchestration_v2_projection_context_transfers"),
      ),
    );
    assert.equal(
      (yield* orchestrator.getThreadProjection(sideChatId)).thread.runtimeMode,
      "full-access",
    );
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("side-chat-parent-mode-change"),
      threadId: parentId,
      runtimeMode: "approval-required",
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(sideChatId)).thread.runtimeMode,
      "full-access",
    );
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("side-chat-child-mode-change"),
      threadId: sideChatId,
      runtimeMode: "auto",
    });
    yield* askSideChat(sideChatId, "side-chat-idle-first-message", {
      ...forkCases[0]!.modelSelection,
      model: "side-chat-model",
    });

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.equal(started.thread.runtimeMode, "auto");
    assert.equal(
      (yield* orchestrator.getThreadProjection(parentId)).thread.runtimeMode,
      "approval-required",
    );
    assert.isNotNull(started.providerThreads[0]?.forkedFrom);
    // The side chat does not show the parent's run, so it is no baseline.
    assert.isFalse(
      started.turnItems.some((item) => item.type === "user_message" && item.modelSwitch),
    );
    assert.lengthOf(started.contextHandoffs, 1);
    const [handoff] = started.contextHandoffs;
    assert.isTrue(
      handoff!.summaryText.startsWith("You are in a side chat beside the main thread."),
    );
    assert.notInclude(handoff!.summaryText, "Main thread activity");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat waits for the parent's new worktree, also after its setup ended", () =>
  Effect.gen(function* () {
    for (const status of ["preparing", "failed", "interrupted"] as const) {
      const parentId = ThreadId.make(`side-chat-worktree-parent-${status}`);
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make(`side-chat-worktree-parent-run-${status}`),
        ordinal: 1,
        status,
        text: "Parent work",
      });

      const rejected = yield* forkSideChat(
        `side-chat-worktree-fork-${status}`,
        parentId,
        ThreadId.make(`side-chat-worktree-child-${status}`),
      ).pipe(Effect.flip);
      assert.include(String(rejected.cause), "has no worktree yet", status);
    }
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat opens once a later run has worked in the project checkout", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-worktree-abandoned-parent");
    const sideChatId = ThreadId.make("side-chat-worktree-abandoned-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-worktree-abandoned-run-1"),
      ordinal: 1,
      status: "interrupted",
      text: "Stopped during setup",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-worktree-abandoned-run-2"),
      ordinal: 2,
      status: "completed",
      text: "Worked in the project checkout",
      stable: true,
    });

    yield* forkSideChat("side-chat-worktree-abandoned-fork", parentId, sideChatId);
    assert.isNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);

    // A retried setup that is running again, or failed again, comes after the later run.
    for (const status of ["preparing", "failed"] as const) {
      const retriedParentId = ThreadId.make(`side-chat-worktree-retried-parent-${status}`);
      yield* createParent(retriedParentId);
      yield* writeParentRun({
        threadId: retriedParentId,
        runId: RunId.make(`side-chat-worktree-retried-run-2-${status}`),
        ordinal: 2,
        status: "completed",
        text: "Worked in the project checkout",
        stable: true,
      });
      yield* TestClock.adjust("1 second");
      yield* writeParentRun({
        threadId: retriedParentId,
        runId: RunId.make(`side-chat-worktree-retried-run-1-${status}`),
        ordinal: 1,
        status,
        text: "Retried setup",
      });
      const rejected = yield* forkSideChat(
        `side-chat-worktree-retried-fork-${status}`,
        retriedParentId,
        ThreadId.make(`side-chat-worktree-retried-child-${status}`),
      ).pipe(Effect.flip);
      assert.include(String(rejected.cause), "has no worktree yet", status);
    }
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("closing a side chat deletes it only while unused; a deleted parent takes no more", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-close-parent");
    const unused = ThreadId.make("side-chat-close-unused");
    const used = ThreadId.make("side-chat-close-used");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-close-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    yield* forkSideChat("side-chat-close-fork-unused", parentId, unused);
    yield* forkSideChat("side-chat-close-fork-used", parentId, used);
    yield* askSideChat(used, "side-chat-close-used-message");
    const close = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`side-chat-close:${threadId}`),
        threadId,
        onlyIfUnused: true,
      });

    yield* close(unused);
    yield* close(used);
    assert.isNotNull((yield* orchestrator.getThreadProjection(unused)).thread.deletedAt);
    assert.isNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-close-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);
    const orphan = yield* forkSideChat(
      "side-chat-close-orphan",
      parentId,
      ThreadId.make("side-chat-close-orphan"),
    ).pipe(Effect.flip);
    assert.include(String(orphan.cause), "was deleted");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect(
  "archiving a parent stops and archives its side chats; unarchiving brings them back",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { driver, instanceId } = forkCases[0]!;
      const parentId = ThreadId.make("side-chat-archive-parent");
      const busy = ThreadId.make("side-chat-archive-busy");
      const archivedFirst = ThreadId.make("side-chat-archive-archived-first");
      const delegating = ThreadId.make("side-chat-archive-delegating");
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make("side-chat-archive-parent-run"),
        ordinal: 1,
        status: "completed",
        text: "Parent work",
        stable: true,
      });
      yield* forkSideChat("side-chat-archive-fork-busy", parentId, busy);
      yield* forkSideChat("side-chat-archive-fork-archived-first", parentId, archivedFirst);
      yield* forkSideChat("side-chat-archive-fork-delegating", parentId, delegating);
      const runningRunId = RunId.make("side-chat-archive-busy-running");
      const queuedRunId = RunId.make("side-chat-archive-busy-queued");
      yield* writeParentRun({
        threadId: busy,
        runId: runningRunId,
        ordinal: 1,
        status: "running",
        text: "Run a long command",
      });
      yield* writeParentRun({
        threadId: busy,
        runId: queuedRunId,
        ordinal: 2,
        status: "queued",
        text: "Then this",
      });
      const now = yield* DateTime.now;
      for (const threadId of [parentId, busy]) {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:session`),
              type: "provider-session.attached",
              threadId,
              driver,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: ProviderSessionId.make(`${threadId}:session`),
                driver,
                providerInstanceId: instanceId,
                status: "running",
                cwd: "/workspace",
                model: "test-model",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
          ],
        });
      }
      const delegatingRunId = RunId.make("side-chat-archive-delegating-run");
      yield* writeParentRun({
        threadId: delegating,
        runId: delegatingRunId,
        ordinal: 1,
        status: "completed",
        text: "Delegate a review",
      });
      const taskId = NodeId.make("side-chat-archive-delegated-task");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${taskId}:running`),
            type: "subagent.updated",
            threadId: delegating,
            occurredAt: now,
            payload: {
              id: taskId,
              threadId: delegating,
              runId: delegatingRunId,
              parentNodeId: NodeId.make("side-chat-archive-delegating-node"),
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: ThreadId.make("side-chat-archive-delegated-child"),
              nativeTaskRef: null,
              prompt: "Review the changes",
              title: null,
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
        ],
      });
      const archive = (commandId: string, threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(commandId),
          threadId,
        });
      const archivedAt = (threadId: ThreadId) =>
        orchestrator
          .getThreadProjection(threadId)
          .pipe(Effect.map(({ thread }) => thread.archivedAt));

      // Archiving a side chat on its own leaves its parent alone.
      yield* archive("side-chat-archive-only-child", archivedFirst);
      const childArchivedAt = yield* archivedAt(archivedFirst);
      assert.isNotNull(childArchivedAt);
      assert.isNull(yield* archivedAt(parentId));
      yield* TestClock.adjust("1 second");

      yield* archive("side-chat-archive-parent", parentId);
      assert.isNotNull(yield* archivedAt(parentId));
      const archivedBusy = yield* orchestrator.getThreadProjection(busy);
      assert.isNotNull(archivedBusy.thread.archivedAt);
      assert.equal(archivedBusy.runs.find((run) => run.id === queuedRunId)?.status, "cancelled");
      assert.isEmpty(archivedBusy.providerSessions);
      assert.deepEqual(yield* archivedAt(archivedFirst), childArchivedAt);
      // Archive refuses a thread still waiting on delegated tasks, so the cascade leaves it active.
      assert.isNull(yield* archivedAt(delegating));

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("side-chat-archive-unarchive-parent"),
        threadId: parentId,
      });
      assert.isNull(yield* archivedAt(parentId));
      assert.isNull(yield* archivedAt(busy));
      assert.deepEqual(yield* archivedAt(archivedFirst), childArchivedAt);
    }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat opened during the parent's first turn starts from a digest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const grandparentId = ThreadId.make("side-chat-busy-grandparent");
    const grandparentRunId = RunId.make("side-chat-busy-grandparent-run");
    const parentId = ThreadId.make("side-chat-busy-parent");
    const sideChatId = ThreadId.make("side-chat-busy-child");
    yield* createParent(grandparentId);
    yield* writeParentRun({
      threadId: grandparentId,
      runId: grandparentRunId,
      ordinal: 1,
      status: "completed",
      text: "GRANDPARENT_MARKER",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("side-chat-busy-parent-fork"),
      sourceThreadId: grandparentId,
      targetThreadId: parentId,
      sourcePoint: { type: "run", runId: grandparentRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeImportedHistory(parentId, "PARENT_IMPORTED_MARKER");
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-rewound-parent-run"),
      ordinal: 1,
      status: "rolled_back",
      text: "PARENT_ROLLED_BACK_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-busy-parent-run"),
      ordinal: 2,
      status: "running",
      text: "PARENT_RUNNING_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-queued-parent-run"),
      ordinal: 3,
      status: "queued",
      text: "PARENT_QUEUED_MARKER",
    });
    const fork = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(commandId),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

    yield* fork("side-chat-busy-fork", parentId, sideChatId);
    const created = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isTrue(created.thread.lineage.sideChat);
    assert.equal(created.thread.runtimeMode, "full-access");
    assert.isNull(created.thread.forkedFrom);
    assert.deepEqual(created.contextTransfers[0]?.sourcePoint, { threadId: parentId });

    const nested = yield* fork(
      "side-chat-busy-nested",
      sideChatId,
      ThreadId.make("side-chat-busy-nested"),
    ).pipe(Effect.flip);
    assert.equal(nested._tag, "OrchestratorDispatchError");
    // Either would take the side chat's lock before the parent's, against the delete cascade.
    const ontoParent = yield* fork("side-chat-busy-onto-parent", sideChatId, parentId).pipe(
      Effect.flip,
    );
    assert.equal(ontoParent._tag, "OrchestratorThreadAlreadyExistsError");
    const ontoExisting = yield* fork("side-chat-busy-onto-existing", parentId, sideChatId).pipe(
      Effect.flip,
    );
    assert.equal(ontoExisting._tag, "OrchestratorThreadAlreadyExistsError");
    const plainOntoExisting = yield* orchestrator
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make("side-chat-busy-plain-onto-existing"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(plainOntoExisting._tag, "OrchestratorThreadAlreadyExistsError");
    const busyMergeBack = yield* orchestrator
      .dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make("side-chat-busy-merge-back"),
        sourceThreadId: sideChatId,
        targetThreadId: parentId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(String(busyMergeBack.cause), "active work");

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("side-chat-busy-first-message"),
      threadId: sideChatId,
      messageId: MessageId.make("side-chat-busy-first-message"),
      text: "What is the main thread doing?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const started = yield* orchestrator.getThreadProjection(sideChatId);
    const [handoff] = started.contextHandoffs;
    assert.lengthOf(started.contextHandoffs, 1);
    assert.deepEqual(started.contextTransfers[0]?.resolution, {
      strategy: "portable_context",
      contextHandoffId: handoff!.id,
    });
    assert.include(handoff!.summaryText, "You are in a side chat beside the main thread.");
    // Inherited rows come first, so the cap truncates them first.
    assert.isAbove(
      handoff!.summaryText.indexOf("- User: PARENT_IMPORTED_MARKER"),
      handoff!.summaryText.indexOf("- User: GRANDPARENT_MARKER"),
    );
    assert.include(handoff!.summaryText, "- User: GRANDPARENT_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_ROLLED_BACK_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_QUEUED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_IMPORTED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_RUNNING_MARKER");
    assert.include(handoff!.summaryText, `t3_thread_read on thread ${parentId}`);
    assert.equal(
      started.messages.find((message) => message.role === "user")?.text,
      "What is the main thread doing?",
    );

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-busy-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("merge-back rejects a second fork's context until the first is consumed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("merge-back-guard-parent");
    const parentRunId = RunId.make("merge-back-guard-parent-run");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: parentRunId,
      ordinal: 1,
      status: "completed",
      text: "Parent work",
    });
    const forkAndRun = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`merge-back-guard-${name}`);
        const runId = RunId.make(`merge-back-guard-${name}-run`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`merge-back-guard-fork-${name}`),
          sourceThreadId: parentId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId: parentRunId },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* writeParentRun({ threadId, runId, ordinal: 1, status: "completed", text: name });
        return { threadId, runId };
      });
    const mergeBack = (commandId: string, fork: { threadId: ThreadId; runId: RunId }) =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: fork.threadId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: fork.runId },
        createdBy: "user",
        creationSource: "web",
      });
    const first = yield* forkAndRun("first");
    const second = yield* forkAndRun("second");

    yield* mergeBack("merge-back-guard-first", first);
    const refusedFresh = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("merge-back-guard-fresh-send"),
        threadId: parentId,
        messageId: MessageId.make("merge-back-guard-fresh-send"),
        text: "Start over",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        freshContext: true,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(
      String(refusedFresh.cause),
      "Send a message without /clear to apply the merged context first.",
    );
    const rejected = yield* mergeBack("merge-back-guard-second", second).pipe(Effect.flip);
    assert.include(String(rejected.cause), "pending context from another side chat or fork");
    yield* mergeBack("merge-back-guard-first-again", first);
    // That pending merge-back targets the parent, so it does not block one into `first`.
    const nested = { threadId: ThreadId.make("merge-back-guard-nested") };
    const nestedRunId = RunId.make("merge-back-guard-nested-run");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("merge-back-guard-fork-nested"),
      sourceThreadId: first.threadId,
      targetThreadId: nested.threadId,
      sourcePoint: { type: "run", runId: first.runId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeParentRun({
      threadId: nested.threadId,
      runId: nestedRunId,
      ordinal: 1,
      status: "completed",
      text: "nested",
    });
    yield* orchestrator.dispatch({
      type: "thread.merge_back",
      commandId: CommandId.make("merge-back-guard-nested"),
      sourceThreadId: nested.threadId,
      targetThreadId: first.threadId,
      sourcePoint: { type: "run", runId: nestedRunId },
      createdBy: "user",
      creationSource: "web",
    });

    const parent = yield* orchestrator.getThreadProjection(parentId);
    assert.deepEqual(
      parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => [transfer.sourceThreadId, transfer.status]),
      [
        [first.threadId, "superseded"],
        [first.threadId, "pending"],
      ],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

const runForkWithFailingNativeSource = (forkFailures: number) => {
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const modelSelection = { instanceId, model: "test-model" };
  const started = Deferred.makeUnsafe<ProviderAdapter.ProviderAdapterV2TurnInput>();
  let forkCalls = 0;
  const adapter = recordingForkAdapter(forkCases[1]!.adapter, {
    onStart: (turn) => Deferred.succeed(started, turn).pipe(Effect.asVoid),
    onFork: ({ sourceProviderThread }) =>
      ++forkCalls <= forkFailures
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver,
              providerThreadId: sourceProviderThread.id,
              cause:
                "Session not found: native-deleted-source; authorization=BearerSyntheticSecret",
            }),
          )
        : Effect.void,
  });
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("fork-missing-source");
    const targetThreadId = ThreadId.make("fork-missing-target");
    const providerThreadId = ProviderThreadId.make("fork-missing-native-thread");
    const sourceRunId = RunId.make("fork-missing-source-run");
    const userMessageId = MessageId.make("fork-missing-source-message");

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-missing-create-source"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-missing-project"),
      title: "Fork missing source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-missing-provider-thread"),
          type: "provider-thread.updated",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: sourceThreadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "native-deleted-source", strength: "strong" },
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
          id: EventId.make("fork-missing-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("fork-missing-user-item"),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("fork-missing-user-item"),
            threadId: sourceThreadId,
            runId: sourceRunId,
            nodeId: null,
            providerThreadId,
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
            messageId: userMessageId,
            text: "FORKED_SOURCE_MARKER",
            attachments: [],
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-missing-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fork-missing-continue"),
      threadId: targetThreadId,
      messageId: MessageId.make("fork-missing-continue"),
      text: "Continue the fork",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    // Run every start attempt so the last one runs with willRetry false.
    for (let attempt = 0; attempt < 5; attempt++) {
      yield* worker.drain();
      yield* TestClock.adjust("1 second");
    }

    const projection = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.deepEqual(
      projection.turnItems.flatMap((item) => (item.type === "error" ? [item.title] : [])),
      [],
    );
    assert.equal(projection.runs[0]?.status, "running");
    return { projection, turn: yield* Deferred.await(started), forkCalls };
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "fork-missing-native-source" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
      ),
    ),
  );
};

it.effect("a native fork whose source session is gone starts fresh with the source history", () =>
  Effect.gen(function* () {
    const { projection, turn } = yield* runForkWithFailingNativeSource(Number.POSITIVE_INFINITY);
    // Resolving the fork transfer stops later sends from retrying the native fork.
    assert.equal(projection.contextTransfers[0]?.status, "resolved_portable");
    assert.isNull(projection.providerThreads[0]?.forkedFrom);
    assert.include(JSON.stringify(turn), "FORKED_SOURCE_MARKER");
    const notices = projection.turnItems.flatMap((item) =>
      item.type === "system_notice" ? [item.message] : [],
    );
    assert.lengthOf(notices, 1);
    assert.include(notices[0], "Session not found: native-deleted-source");
    assert.notInclude(notices[0], "BearerSyntheticSecret");
  }),
);

it.effect("a native fork that fails before its last attempt still forks natively", () =>
  Effect.gen(function* () {
    const { projection, forkCalls } = yield* runForkWithFailingNativeSource(1);
    assert.equal(forkCalls, 2);
    assert.equal(projection.contextTransfers[0]?.status, "consumed");
    assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "native_fork");
  }),
);
