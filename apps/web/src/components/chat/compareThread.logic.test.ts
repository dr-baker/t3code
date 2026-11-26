import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultCompareSelections,
  isBroadcastSubmitShortcut,
  resolveFocusedContenderId,
  selectionKey,
} from "./compareThread.logic";

const makeProvider = (instanceId: string, models: ReadonlyArray<string>): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    status: "ready",
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
  }) as unknown as ServerProvider;

describe("compareThread.logic", () => {
  it("resolves focused contender falling back to the first live contender", () => {
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    expect(resolveFocusedContenderId([], null)).toBeNull();
    expect(resolveFocusedContenderId([a, b], null)).toBe(a);
    expect(resolveFocusedContenderId([a, b], b)).toBe(b);
    expect(resolveFocusedContenderId([a], b)).toBe(a);
  });

  it("matches platform-specific broadcast shortcut Cmd/Ctrl+Shift+Enter", () => {
    expect(
      isBroadcastSubmitShortcut(
        { key: "Enter", shiftKey: true, metaKey: true, ctrlKey: false, altKey: false },
        true,
      ),
    ).toBe(true);
    expect(
      isBroadcastSubmitShortcut(
        { key: "Enter", shiftKey: true, metaKey: false, ctrlKey: true, altKey: false },
        false,
      ),
    ).toBe(true);
    expect(
      isBroadcastSubmitShortcut(
        { key: "Enter", shiftKey: false, metaKey: true, ctrlKey: false, altKey: false },
        true,
      ),
    ).toBe(false);
    expect(
      isBroadcastSubmitShortcut(
        { key: "Enter", shiftKey: true, metaKey: true, ctrlKey: false, altKey: true },
        true,
      ),
    ).toBe(false);
  });

  it("picks unique default compare selections starting with the current model", () => {
    const p1 = makeProvider("codex", ["gpt-5", "gpt-5-mini"]);
    const p2 = makeProvider("claude", ["claude-sonnet", "claude-haiku"]);
    const current = { instanceId: p1.instanceId, model: "gpt-5" };
    const picked = defaultCompareSelections({
      providers: [p1, p2],
      currentSelection: current,
      maxDefaults: 3,
    });
    expect(picked.map(selectionKey)).toEqual([
      `${p1.instanceId}::gpt-5::`,
      `${p2.instanceId}::claude-sonnet::`,
      `${p1.instanceId}::gpt-5-mini::`,
    ]);
  });

  it("keeps Replay (dev) threads on Replay scenarios by default", () => {
    const codex = makeProvider("codex", ["gpt-6.2-sol"]);
    const replay = makeProvider("devReplay", ["showcase", "plan-reads", "command-output"]);
    const picked = defaultCompareSelections({
      providers: [codex, replay],
      currentSelection: { instanceId: replay.instanceId, model: "showcase" },
      maxDefaults: 3,
    });
    expect(picked.map(selectionKey)).toEqual([
      `${replay.instanceId}::showcase::`,
      `${replay.instanceId}::plan-reads::`,
      `${replay.instanceId}::command-output::`,
    ]);
  });
});
