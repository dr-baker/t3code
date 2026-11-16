import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarThreadCardLayout(props: {
  compact: boolean;
  singleLine?: boolean;
  children: ReactNode;
  metadata: ReactNode;
  metadataEmpty?: boolean;
}) {
  return (
    <div
      data-sidebar-card-layout={
        props.singleLine ? "single-line" : props.compact ? "compact" : "expanded"
      }
      className={cn(
        "relative z-10 px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
        "h-[4.875rem]",
        props.metadataEmpty && "h-auto",
      )}
    >
      {props.children}
      <div data-sidebar-card-metadata>{props.metadata}</div>
    </div>
  );
}
