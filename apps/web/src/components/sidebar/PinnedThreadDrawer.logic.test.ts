import { describe, expect, it } from "vite-plus/test";
import { pinnedDrawerPreview } from "./PinnedThreadDrawer.logic";

const threads = [
  { key: "oldest", updatedAt: "2026-10-20T00:00:00Z" },
  { key: "newest", updatedAt: "2026-10-23T00:00:00Z" },
  { key: "middle", updatedAt: "2026-10-22T00:00:00Z" },
];

describe("pinned drawer preview", () => {
  it("fills one row in manual pin order, regardless of recency", () => {
    const preview = pinnedDrawerPreview(threads, 116);
    expect(preview.visible.map((thread) => thread.key)).toEqual(["oldest", "newest", "middle"]);
    expect(preview.hiddenCount).toBe(0);
    expect(threads.map((thread) => thread.key)).toEqual(["oldest", "newest", "middle"]);
  });

  it("reserves space for the drawer button when threads overflow", () => {
    const preview = pinnedDrawerPreview(threads, 115);
    expect(preview.visible.map((thread) => thread.key)).toEqual(["oldest"]);
    expect(preview.hiddenCount).toBe(2);
  });

  it("keeps the drawer reachable at narrow widths", () => {
    expect(pinnedDrawerPreview(threads, 0)).toEqual({ visible: [], hiddenCount: 3 });
    expect(pinnedDrawerPreview([], 0)).toEqual({ visible: [], hiddenCount: 0 });
  });

  it("preserves pin order when activity timestamps tie", () => {
    const tied = threads.map((thread) => ({ ...thread, updatedAt: "2026-10-23T00:00:00Z" }));
    expect(pinnedDrawerPreview(tied, 116).visible).toEqual(tied);
  });
});
