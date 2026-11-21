import { describe, expect, it } from "vite-plus/test";
import {
  formatQuietWatchCheckInLabel,
  formatWatchOversightCadence,
  parseQuietWatchCheckIn,
} from "./threadWatchOversight.ts";

describe("threadWatchOversight", () => {
  it("parses leading quiet check-in tokens with or without a one-line note", () => {
    expect(parseQuietWatchCheckIn("[watch:ok]")).toEqual({ note: null });
    expect(parseQuietWatchCheckIn("  [WATCH:OK] — exploring auth middleware\nmore detail")).toEqual(
      {
        note: "exploring auth middleware",
      },
    );
    expect(parseQuietWatchCheckIn("[watch:ok]: tests passing so far")).toEqual({
      note: "tests passing so far",
    });
    expect(parseQuietWatchCheckIn("[watch:okay]")).toBeNull();
    expect(parseQuietWatchCheckIn("Astra needs a decision on auth scope.")).toBeNull();
  });

  it("formats compact fold labels and oversight cadence strings", () => {
    expect(formatQuietWatchCheckInLabel({ note: null, summary: null })).toBe(
      "Checked in · on track",
    );
    expect(formatQuietWatchCheckInLabel({ note: "on track", summary: "ignored" })).toBe(
      "Checked in · on track",
    );
    expect(formatWatchOversightCadence({ everyItems: 20, everySeconds: 300 })).toBe(
      "Oversight · 20 items / 5m",
    );
    expect(formatWatchOversightCadence({ everyItems: 10, everySeconds: 90 })).toBe(
      "Oversight · 10 items / 90s",
    );
  });
});
