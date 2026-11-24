import {
  CommandId,
  MessageId,
  OrchestrationV2StartCompareError,
  ThreadId,
  isActiveCompareHost,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2StartCompareFailure,
  type OrchestrationV2StartCompareInput,
  type OrchestrationV2StartCompareResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { isForkableSourceRunStatus, forkableSourceRunStatusError } from "./ThreadForkService.ts";

const MAX_CACHED_COMPARE_RESULTS = 256;
const completedCompareResults = new Map<CommandId, OrchestrationV2StartCompareResult>();
const inFlightCompareByCommandId = new Map<
  CommandId,
  Deferred.Deferred<OrchestrationV2StartCompareResult, OrchestrationV2StartCompareError>
>();
const hostCompareLocks = new Map<
  ThreadId,
  { readonly semaphore: Semaphore.Semaphore; waiters: number }
>();

const rememberCompareResult = (
  commandId: CommandId,
  result: OrchestrationV2StartCompareResult,
): void => {
  if (completedCompareResults.has(commandId)) {
    completedCompareResults.delete(commandId);
  } else if (completedCompareResults.size >= MAX_CACHED_COMPARE_RESULTS) {
    const oldest = completedCompareResults.keys().next().value;
    if (oldest !== undefined) completedCompareResults.delete(oldest);
  }
  completedCompareResults.set(commandId, result);
};

const withHostCompareLock = <A, E, R>(
  hostThreadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const existing = hostCompareLocks.get(hostThreadId);
      if (existing) {
        existing.waiters += 1;
        return existing;
      }
      const created = { semaphore: Semaphore.makeUnsafe(1), waiters: 1 };
      hostCompareLocks.set(hostThreadId, created);
      return created;
    }),
    (entry) => entry.semaphore.withPermits(1)(effect),
    (entry) =>
      Effect.sync(() => {
        entry.waiters -= 1;
        if (entry.waiters <= 0 && hostCompareLocks.get(hostThreadId) === entry) {
          hostCompareLocks.delete(hostThreadId);
        }
      }),
  );

const errorMessageOf = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof (error as { cause?: unknown }).cause === "string"
  ) {
    return (error as { cause: string }).cause;
  }
  return "Failed to start contender.";
};

const shortKey = (commandId: CommandId): string =>
  commandId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-12) || "cmp";

const contenderLabel = (baseTitle: string, model: string): string => `${baseTitle} · ${model}`;

