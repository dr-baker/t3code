import { describe, expect, it, vi } from "vite-plus/test";
import { createPinnedDrawerMotion } from "./PinnedThreadDrawer.motion";

class Icon {
  dataset: { sidebarPinnedIcon?: string };
  style = { visibility: "" };
  inert = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  cancel = vi.fn(() => this.listeners.get("cancel")?.());
  remove = vi.fn();
  animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
    cancel: this.cancel,
    addEventListener: (event: string, listener: () => void) => this.listeners.set(event, listener),
  }));
  constructor(
    key: string,
    readonly left: number,
    readonly top: number,
    readonly size = 24,
  ) {
    this.dataset = { sidebarPinnedIcon: key };
  }
  getBoundingClientRect() {
    return {
      left: this.left,
      top: this.top,
      width: this.size,
      height: this.size,
      bottom: this.top + this.size,
    };
  }
  cloneNode() {
    return new Icon(this.dataset.sidebarPinnedIcon!, this.left, this.top, this.size);
  }
  removeAttribute(name: string) {
    if (name === "data-sidebar-pinned-icon") delete this.dataset.sidebarPinnedIcon;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

function fixture() {
  const media = { matches: false };
  const clones: Icon[] = [];
  let icons: Icon[] = [];
  const root = {
    ownerDocument: {
      defaultView: { innerHeight: 800, matchMedia: () => media },
      body: { append: (icon: Icon) => clones.push(icon) },
    },
    querySelectorAll: () => icons,
  };
  const motion = createPinnedDrawerMotion(root as unknown as HTMLElement);
  return { motion, media, clones, render: (...next: Icon[]) => (icons = next) };
}

describe("pinned drawer icon motion", () => {
  it.each([
    [16, 24],
    [24, 16],
  ])("moves between %s and %s pixel icons using the destination's layout", (from, to) => {
    const { motion, render, clones } = fixture();
    render(new Icon("thread", 20, 180, from));
    motion.capture();
    render(new Icon("thread", 60, 80, to));
    motion.play(150);
    expect(clones[0]!.size).toBe(to);
    expect(clones[0]!.animate).toHaveBeenCalledWith(
      [
        { transform: `translate(-40px, 100px) scale(${from / to}, ${from / to})` },
        { transform: "translate(0px, 0px) scale(1, 1)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
    motion.dispose();
  });

  it("moves matching icons from their row positions and removes the overlay when finished", () => {
    const { motion, render, clones } = fixture();
    render(new Icon("environment:thread", 20, 180));
    motion.capture();
    const target = new Icon("environment:thread", 60, 80);
    render(target);
    motion.play(150);
    expect(clones).toHaveLength(1);
    expect(clones[0]!.animate).toHaveBeenCalledWith(
      [
        { transform: "translate(-40px, 100px) scale(1, 1)" },
        { transform: "translate(0px, 0px) scale(1, 1)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
    expect(target.style.visibility).toBe("hidden");
    expect(clones[0]!.inert).toBe(true);
    expect(clones[0]!.dataset.sidebarPinnedIcon).toBeUndefined();
    clones[0]!.listeners.get("finish")!();
    expect(target.style.visibility).toBe("");
    expect(clones[0]!.remove).toHaveBeenCalledOnce();
    motion.dispose();
    expect(clones[0]!.remove).toHaveBeenCalledOnce();
  });

  it("cleans up an interrupted toggle before capturing the next positions", () => {
    const { motion, render, clones } = fixture();
    render(new Icon("thread", 20, 180));
    motion.capture();
    const target = new Icon("thread", 60, 80);
    render(target);
    motion.play(150);
    motion.capture();
    expect(target.style.visibility).toBe("");
    expect(clones[0]!.cancel).toHaveBeenCalledOnce();
    expect(clones[0]!.remove).toHaveBeenCalledOnce();
    motion.dispose();
  });

  it.each(["reduced", "disabled"])("skips motion when %s", (policy) => {
    const { motion, render, clones, media } = fixture();
    render(new Icon("thread", 20, 180));
    motion.capture();
    render(new Icon("thread", 60, 80));
    media.matches = policy === "reduced";
    motion.play(policy === "disabled" ? 0 : 150);
    expect(clones).toEqual([]);
  });

  it("bounds concurrent icons and cleans them all up on disposal", () => {
    const { motion, render, clones } = fixture();
    render(...Array.from({ length: 20 }, (_, i) => new Icon(String(i), 20, 20 + i * 30)));
    motion.capture();
    const targets = Array.from({ length: 20 }, (_, i) => new Icon(String(i), 60 + i * 30, 80));
    render(...targets);
    motion.play(150);
    expect(clones).toHaveLength(12);
    motion.dispose();
    for (const clone of clones) expect(clone.remove).toHaveBeenCalledOnce();
    for (const target of targets) expect(target.style.visibility).toBe("");
  });

  it("ignores offscreen sources and unrelated updates", () => {
    const { motion, render, clones } = fixture();
    render(new Icon("thread", 20, 900));
    motion.capture();
    render(new Icon("thread", 60, 80));
    motion.play(150);
    expect(clones).toEqual([]);
    render(new Icon("thread", 20, 180));
    motion.play(150);
    expect(clones).toEqual([]);
  });
});
