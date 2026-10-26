import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  isSidebarThreadWorking,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";

export function resolvePinnedThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
  wokeAt: string | null,
) {
  const visited = lastVisitedAt === undefined ? Number.NaN : Date.parse(lastVisitedAt);
  const woke = wokeAt === null ? Number.NaN : Date.parse(wokeAt);
  return resolveSidebarV2TopStatus({
    status: resolveSidebarThreadStatus(thread),
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
    isWoke:
      Number.isFinite(woke) &&
      (!Number.isFinite(visited) || visited < woke) &&
      thread.settledOverride !== "settled",
  });
}

export function pinnedThreadNeedsAttention(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
  wokeAt: string | null,
) {
  const status = resolvePinnedThreadStatus(thread, lastVisitedAt, wokeAt);
  return (
    (status !== null && status !== "working" && status !== "waiting") ||
    (thread.hasActionableProposedPlan && !isSidebarThreadWorking(thread))
  );
}

const PRIORITY = [
  "input",
  "approval",
  "request",
  "failed",
  "limited",
  "woke",
  "done",
  "working",
  "waiting",
] as const satisfies readonly SidebarV2TopStatusKind[];

export function summarizePinnedActivity(statuses: readonly (SidebarV2TopStatusKind | null)[]) {
  const counts = new Map<SidebarV2TopStatusKind, number>();
  for (const status of statuses) {
    if (status !== null) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return PRIORITY.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count > 0 ? [{ kind, count }] : [];
  });
}
