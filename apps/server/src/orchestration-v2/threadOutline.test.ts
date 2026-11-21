import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  formatOversightOutlineDelta,
  formatTurnItemOutline,
  isOversightCommentaryItem,
  isOversightCountedStep,
} from "./threadOutline.ts";

const now = DateTime.makeUnsafe("2026-11-21T10:00:00Z");
const base = {
  id: TurnItemId.make("item-1"),
  threadId: ThreadId.make("child-1"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: NonNegativeInt.make(1),
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
} as const;

describe("threadOutline", () => {
  it("strips bulky diffs and successful command stdout while keeping reasoning, commentary, and failure tails", () => {
    const fileChange: OrchestrationV2TurnItem = {
      ...base,
      type: "file_change",
      status: "completed",
      fileName: "src/app.ts",
      additions: NonNegativeInt.make(12),
      deletions: NonNegativeInt.make(4),
      diffStr: "HUGE DIFF CONTENT THAT SHOULD NOT APPEAR",
    };
    expect(formatTurnItemOutline(fileChange)).toBe("src/app.ts (+12 -4)");

    const okCommand: OrchestrationV2TurnItem = {
      ...base,
      type: "command_execution",
      status: "completed",
      input: "pnpm test",
      output: "40KB OF PASSING TEST LOGS",
    };
    expect(formatTurnItemOutline(okCommand)).toBe("$ pnpm test [completed]");

    const failedCommand: OrchestrationV2TurnItem = {
      ...base,
      type: "command_execution",
      status: "failed",
      input: "pnpm test",
      output: "AssertionError: expected 1 to equal 2",
    };
    expect(formatTurnItemOutline(failedCommand)).toBe(
      "$ pnpm test [failed]\nAssertionError: expected 1 to equal 2",
    );

    const commentary: OrchestrationV2TurnItem = {
      ...base,
      type: "assistant_message",
      phase: "commentary",
      messageId: MessageId.make("msg-1"),
      status: "completed",
      text: "Checked git log; the auth guard relies on cookie flags.",
      streaming: false,
    };
    expect(formatTurnItemOutline(commentary)).toBe(
      "[commentary] Checked git log; the auth guard relies on cookie flags.",
    );
    expect(isOversightCommentaryItem(commentary, true)).toBe(true);
    expect(isOversightCountedStep(commentary)).toBe(true);
  });

  it("ignores streaming items and formats bounded inline delta lines with item ids", () => {
    const streamingCommentary: OrchestrationV2TurnItem = {
      ...base,
      type: "assistant_message",
      phase: "commentary",
      messageId: MessageId.make("msg-2"),
      status: "running",
      text: "partial...",
      streaming: true,
    };
    expect(isOversightCommentaryItem(streamingCommentary, true)).toBe(false);
    expect(isOversightCountedStep(streamingCommentary)).toBe(false);

    const rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 1,
        visibility: "local",
        sourceThreadId: ThreadId.make("child-1"),
        sourceItemId: TurnItemId.make("item-a"),
        item: {
          ...base,
          id: TurnItemId.make("item-a"),
          type: "reasoning",
          status: "completed",
          text: "Need to verify cache invalidation path.",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: ThreadId.make("child-1"),
        sourceItemId: TurnItemId.make("item-b"),
        item: {
          ...base,
          id: TurnItemId.make("item-b"),
          type: "file_change",
          status: "completed",
          fileName: "src/cache.ts",
          additions: NonNegativeInt.make(3),
          deletions: NonNegativeInt.make(1),
          diffStr: "diff body",
        },
      },
    ];
    const delta = formatOversightOutlineDelta(rows);
    expect(delta).toContain("[item-a] (reasoning) Need to verify cache invalidation path.");
    expect(delta).toContain("[item-b] (file_change) src/cache.ts (+3 -1)");
    expect(delta).not.toContain("diff body");
  });
});
