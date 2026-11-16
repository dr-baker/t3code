// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { describe, expect, it } from "vite-plus/test";
import { resolveAutoSnoozeUntil } from "./snoozePresets.ts";

describe("automatic snooze", () => {
  it.each([
    ["longest", "2026-11-10T15:00:00.000Z"],
    ["after:60", "2026-11-10T13:00:00.000Z"],
    ["after:999", "2026-11-10T15:00:00.000Z"],
    ["settle", undefined],
  ])("resolves %s from the configured presets", (selection, expected) => {
    expect(
      resolveAutoSnoozeUntil(
        [
          { kind: "after", minutes: 180 },
          { kind: "after", minutes: 60 },
        ],
        selection,
        new Date("2026-11-10T12:00:00.000Z"),
      ),
    ).toBe(expected);
  });

  it("falls back to one week when no preset is available", () => {
    const now = new Date(2026, 10, 10, 12);
    const expected = new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
    expect(resolveAutoSnoozeUntil([], "longest", now)).toBe(expected);
    expect(
      resolveAutoSnoozeUntil([{ kind: "at", day: "today", time: "09:00" }], "at:today:09:00", now),
    ).toBe(expected);
  });
});