const fanOutContenders = <S extends { readonly modelSelection: ModelSelection }, E, R>(
  contenders: ReadonlyArray<S>,
  runOne: (spec: S, index: number) => Effect.Effect<ThreadId, E, R>,
) =>
  Effect.forEach(
    contenders,
    (spec, index) =>
      runOne(spec, index).pipe(
        Effect.map((threadId) => ({ ok: true as const, threadId })),
        Effect.catch((cause) =>
          Effect.succeed({
            ok: false as const,
            failure: {
              modelSelection: spec.modelSelection,
              error: errorMessageOf(cause),
            } satisfies OrchestrationV2StartCompareFailure,
          }),
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((outcomes) => {
      const contenderThreadIds: Array<ThreadId> = [];
      const failed: Array<OrchestrationV2StartCompareFailure> = [];
      for (const outcome of outcomes) {
        if (outcome.ok) contenderThreadIds.push(outcome.threadId);
        else failed.push(outcome.failure);
      }
      return { contenderThreadIds, failed };
    }),
  );

const executeStartCompare = Effect.fn("ThreadCompareService.executeStartCompare")(function* (
  input: OrchestrationV2StartCompareInput & {
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
  },
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;

  const failCompare = (message: string, cause?: unknown) =>
    new OrchestrationV2StartCompareError({
      commandId: input.commandId,
      message,
      ...(cause === undefined ? {} : { cause }),
    });

  const buildInitialMessage = (
    index: number,
    specText: string | undefined,
    baseMessage: typeof input.initialMessage,
  ) =>
    baseMessage === undefined
      ? undefined
      : {
          messageId: MessageId.make(`${input.commandId}:c:${index + 1}:msg`),
          text: specText ?? baseMessage.text,
          attachments: baseMessage.attachments,
          ...(baseMessage.context === undefined ? {} : { context: baseMessage.context }),
        };

  if (input.mode === "new") {
    yield* launches
      .checkWorktreeBase({
        commandId: input.commandId,
        projectId: input.projectId,
        workspaceStrategy: input.workspaceStrategy,
      })
      .pipe(Effect.mapError((cause) => failCompare(errorMessageOf(cause), cause)));

    const hostThreadId =
      input.hostThreadId ?? ThreadId.make(`compare:${shortKey(input.commandId)}`);
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${input.commandId}:host`),
        threadId: hostThreadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.contenders[0]!.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch:
          input.workspaceStrategy.type === "worktree"
            ? input.workspaceStrategy.baseRef
            : (input.workspaceStrategy.branch ?? null),
        worktreePath:
          input.workspaceStrategy.type === "existing_worktree"
            ? input.workspaceStrategy.worktreePath
            : null,
        compare: { contenderThreadIds: [], sourceRunId: null, selectedWinnerThreadId: null },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      })
      .pipe(Effect.mapError((cause) => failCompare(errorMessageOf(cause), cause)));

    const { contenderThreadIds, failed } = yield* fanOutContenders(
      input.contenders,
      (spec, index) =>
        ThreadMessageIntake.launchThread({
          commandId: CommandId.make(`${input.commandId}:c:${index + 1}`),
          threadId: ThreadId.make(`${hostThreadId}:c${index + 1}`),
          compareParentThreadId: hostThreadId,
          projectId: input.projectId,
          title: contenderLabel(input.title, spec.modelSelection.model),
          generateTitle: false,
          modelSelection: spec.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: input.workspaceStrategy,
          initialMessage: buildInitialMessage(index, spec.text, input.initialMessage)!,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        }).pipe(Effect.map((result) => result.threadId)),
    );

    if (contenderThreadIds.length === 0) {
      yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`${input.commandId}:host:cleanup`),
          threadId: hostThreadId,
          onlyIfUnused: true,
        })
        .pipe(Effect.ignore);
      return yield* failCompare(
        failed[0]?.error ?? "None of the selected models could be started.",
      );
    }

    return { hostThreadId, contenderThreadIds, failed } satisfies OrchestrationV2StartCompareResult;
  }

  // mode: "fork" — mid-thread compare branched from a finished run on the host thread.
  const hostProjection = yield* threads
    .getThreadProjection(input.hostThreadId)
    .pipe(Effect.mapError((cause) => failCompare(errorMessageOf(cause), cause)));
  const host = hostProjection.thread;
  if (host.deletedAt !== null || host.archivedAt !== null) {
    return yield* failCompare("Compare requires an active host thread.");
  }
  if (
    host.lineage.sideChat === true ||
    host.lineage.compare === true ||
    host.lineage.relationshipToParent === "subagent" ||
    host.delegatedFrom !== undefined
  ) {
    return yield* failCompare("Compare cannot be started from a nested thread.");
  }
  const forkBatchKey = shortKey(input.commandId);
  const forkBatchPrefix = `${input.hostThreadId}:cmp:${forkBatchKey}:`;
  if (isActiveCompareHost(host)) {
    const existingBatch = host.compare!.contenderThreadIds.filter((id) =>
      id.startsWith(forkBatchPrefix),
    );
    if (existingBatch.length > 0) {
      return {
        hostThreadId: input.hostThreadId,
        contenderThreadIds: existingBatch,
        failed: [],
      } satisfies OrchestrationV2StartCompareResult;
    }
    return yield* failCompare("This thread already has an active model comparison.");
  }
  if (hostProjection.runtimeRequests.some((request) => request.status === "pending")) {
    return yield* failCompare(
      "Resolve pending approvals or questions on this thread before starting a comparison.",
    );
  }
  const sourceRun = hostProjection.runs.find((run) => run.id === input.sourceRunId);
  if (!sourceRun) {
    return yield* failCompare("The selected turn could not be found.");
  }
  if (!isForkableSourceRunStatus(sourceRun.status)) {
    return yield* failCompare(forkableSourceRunStatusError(sourceRun));
  }

  yield* launches
    .checkWorktreeBase({
      commandId: input.commandId,
      projectId: host.projectId,
      workspaceStrategy: input.workspaceStrategy,
    })
    .pipe(Effect.mapError((cause) => failCompare(errorMessageOf(cause), cause)));
  const clearWorktree =
    input.workspaceStrategy.type === "worktree" ||
    (input.workspaceStrategy.type === "root" && host.worktreePath !== null);
  const needsLaunch =
    input.initialMessage !== undefined ||
    input.workspaceStrategy.type === "worktree" ||
    (input.workspaceStrategy.type === "existing_worktree" &&
      host.worktreePath !== input.workspaceStrategy.worktreePath) ||
    (input.workspaceStrategy.type === "root" && host.worktreePath !== null);

  const { contenderThreadIds, failed } = yield* fanOutContenders(input.contenders, (spec, index) =>
    Effect.gen(function* () {
      const contenderId = ThreadId.make(`${input.hostThreadId}:cmp:${forkBatchKey}:${index + 1}`);
      const contenderTitle = contenderLabel(host.title, spec.modelSelection.model);
      yield* threads.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`${input.commandId}:fork:${index + 1}`),
        sourceThreadId: input.hostThreadId,
        targetThreadId: contenderId,
        sourcePoint: { type: "run", runId: input.sourceRunId },
        title: contenderTitle,
        compare: true,
        modelSelection: spec.modelSelection,
        clearWorktree,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      if (needsLaunch) {
        const initialMessage = buildInitialMessage(index, spec.text, input.initialMessage);
        yield* ThreadMessageIntake.launchThread({
          commandId: CommandId.make(`${input.commandId}:launch:${index + 1}`),
          threadId: contenderId,
          reuseExistingThread: true,
          projectId: host.projectId,
          title: contenderTitle,
          generateTitle: false,
          modelSelection: spec.modelSelection,
          runtimeMode: host.runtimeMode,
          interactionMode: host.interactionMode,
          workspaceStrategy: input.workspaceStrategy,
          awaitWorkspacePreparation: initialMessage === undefined,
          ...(initialMessage === undefined ? {} : { initialMessage }),
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        }).pipe(
          Effect.tapError(() =>
            threads
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`${input.commandId}:fork-cleanup:${index + 1}`),
                threadId: contenderId,
                onlyIfUnused: true,
              })
              .pipe(Effect.ignore),
          ),
        );
      }
      return contenderId;
    }),
  );

  if (contenderThreadIds.length === 0) {
    return yield* failCompare(failed[0]?.error ?? "None of the selected models could be forked.");
  }

  return {
    hostThreadId: input.hostThreadId,
    contenderThreadIds,
    failed,
  } satisfies OrchestrationV2StartCompareResult;
});

export const startCompare = Effect.fn("ThreadCompareService.startCompare")(function* (
  input: OrchestrationV2StartCompareInput & {
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
  },
) {
  const cached = completedCompareResults.get(input.commandId);
  if (cached !== undefined) return cached;
  const existing = inFlightCompareByCommandId.get(input.commandId);
  if (existing !== undefined) return yield* Deferred.await(existing);

  const deferred = yield* Deferred.make<
    OrchestrationV2StartCompareResult,
    OrchestrationV2StartCompareError
  >();
  inFlightCompareByCommandId.set(input.commandId, deferred);

  const lockTarget =
    input.mode === "fork"
      ? input.hostThreadId
      : (input.hostThreadId ?? ThreadId.make(`compare:${shortKey(input.commandId)}`));

  return yield* withHostCompareLock(lockTarget, executeStartCompare(input)).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (inFlightCompareByCommandId.get(input.commandId) === deferred) {
          inFlightCompareByCommandId.delete(input.commandId);
        }
        if (Exit.isSuccess(exit)) rememberCompareResult(input.commandId, exit.value);
        yield* Deferred.done(deferred, exit);
      }),
    ),
  );
});
