import {
  ProviderRequestKind,
  THREAD_WATCH_LIMITS,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2NotificationSource,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  isThreadWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import * as Schema from "effect/Schema";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isApproval = Schema.is(ProviderRequestKind);

export function threadWatchWakePath(
  targetId: ThreadId,
  ownerId: ThreadId,
  source?: OrchestrationV2NotificationSource,
) {
  const stamp = source?.kind === "monitor" ? source.threadWatch : undefined;
  const path = [
    ...new Set([
      ...(stamp?.causalThreadIds ?? (stamp === undefined ? [] : [stamp.threadId])),
      targetId,
    ]),
  ];
  return path.includes(ownerId) || path.length >= THREAD_WATCH_LIMITS.causalHops
    ? null
    : [...path, ownerId];
}

export function threadWatchHasPendingWork(
  target: Pick<
    OrchestrationV2ThreadShell,
    "activeRunId" | "activityRunStatus" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
  > | null,
) {
  return (
    target !== null &&
    (target.activeRunId !== null ||
      target.activityRunStatus != null ||
      target.pendingRuntimeRequest !== null ||
      backgroundWorkHoldsCompletion(
        (target.pendingBackgroundTasks ?? []).filter((task) => !isThreadWatchTask(task)),
      ))
  );
}

export function threadWatchChange(event: { readonly type: string; readonly payload: unknown }): {
  readonly text: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "updated";
  readonly ended: boolean;
} | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  switch (event.type) {
    case "run.updated":
      switch (payload.status) {
        case "completed":
          return { text: "finished a turn", outcome: "completed", ended: false };
        case "failed":
          return { text: "failed", outcome: "failed", ended: false };
        case "interrupted":
        case "cancelled":
          return { text: "was stopped", outcome: "cancelled", ended: false };
        default:
          return null;
      }
    case "runtime-request.updated":
      if (payload.status !== "pending") return null;
      if (payload.kind === "user_input")
        return { text: "has a question", outcome: "updated", ended: false };
      if (isApproval(payload.kind))
        return { text: "needs approval", outcome: "updated", ended: false };
      return null;
    case "turn-item.updated":
      return payload.type === "secret_request" && payload.secretStatus === "pending"
        ? { text: "needs a secret", outcome: "updated", ended: false }
        : null;
    case "thread.settled":
      return { text: "was settled", outcome: "completed", ended: true };
    case "thread.archived":
      return { text: "was archived", outcome: "completed", ended: true };
    case "thread.deleted":
      return { text: "was deleted", outcome: "completed", ended: true };
    default:
      return null;
  }
}
