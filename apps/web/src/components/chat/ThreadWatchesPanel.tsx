import { AuthOrchestrationOperateScope, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatWatchOversightCadence } from "@t3tools/shared/threadWatchOversight";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../../threadRoutes";

import { useQuietThreadShell, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

export function ThreadWatchesPanel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onNavigate?: () => void;
}) {
  const headingId = useId();
  const navigate = useNavigate();
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const candidates = useQuietThreadShells().filter(
    (candidate) =>
      candidate.environmentId === props.environmentId &&
      candidate.id !== props.threadId &&
      candidate.archivedAt === null &&
      candidate.deletedAt === null,
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const watch = useAtomCommand(threadEnvironment.watchThread, { reportFailure: true });
  const [target, setTarget] = useState<string | null>(null);
  const [until, setUntil] = useState<"turn" | "settled">("turn");
  const [busy, setBusy] = useState(false);
  const change = async (targetThreadId: ThreadId, watching: boolean) => {
    setBusy(true);
    const result = await watch({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, targetThreadId, watching, until },
    });
    if (result._tag === "Success") setTarget(null);
    setBusy(false);
  };
  if (thread?.threadWatches === undefined) return null;
  const active =
    thread.archivedAt === null && thread.settledAt === null && thread.settledOverride !== "settled";
  return (
    <ThreadDetailsSection headingId={headingId} title="Thread watches">
      <div className="space-y-1">
        {thread.threadWatches.map((item) => (
          <div key={item.id} className="flex min-w-0 items-center gap-2 px-2.5">
            <EyeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      onClick={() => {
                        props.onNavigate?.();
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(props.environmentId, item.threadId),
                          ),
                        });
                      }}
                    />
                  }
                >
                  <span className="truncate">{item.title}</span>
                </TooltipTrigger>
                <TooltipPopup>{item.title}</TooltipPopup>
              </Tooltip>
            </div>
            {item.ended ? (
              <span className="text-xs text-muted-foreground">Ended</span>
            ) : item.oversight ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatWatchOversightCadence(item.oversight)}
              </span>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={!canOperate || busy}
              aria-label={`${item.ended ? "Remove" : "Stop watching"} ${item.title}`}
              onClick={() => void change(item.threadId, false)}
            >
              <EyeOffIcon aria-hidden className="size-3.5" />
            </Button>
          </div>
        ))}
        {active && canOperate ? (
          <div className="space-y-2 px-2.5 pt-1">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger size="sm" aria-label="Thread to watch" disabled={busy}>
                <SelectValue placeholder="Choose a thread…">
                  {target === null
                    ? undefined
                    : candidates.find((candidate) => candidate.id === target)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {candidates
                  .filter(
                    (candidate) =>
                      !thread.threadWatches?.some(
                        (item) => item.threadId === candidate.id && !item.ended,
                      ),
                  )
                  .map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
            {target !== null ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    value={until}
                    onValueChange={(value) => {
                      if (value === "turn" || value === "settled") setUntil(value);
                    }}
                  >
                    <SelectTrigger size="xs" aria-label="Watch duration">
                      <SelectValue>
                        {until === "turn" ? "Until work finishes" : "Until settled"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="turn">Until work finishes</SelectItem>
                      <SelectItem value="settled">Until settled</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => void change(ThreadId.make(target), true)}
                >
                  Watch
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

export function ThreadWatchesPopover(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            aria-label={`Watching ${props.count} thread${props.count === 1 ? "" : "s"}`}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <EyeIcon aria-hidden className="size-3" />
        <span className="tabular-nums">{props.count}</span>
      </PopoverTrigger>
      <PopoverPopup
        width="md"
        padding="none"
        side="right"
        align="start"
        aria-label="Thread watches"
        onClick={(event) => event.stopPropagation()}
      >
        <ThreadWatchesPanel
          environmentId={props.environmentId}
          threadId={props.threadId}
          onNavigate={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}
