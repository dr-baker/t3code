import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PINNED_THREAD_STATUS } from "./PinnedThreadStatus";
import { resolvePinnedThreadStatus, summarizePinnedActivity } from "./PinnedThreadActivity.logic";

export function PinnedThreadActivity(props: {
  threads: readonly SidebarThreadSummary[];
  now: string;
  expanded: boolean;
  hidden: boolean;
  dragging: boolean;
  animate: boolean;
  listRef: RefObject<HTMLUListElement | null>;
  onReveal: () => void;
}) {
  const visited = useUiStateStore(
    useShallow((state) =>
      props.threads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id })
          ],
      ),
    ),
  );
  const groups = summarizePinnedActivity(
    props.threads.map((thread, index) =>
      resolvePinnedThreadStatus(
        thread,
        resolveThreadLastVisitedAt(thread.lastVisitedAt, visited[index]),
        threadWokeAt(thread, { now: props.now }),
      ),
    ),
  );
  const [direction, setDirection] = useState<"above" | "below" | null>(null);
  const targetKey = [
    props.expanded,
    props.hidden,
    ...props.threads.map((thread) =>
      scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id }),
    ),
  ].join("\n");
  // oxlint-disable-next-line t3code/react-effect-budget -- IntersectionObserver tracks pin visibility as the user scrolls.
  useEffect(() => {
    const list = props.listRef.current;
    const header = list?.querySelector('[data-testid="sidebar-pinned-header"]');
    const viewport = list?.closest('[data-slot="scroll-area-viewport"]');
    if (!list || !header || !viewport) return;
    const targets = new Set<Element>([header]);
    for (const icon of list.querySelectorAll("[data-sidebar-pinned-icon]")) {
      const row = icon.closest("[data-thread-item]");
      if (row) targets.add(row);
    }
    const visible = new Map<Element, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target, entry.isIntersecting);
        if ([...visible.values()].some(Boolean)) setDirection(null);
        else {
          const entry = entries[0];
          if (entry?.rootBounds)
            setDirection(
              entry.boundingClientRect.bottom <= entry.rootBounds.top ? "above" : "below",
            );
        }
      },
      { root: viewport },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Drawer state and pin order replace observation targets; streamed content does not.
  }, [props.listRef, targetKey]);

  const overlayRoot = props.listRef.current?.closest(
    '[data-slot="scroll-area-viewport"]',
  )?.parentElement;
  if (direction === null || props.dragging || groups.length === 0 || !overlayRoot) return null;
  const shown = groups.slice(0, 3);
  const hiddenCount = groups.slice(3).reduce((sum, group) => sum + group.count, 0);
  const description = groups
    .map(({ kind, count }) => `${count} ${PINNED_THREAD_STATUS[kind].label.toLowerCase()}`)
    .join(", ");
  const Arrow = direction === "below" ? ChevronDownIcon : ChevronUpIcon;
  return createPortal(
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="glass"
              className="pointer-events-auto max-w-full"
              aria-label={`Show pinned activity: ${description}`}
              onClick={() => {
                props.onReveal();
                requestAnimationFrame(() => {
                  const header = props.listRef.current?.querySelector(
                    '[data-testid="sidebar-pinned-header"]',
                  );
                  header?.scrollIntoView({
                    block: "start",
                    behavior: props.animate ? "smooth" : "instant",
                  });
                  header?.querySelector("button")?.focus({ preventScroll: true });
                });
              }}
            />
          }
        >
          <Arrow className="size-3.5" />
          Pinned
          <span aria-hidden className="mx-1 h-3 w-px bg-border" />
          <span aria-hidden className="inline-flex min-w-0 items-center gap-2.5 overflow-hidden">
            {shown.map(({ kind, count }) => {
              const { icon: Icon, color } = PINNED_THREAD_STATUS[kind];
              return (
                <span key={kind} className={`inline-flex shrink-0 items-center gap-1 ${color}`}>
                  <Icon className={`size-3.5 ${color}`} />
                  <span className="tabular-nums">{count}</span>
                </span>
              );
            })}
            {hiddenCount > 0 ? <span className="tabular-nums">+{hiddenCount}</span> : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {groups.map(({ kind, count }) => (
            <div key={kind}>
              {count} {PINNED_THREAD_STATUS[kind].label}
            </div>
          ))}
        </TooltipPopup>
      </Tooltip>
    </div>,
    overlayRoot,
  );
}
