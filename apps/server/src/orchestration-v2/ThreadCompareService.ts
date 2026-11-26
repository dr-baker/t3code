import {
  CommandId,
  MessageId,
  OrchestrationV2StartCompareError,
  ThreadId,
  isActiveCompareHost,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2StartCompareFailure,
  type OrchestrationV2StartCompareInput,
  type OrchestrationV2StartCompareResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { isForkableSourceRunStatus, forkableSourceRunStatusError } from "./ThreadForkService.ts";

const inFlightCompareByCommandId = new Map<
  CommandId,
  Deferred.Deferred<OrchestrationV2StartCompareResult, OrchestrationV2StartCompareError>
>();
const hostCompareLocks = new Map<
  ThreadId,
  { readonly semaphore: Semaphore.Semaphore; waiters: number }
>();

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

const hashCommandKey = (commandId: CommandId): string => {
  // Deterministic 128-bit FNV-1a pair across the full commandId (zero truncation collisions).
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < commandId.length; i += 1) {
    const code = BigInt(commandId.charCodeAt(i));
    h1 = ((h1 ^ code) * 0x100000001b3n) & mask;
    h2 = ((h2 ^ (code + BigInt(i + 1))) * 0x100000001b3n) & mask;
  }
  return `${h1.toString(16).padStart(16, "0")}${h2.toString(16).padStart(16, "0")}`.slice(0, 24);
};

const isActiveRunStatus = (status: OrchestrationV2Run["status"]): boolean =>
  status === "preparing" ||
  status === "queued" ||
  status === "starting" ||
  status === "running" ||
  status === "waiting";

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

  const failCompare = (
    message: string,
    options?: { readonly cause?: unknown; readonly rolledBack?: boolean },
  ) =>
    new OrchestrationV2StartCompareError({
      commandId: input.commandId,
      message,
      ...(options?.rolledBack ? { rolledBack: true } : {}),
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
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
      .pipe(
        Effect.mapError((cause) => failCompare(errorMessageOf(cause), { cause, rolledBack: true })),
      );

    const hostThreadId =
      input.hostThreadId ?? ThreadId.make(`compare:${hashCommandKey(input.commandId)}`);
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
      .pipe(
        Effect.mapError((cause) => failCompare(errorMessageOf(cause), { cause, rolledBack: true })),
      );

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
        { rolledBack: true },
      );
    }

    return { hostThreadId, contenderThreadIds, failed } satisfies OrchestrationV2StartCompareResult;
  }

  // mode: "fork" — mid-thread compare branched from a finished run on the host thread.
  const hostRecords = yield* threads
    .getThreadRecords(input.hostThreadId, ["runs", "runtimeRequests"])
    .pipe(
      Effect.mapError((cause) => failCompare(errorMessageOf(cause), { cause, rolledBack: true })),
    );
  const host = hostRecords.thread;
  if (host.deletedAt !== null || host.archivedAt !== null) {
    return yield* failCompare("Compare requires an active host thread.", { rolledBack: true });
  }
  if (
    host.lineage.sideChat === true ||
    host.lineage.compare === true ||
    host.lineage.relationshipToParent === "subagent" ||
    host.delegatedFrom !== undefined
  ) {
    return yield* failCompare("Compare cannot be started from a nested thread.", {
      rolledBack: true,
    });
  }
  const forkBatchKey = hashCommandKey(input.commandId);
  const forkBatchPrefix = `${input.hostThreadId}:cmp:${forkBatchKey}:`;
  const activeHostCompare = isActiveCompareHost(host) ? host.compare : null;
  const isResumingSameBatch =
    activeHostCompare != null &&
    activeHostCompare.contenderThreadIds.every((id) => id.startsWith(forkBatchPrefix));
  if (activeHostCompare != null && !isResumingSameBatch) {
    return yield* failCompare("This thread already has an active model comparison.", {
      rolledBack: true,
    });
  }
  if (!isResumingSameBatch) {
    if (hostRecords.runs.some((run) => isActiveRunStatus(run.status))) {
      return yield* failCompare(
        "Wait for active or queued runs on this thread to finish before starting a comparison.",
        { rolledBack: true },
      );
    }
    if (hostRecords.runtimeRequests.some((request) => request.status === "pending")) {
      return yield* failCompare(
        "Resolve pending approvals or questions on this thread before starting a comparison.",
        { rolledBack: true },
      );
    }
  }
  const sourceRun = hostRecords.runs.find((run) => run.id === input.sourceRunId);
  if (!sourceRun) {
    return yield* failCompare("The selected turn could not be found.", { rolledBack: true });
  }
  if (!isForkableSourceRunStatus(sourceRun.status)) {
    return yield* failCompare(forkableSourceRunStatusError(sourceRun), { rolledBack: true });
  }

  yield* launches
    .checkWorktreeBase({
      commandId: input.commandId,
      projectId: host.projectId,
      workspaceStrategy: input.workspaceStrategy,
    })
    .pipe(
      Effect.mapError((cause) => failCompare(errorMessageOf(cause), { cause, rolledBack: true })),
    );
  const clearWorktree =
    input.workspaceStrategy.type === "worktree" ||
    (input.workspaceStrategy.type === "root" && host.worktreePath !== null);
  const pendingWorkspacePreparation = input.workspaceStrategy.type === "worktree";
  const needsLaunch =
    input.initialMessage !== undefined ||
    input.workspaceStrategy.type === "worktree" ||
    (input.workspaceStrategy.type === "existing_worktree" &&
      host.worktreePath !== input.workspaceStrategy.worktreePath) ||
    (input.workspaceStrategy.type === "root" && host.worktreePath !== null);

  const { contenderThreadIds, failed } = yield* fanOutContenders(input.contenders, (spec, index) =>
    Effect.gen(function* () {
      const contenderId = ThreadId.make(`${forkBatchPrefix}${index + 1}`);
      const contenderTitle = contenderLabel(host.title, spec.modelSelection.model);
      const existingContender = yield* threads.getThreadRecords(contenderId, []).pipe(
        Effect.map((records) => records.thread),
        Effect.orElseSucceed(() => null),
      );
      if (existingContender === null) {
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
          ...(pendingWorkspacePreparation ? { pendingWorkspacePreparation: true } : {}),
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
      } else if (existingContender.deletedAt !== null) {
        return yield* failCompare("The forked contender was previously deleted.");
      }

      if (needsLaunch) {
        const initialMessage = buildInitialMessage(index, spec.text, input.initialMessage);
        const blankWorkspaceAlreadyReady =
          initialMessage === undefined &&
          existingContender !== null &&
          existingContender.pendingWorkspacePreparation !== true &&
          (input.workspaceStrategy.type !== "worktree" || existingContender.worktreePath !== null);
        if (!blankWorkspaceAlreadyReady) {
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
      }
      return contenderId;
    }),
  );

  if (contenderThreadIds.length === 0) {
    return yield* failCompare(failed[0]?.error ?? "None of the selected models could be forked.", {
      rolledBack: true,
    });
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
      : (input.hostThreadId ?? ThreadId.make(`compare:${hashCommandKey(input.commandId)}`));

  return yield* withHostCompareLock(lockTarget, executeStartCompare(input)).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (inFlightCompareByCommandId.get(input.commandId) === deferred) {
          inFlightCompareByCommandId.delete(input.commandId);
        }
        yield* Deferred.done(deferred, exit);
      }),
    ),
  );
});
