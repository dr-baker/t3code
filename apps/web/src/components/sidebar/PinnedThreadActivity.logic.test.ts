import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import {
  pinnedThreadNeedsAttention,
  resolvePinnedThreadStatus,
  summarizePinnedActivity,
} from "./PinnedThreadActivity.logic";
import {
  applySidebarThreadDrop,
  planSidebarThreadDrop,
  resolveSidebarThreadSection,
  sortPinnedThreadsForSidebar,
} from "../Sidebar.logic";

const visited = "2026-10-24T10:00:00Z";
const completed = "2026-10-24T10:05:00Z";
const runtime = {
  status: "running" as const,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  activeRunId: null,
  lastError: null,
  updatedAt: completed,
};
const latestRun = {
  runId: RunId.make("run"),
  status: "completed" as const,
  assistantMessageId: null,
  requestedAt: visited,
  startedAt: visited,
  completedAt: completed,
};

describe("pinned activity", () => {
  it.each(["done", "input", "approval", "failed", "plan", "woke"])(
    "keeps a pin with %s attention in the drawer when pop-outs are disabled",
    (status) => {
      const thread = makeThreadFixture({
        pinnedAt: visited,
        runtime: status === "failed" ? { ...runtime, status: "failed" } : null,
        latestRun: status === "done" ? latestRun : null,
        hasPendingUserInput: status === "input",
        hasPendingApprovals: status === "approval",
        hasActionableProposedPlan: status === "plan",
        interactionMode: status === "plan" ? "plan" : "default",
      });
      const pinnedNeedsAttention = pinnedThreadNeedsAttention(
        thread,
        visited,
        status === "woke" ? completed : null,
      );
      expect(pinnedNeedsAttention).toBe(true);
      const input = { pinned: true, snoozed: false, settled: false, pinnedNeedsAttention };
      expect(resolveSidebarThreadSection({ ...input, pinnedPopOutWhenReady: true })).toBe("active");
      expect(resolveSidebarThreadSection({ ...input, pinnedPopOutWhenReady: false })).toBe(
        "pinned",
      );
      expect(
        resolveSidebarThreadSection({ ...input, pinnedPopOutWhenReady: false, snoozed: true }),
      ).toBe("snoozed");
      expect(
        resolveSidebarThreadSection({ ...input, pinnedPopOutWhenReady: false, settled: true }),
      ).toBe("settled");
    },
  );

  it("surfaces attention states and returns to the same pin order when handled or running", () => {
    const pin = makeThreadFixture({
      id: ThreadId.make("middle"),
      pinnedAt: visited,
      pinOrderKey: "m",
      runtime,
    });
    const section = (thread: typeof pin, lastVisitedAt = visited) =>
      resolveSidebarThreadSection({
        snoozed: false,
        settled: false,
        pinned: thread.pinnedAt != null,
        pinnedNeedsAttention: pinnedThreadNeedsAttention(thread, lastVisitedAt, null),
      });
    expect(section(pin)).toBe("pinned");
    expect(section({ ...pin, hasPendingUserInput: true })).toBe("active");
    expect(section({ ...pin, pendingSubagentRequest: "approval" })).toBe("active");
    expect(section({ ...pin, hasPendingApprovals: true })).toBe("active");
    expect(section({ ...pin, runtime: { ...runtime, status: "failed" } })).toBe("active");
    expect(
      section({ ...pin, runtime: { ...runtime, status: "failed", lastErrorClass: "usage_limit" } }),
    ).toBe("active");
    const answer = { ...pin, latestRun, runtime: null };
    expect(section(answer)).toBe("active");
    expect(section(answer, completed)).toBe("pinned");
    expect(section({ ...answer, runtime })).toBe("pinned");
    expect(section({ ...pin, runtime: { ...runtime, status: "idle" } })).toBe("pinned");
    const returned = sortPinnedThreadsForSidebar([
      makeThreadFixture({ id: ThreadId.make("last"), pinnedAt: visited, pinOrderKey: "t" }),
      answer,
      makeThreadFixture({ id: ThreadId.make("first"), pinnedAt: visited, pinOrderKey: "b" }),
    ]);
    expect(returned.map((thread) => thread.id)).toEqual(["first", "middle", "last"]);
    expect(answer.pinOrderKey).toBe("m");
    expect(answer.pinnedAt).toBe(visited);
  });

  it("surfaces a ready plan but respects explicit Snoozed and Settled placement", () => {
    const plan = makeThreadFixture({
      pinnedAt: visited,
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestRun,
      runtime: { ...runtime, status: "idle" },
    });
    const attention = pinnedThreadNeedsAttention(plan, completed, null);
    expect(attention).toBe(true);
    expect(
      resolveSidebarThreadSection({
        pinned: true,
        pinnedNeedsAttention: attention,
        snoozed: true,
        settled: false,
      }),
    ).toBe("snoozed");
    expect(
      resolveSidebarThreadSection({
        pinned: true,
        pinnedNeedsAttention: attention,
        snoozed: false,
        settled: true,
      }),
    ).toBe("settled");
  });

  it("keeps a surfaced pin when reordering Active and does not let a drag dismiss attention", () => {
    const input = {
      activeKey: "pin",
      activeSection: "active" as const,
      activePinned: true,
      pinnedOrder: ["resting"],
      pinnedKeysById: new Map([
        ["resting", "b"],
        ["pin", "m"],
      ]),
      activeOrder: ["other", "pin"],
      activeKeysById: new Map([
        ["other", "b"],
        ["pin", "m"],
      ]),
    };
    expect(
      planSidebarThreadDrop({
        ...input,
        target: {
          section: "active",
          pinnedOrder: ["resting"],
          activeOrder: ["pin", "other"],
        },
      }),
    ).toMatchObject({ kind: "move-active", unpin: false });
    expect(
      planSidebarThreadDrop({
        ...input,
        target: {
          section: "pinned",
          pinnedOrder: ["pin", "resting"],
          activeOrder: ["other"],
        },
      }),
    ).toEqual({ kind: "none" });
    const thread = makeThreadFixture({
      pinnedAt: visited,
      pinOrderKey: "m",
      hasPendingUserInput: true,
    });
    expect(applySidebarThreadDrop(thread, "active", completed, "a", true)).toMatchObject({
      pinnedAt: visited,
      pinOrderKey: "m",
      activeOrderKey: "a",
    });
  });
  it("counts each thread once, with actionable states before unread answers and work", () => {
    expect(
      summarizePinnedActivity([
        "working",
        null,
        "done",
        "input",
        "approval",
        "done",
        "failed",
        "working",
        "limited",
        "woke",
        "waiting",
      ]),
    ).toEqual([
      { kind: "input", count: 1 },
      { kind: "approval", count: 1 },
      { kind: "failed", count: 1 },
      { kind: "limited", count: 1 },
      { kind: "woke", count: 1 },
      { kind: "done", count: 2 },
      { kind: "working", count: 2 },
      { kind: "waiting", count: 1 },
    ]);
    expect(summarizePinnedActivity([null, null])).toEqual([]);
  });

  it("counts a pending question instead of its running or completed state", () => {
    const question = makeThreadFixture({ runtime, latestRun, hasPendingUserInput: true });
    expect(resolvePinnedThreadStatus(question, visited, null)).toBe("input");
    expect(
      resolvePinnedThreadStatus({ ...question, hasPendingApprovals: true }, visited, null),
    ).toBe("approval");
    expect(
      resolvePinnedThreadStatus({ ...question, hasPendingUserInput: false }, visited, null),
    ).toBe("working");
  });

  it("clears an unread completion when visited and distinguishes a snooze wake", () => {
    const thread = makeThreadFixture({ runtime: null, latestRun });
    expect(resolvePinnedThreadStatus(thread, visited, null)).toBe("done");
    expect(resolvePinnedThreadStatus(thread, completed, null)).toBeNull();
    expect(resolvePinnedThreadStatus(thread, visited, completed)).toBe("woke");
    expect(resolvePinnedThreadStatus(thread, completed, completed)).toBeNull();
    expect(resolvePinnedThreadStatus(thread, visited, "invalid")).toBe("done");
  });
});
