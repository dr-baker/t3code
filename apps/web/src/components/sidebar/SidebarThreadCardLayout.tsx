import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarThreadCardLayout(props: {
  compact: boolean;
  children: ReactNode;
  metadata: ReactNode;
  metadataEmpty?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative z-10 px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
        props.compact ? "h-[3.75rem]" : "h-[4.875rem]",
        !props.compact && props.metadataEmpty && "redesign:h-auto",
      )}
    >
      {props.children}
      {props.compact ? null : props.metadata}
    </div>
  );
}
