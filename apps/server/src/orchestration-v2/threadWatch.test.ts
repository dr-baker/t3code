import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId, THREAD_WATCH_LIMITS } from "@t3tools/contracts";
import { threadWatchChange, threadWatchWakePath } from "./threadWatch.ts";

it("carries acyclic watch chains, bounds them, and keeps ordinary monitor completions", () => {
  const [a, b, c, d] = [
    ThreadId.make("a"),
    ThreadId.make("b"),
    ThreadId.make("c"),
    ThreadId.make("d"),
  ] as const;
  const source = {
    kind: "monitor",
    threadWatch: { id: CommandId.make("watch"), threadId: b, causalThreadIds: [a, b, c] },
  } as const;
  expect(threadWatchWakePath(c, a, source)).toBeNull();
  expect(threadWatchWakePath(c, d, source)).toEqual([a, b, c, d]);
  expect(threadWatchWakePath(b, a, { kind: "monitor" })).toEqual([b, a]);
  expect(
    threadWatchWakePath(c, a, {
      kind: "monitor",
      threadWatch: { id: CommandId.make("legacy"), threadId: a },
    }),
  ).toBeNull();
  expect(
    threadWatchWakePath(c, d, {
      ...source,
      threadWatch: {
        ...source.threadWatch,
        causalThreadIds: Array.from({ length: THREAD_WATCH_LIMITS.causalHops }, (_, i) =>
          ThreadId.make(`hop-${i}`),
        ),
      },
    }),
  ).toBeNull();
});

describe("threadWatchChange", () => {
  it("reports terminal runs without treating queued, waiting or streaming work as completion", () => {
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
      expect(threadWatchChange({ type: "run.updated", payload: { status } })).not.toBeNull();
    }
    for (const status of ["queued", "preparing", "starting", "running", "waiting", "rolled_back"]) {
      expect(threadWatchChange({ type: "run.updated", payload: { status } })).toBeNull();
    }
    expect(threadWatchChange({ type: "message.delta", payload: {} })).toBeNull();
  });

  it("reports unanswered questions, approvals and secrets, but never their contents", () => {
    for (const kind of ["user_input", "command", "file-change"]) {
      expect(
        threadWatchChange({
          type: "runtime-request.updated",
          payload: { status: "pending", kind },
        }),
      ).toMatchObject({ ended: false });
      expect(
        threadWatchChange({
          type: "runtime-request.updated",
          payload: { status: "resolved", kind },
        }),
      ).toBeNull();
    }
    expect(
      threadWatchChange({
        type: "runtime-request.updated",
        payload: { status: "pending", kind: "dynamic_tool_call" },
      }),
    ).toBeNull();
    expect(
      threadWatchChange({
        type: "turn-item.updated",
        payload: { type: "secret_request", secretStatus: "pending", secret: "private" },
      }),
    ).toEqual({ text: "needs a secret", outcome: "updated", ended: false });
  });

  it("ends watches when their target is settled, archived or deleted", () => {
    for (const type of ["thread.settled", "thread.archived", "thread.deleted"]) {
      expect(threadWatchChange({ type, payload: {} })).toMatchObject({ ended: true });
    }
  });
});
