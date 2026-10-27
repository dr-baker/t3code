import { type OrchestrationV2ThreadProjection, type RunId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

export function modelCapacityRecoveryDeadline(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "turnItems" | "providerThreads" | "runtimeRequests"
  >,
  runId: RunId,
): number | null {
  const run = latestExecutedRun(projection.runs);
  if (
    run?.id !== runId ||
    run.status !== "failed" ||
    run.completedAt === null ||
    run.capacityContinuationOfRunId !== undefined
  )
    return null;
  const failure = latestRootProviderFailure(run, projection.turnItems);
  if (
    failure?.class !== "provider_error" ||
    failure.code !== "serverOverloaded" ||
    failure.message !== "Selected model is at capacity. Please try a different model." ||
    projection.providerThreads.find((thread) => thread.id === run.providerThreadId)?.driver !==
      "codex" ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled" ||
    projection.thread.snoozedUntil != null ||
    !modelSelectionsEqual(projection.thread.modelSelection, run.modelSelection) ||
    projection.runs.some(
      (candidate) =>
        candidate.id !== runId &&
        (candidate.status === "queued" ||
          candidate.status === "preparing" ||
          candidate.status === "starting" ||
          candidate.status === "running" ||
          candidate.status === "waiting"),
    ) ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  )
    return null;
  return DateTime.toEpochMillis(run.completedAt) + 10 * 60_000;
}
