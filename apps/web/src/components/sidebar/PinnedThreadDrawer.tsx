import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentScope } from "~/state/session";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { pinnedDrawerPreview } from "./PinnedThreadDrawer.logic";

export type PinnedDrawerThread = {
  key: string;
  environmentId: EnvironmentId;
  title: string;
  active: boolean;
  ghost: boolean;
  draggable: boolean;
  icon: ReactNode;
  badge: ReactNode;
  tooltip: ReactNode;
};

export function PinnedThreadDrawer(props: {
  threads: readonly PinnedDrawerThread[];
  expanded: boolean;
  hidden: boolean;
  dragging: boolean;
  animationDuration: number;
  onToggle: () => void;
  onFullyCollapse: () => void;
  onSectionContextMenu: (event: MouseEvent) => void;
  onThreadClick: (event: MouseEvent, key: string) => void;
  onThreadContextMenu: (event: MouseEvent, key: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line t3code/react-effect-budget -- Resize observation keeps the icon count within the drawer width before paint.
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(0, node.clientWidth - 8));
    measure();
    return observeResize(node, measure);
  }, []);
  const { visible, hiddenCount } = pinnedDrawerPreview(props.expanded ? [] : props.threads, width);
  return (
    <div ref={container}>
      <CollapsibleSectionHeader
        ref={toggle}
        expanded={props.expanded}
        disabled={props.dragging}
        tone={props.dragging ? "emphasized" : "muted"}
        onClick={props.onToggle}
        onDoubleClick={props.onFullyCollapse}
        onContextMenu={props.onSectionContextMenu}
        aria-label={props.expanded ? "Collapse pinned threads" : "Expand pinned threads"}
      >
        {props.expanded ? "Pinned" : `Pinned (${props.threads.length})`}
      </CollapsibleSectionHeader>
      {!props.expanded && !props.hidden ? (
        <div
          role="group"
          aria-label="Pinned threads"
          className={cn("flex h-11 items-center gap-1 px-1", !props.dragging && "overflow-hidden")}
        >
          <SortableContext
            items={visible.filter((thread) => !thread.ghost).map((thread) => thread.key)}
            strategy={horizontalListSortingStrategy}
          >
            {visible.map((thread) => (
              <PinnedThreadIcon
                key={thread.key}
                thread={thread}
                dragging={props.dragging}
                animationDuration={props.animationDuration}
                onClick={props.onThreadClick}
                onContextMenu={props.onThreadContextMenu}
              />
            ))}
          </SortableContext>
          {hiddenCount > 0 ? (
            <button
              type="button"
              aria-label={`Show ${hiddenCount} more pinned threads`}
              disabled={props.dragging}
              onClick={() => {
                toggle.current?.focus();
                props.onToggle();
              }}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-xs text-sidebar-muted-foreground tabular-nums outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              +{hiddenCount}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type PinnedThreadIconProps = {
  thread: PinnedDrawerThread;
  dragging: boolean;
  animationDuration: number;
  onClick: (event: MouseEvent, key: string) => void;
  onContextMenu: (event: MouseEvent, key: string) => void;
};

function PinnedThreadIcon(props: PinnedThreadIconProps) {
  // The active row already owns this thread's sortable registration.
  if (props.thread.ghost) {
    return (
      <div data-sidebar-pin-ghost={props.thread.key} className="relative size-9 shrink-0">
        <PinnedThreadIconButton {...props} />
      </div>
    );
  }
  return <SortablePinnedThreadIcon {...props} />;
}

function SortablePinnedThreadIcon(props: PinnedThreadIconProps) {
  const { thread } = props;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: thread.key,
    disabled: !thread.draggable || !canOperateThread,
    transition: { duration: props.animationDuration, easing: "ease-out" },
  });
  return (
    <div
      ref={setNodeRef}
      data-thread-item={thread.key}
      className={cn("relative size-9 shrink-0", isDragging && "z-20")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <PinnedThreadIconButton
        {...props}
        dragging={props.dragging || isDragging}
        buttonProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function PinnedThreadIconButton({
  thread,
  dragging,
  buttonProps,
  onClick,
  onContextMenu,
}: Omit<PinnedThreadIconProps, "animationDuration"> & {
  buttonProps?: ComponentProps<"button">;
}) {
  return (
    <Tooltip disabled={dragging}>
      <TooltipTrigger
        render={
          <button
            type="button"
            {...buttonProps}
            aria-label={thread.ghost ? `${thread.title}, in Active` : thread.title}
            aria-current={thread.active && !thread.ghost ? "page" : undefined}
            onClick={(event) => onClick(event, thread.key)}
            onContextMenu={(event) => onContextMenu(event, thread.key)}
            className={cn(
              "relative flex size-9 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              thread.active && !thread.ghost && "bg-sidebar-row-active",
            )}
          />
        }
      >
        <span
          data-sidebar-pinned-icon={thread.ghost ? undefined : thread.key}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center",
            thread.ghost && "opacity-30",
          )}
        >
          {thread.icon}
        </span>
        {!thread.ghost ? thread.badge : null}
      </TooltipTrigger>
      {thread.tooltip}
    </Tooltip>
  );
}
