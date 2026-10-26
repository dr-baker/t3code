const ICON_SELECTOR = "[data-sidebar-pinned-icon]";
const MAX_MOVING_ICONS = 12;

export function createPinnedDrawerMotion(root: HTMLElement) {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const reducedMotion = view?.matchMedia("(prefers-reduced-motion: reduce)");
  const before = new Map<string, DOMRect>();
  const running = new Set<() => void>();
  const visible = (rect: DOMRect) =>
    rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < (view?.innerHeight ?? 0);
  const cancel = () => {
    for (const stop of running) stop();
    before.clear();
  };
  return {
    capture() {
      cancel();
      if (reducedMotion?.matches) return;
      for (const node of root.querySelectorAll<HTMLElement>(ICON_SELECTOR)) {
        const key = node.dataset.sidebarPinnedIcon;
        const rect = node.getBoundingClientRect();
        if (key && visible(rect)) before.set(key, rect);
      }
    },
    play(durationMs: number) {
      if (durationMs <= 0 || reducedMotion?.matches) {
        cancel();
        return;
      }
      // Only icons cross row boundaries, keeping the temporary DOM small
      // and leaving row controls out of the animation overlay.
      for (const target of root.querySelectorAll<HTMLElement>(ICON_SELECTOR)) {
        if (running.size >= MAX_MOVING_ICONS) break;
        const source = before.get(target.dataset.sidebarPinnedIcon ?? "");
        if (!source) continue;
        const to = target.getBoundingClientRect();
        if (!visible(to)) continue;
        const from = source;
        if (from.left === to.left && from.top === to.top && from.width === to.width) continue;
        const clone = target.cloneNode(true) as HTMLElement;
        clone.removeAttribute("data-sidebar-pinned-icon");
        clone.setAttribute("aria-hidden", "true");
        clone.inert = true;
        Object.assign(clone.style, {
          position: "fixed",
          left: `${to.left}px`,
          top: `${to.top}px`,
          width: `${to.width}px`,
          height: `${to.height}px`,
          margin: "0",
          zIndex: "90",
          pointerEvents: "none",
          transformOrigin: "top left",
        });
        document.body.append(clone);
        const visibility = target.style.visibility;
        target.style.visibility = "hidden";
        const animation = clone.animate(
          [
            {
              transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
            },
            { transform: "translate(0px, 0px) scale(1, 1)" },
          ],
          { duration: durationMs, easing: "ease-out" },
        );
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          running.delete(stop);
          target.style.visibility = visibility;
          clone.remove();
          animation.cancel();
        };
        running.add(stop);
        animation.addEventListener("finish", stop, { once: true });
        animation.addEventListener("cancel", stop, { once: true });
      }
      before.clear();
    },
    dispose: cancel,
  };
}
