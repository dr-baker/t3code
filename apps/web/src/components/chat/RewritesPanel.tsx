import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2RunStatus,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  PenLineIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadHistory,
} from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  EarlierRewriteHistory,
  RewriteOutput,
  RewriteProviderIcon,
  resolveRewriteModelDisplay,
  useRewriteCommand,
  useRewriteCopyText,
  type AnswerRef,
  type RewriteGroup,
} from "./Rewrites";

const statusLabel = {
  queued: "Queued",
  preparing: "Preparing",
  starting: "Starting",
  running: "Generating",
  waiting: "Ready",
  completed: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  rolled_back: "Rolled back",
} satisfies Record<OrchestrationV2RunStatus, string>;

function RewriteCard({
  parentRef,
  candidate,
  providers,
  selected,
  canAdopt,
  onSelect,
}: {
  parentRef: ScopedThreadRef;
  candidate: RewriteGroup["candidates"][number];
  providers: ReadonlyArray<ServerProvider>;
  selected: boolean;
  canAdopt: boolean;
  onSelect: (threadId: ThreadId) => void;
}) {
  const ref = scopeThreadRef(parentRef.environmentId, candidate.threadId);
  const shell = useQuietThreadShell(ref);
  const hasSnapshot = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  const projection = useQuietThreadProjection(shell ? ref : null)?.projection;
  const copyText = useRewriteCopyText(shell ? ref : null, candidate.runId);
  const status = projection?.runs.find((run) => run.id === candidate.runId)?.status;
  const ready = status === "completed" || status === "waiting";
  const needsInput = projection?.runtimeRequests.some(
    (request) =>
      request.status === "pending" &&
      projection.nodes.some((node) => node.id === request.nodeId && node.runId === candidate.runId),
  );
  const display = resolveRewriteModelDisplay(candidate.modelSelection, providers);
  const openSideChat = () =>
    useRightPanelStore.getState().openSideChat(parentRef, candidate.threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links in candidate output open in the parent chat's panel
  useEffect(() => hostRightPanel(ref, parentRef), [ref, parentRef]);
  return (
    <section
      aria-label={`Rewrite by ${display.modelLabel}, ${display.subtitle}`}
      data-selected={selected || undefined}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-[border-color,box-shadow] duration-150",
        selected
          ? "border-primary/45 ring-1 ring-primary/15 dark:border-primary/50 dark:ring-primary/20"
          : "border-border/80 hover:border-border",
      )}
    >
      <header className="flex items-center justify-between gap-2.5 border-b border-border/50 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <RewriteProviderIcon display={display} className="size-4" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className="truncate text-sm font-medium leading-tight text-foreground">
                {display.modelLabel}
              </h3>
              {!shell && hasSnapshot ? (
                <Badge size="sm" variant="secondary" role="status">
                  Unavailable
                </Badge>
              ) : needsInput ? (
                <Badge size="sm" variant="warning" role="status">
                  Needs input
                </Badge>
              ) : status === "failed" ? (
                <Badge size="sm" variant="error" role="status">
                  Failed
                </Badge>
              ) : status === "cancelled" || status === "interrupted" || status === "rolled_back" ? (
                <Badge size="sm" variant="secondary" role="status">
                  {statusLabel[status]}
                </Badge>
              ) : !ready ? (
                <span
                  role="status"
                  className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground"
                >
                  <Spinner size="xs" />
                  {status ? statusLabel[status] : "Loading…"}
                </span>
              ) : null}
            </div>
            <p className="truncate text-2xs leading-snug text-muted-foreground">
              {display.subtitle}
            </p>
          </div>
        </div>
        {shell ? (
          selected ? (
            <span
              role="status"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-(--control-radius) bg-primary/10 px-2 text-xs font-medium text-primary dark:bg-primary/16 dark:text-info-foreground"
            >
              <CheckIcon className="size-3" />
              In thread
            </span>
          ) : needsInput ? (
            <Button size="xs" variant="warning-outline" onClick={openSideChat}>
              Respond <ArrowUpRightIcon className="size-3" />
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!ready || !canAdopt}
              onClick={() => onSelect(candidate.threadId)}
            >
              Use this rewrite
            </Button>
          )
        ) : null}
      </header>
      {shell ? (
        <>
          <ScrollArea scrollFade className="max-h-[48dvh] @2xl:max-h-[68dvh]">
            <div className="px-3.5 py-3">
              <RewriteOutput threadRef={ref} runId={candidate.runId} showActivity />
            </div>
          </ScrollArea>
          <footer className="flex items-center justify-between gap-1 border-t border-border/40 px-2.5 py-1.5">
            {copyText ? (
              <MessageCopyButton
                text={copyText}
                label={`Copy ${display.modelLabel} rewrite`}
                variant="ghost"
              />
            ) : (
              <span />
            )}
            <Button size="xs" variant="ghost-muted" onClick={openSideChat}>
              {needsInput ? "Open side chat to respond" : "Open side chat"}
              <ArrowUpRightIcon className="size-3" />
            </Button>
          </footer>
        </>
      ) : (
        <p className="px-3.5 py-3 text-sm text-muted-foreground">
          {hasSnapshot ? "This side chat is no longer available." : "Loading side chat…"}
        </p>
      )}
    </section>
  );
}

export function RewritesPanel({ threadRef, runId }: AnswerRef) {
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  const parent = useQuietThreadShell(threadRef);
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const source = projection?.runs.find((run) => run.id === runId);
  const group = source?.rewrites;
  const history = useThreadHistory(threadRef);
  const { canOperate, request, submit } = useRewriteCommand({ threadRef, runId }, !!group);
  const [showOriginal, setShowOriginal] = useState(false);
  const pending = request.status === "pending";
  const error = request.status === "failed" && (
    <p
      role="alert"
      className="border-b border-border/60 px-3 py-2 text-xs text-destructive-foreground"
    >
      {request.message}
    </p>
  );
  if (!config || !projection)
    return (
      <Empty>
        <Spinner size="sm" />
      </Empty>
    );
  if (!config.environment.capabilities.rewrites) {
    return (
      <Empty>
        <EmptyDescription>This environment does not support rewrites.</EmptyDescription>
      </Empty>
    );
  }
  if (!source)
    return (
      <Empty>
        <EmptyDescription>
          {history.hasMoreHistory
            ? "This turn is in earlier history."
            : "This turn is no longer available."}
        </EmptyDescription>
        <EarlierRewriteHistory threadRef={threadRef} />
      </Empty>
    );
  if (source.status !== "completed" && source.status !== "waiting")
    return (
      <Empty>
        <EmptyDescription>
          {source.status === "rolled_back"
            ? "This turn was rolled back."
            : "Rewrites are unavailable for this turn."}
        </EmptyDescription>
      </Empty>
    );
  if (!group)
    return (
      <Empty size="compact">
        <PenLineIcon className="size-5 text-muted-foreground" />
        {!settings || pending ? (
          <p role="status" className="text-xs text-muted-foreground">
            {pending ? "Starting rewrite council…" : "Loading council…"}
          </p>
        ) : settings.rewriteCouncil.length === 0 ? (
          <>
            <EmptyHeader>
              <EmptyTitle>Set up your rewrite council</EmptyTitle>
              <EmptyDescription>
                Choose the models and reasoning effort that will rewrite this answer.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/settings/threads"
                  search={{ machine: threadRef.environmentId }}
                  hash="rewrite-council"
                />
              }
            >
              Set up council
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => void submit()}>
            Generate rewrites
          </Button>
        )}
        {error}
      </Empty>
    );
  const sourceDisplay = resolveRewriteModelDisplay(source.modelSelection, config.providers);
  return (
    <div data-rewrites-panel={runId} className="@container flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/80 px-3 py-1">
        <div className="me-auto flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-xs font-medium text-foreground">
            Turn {source.ordinal} rewrites
          </h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            · {group.candidates.length}
          </span>
        </div>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={showOriginal}
          data-pressed={showOriginal ? "" : undefined}
          onClick={() => setShowOriginal(!showOriginal)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 transition-transform duration-150",
              showOriginal && "rotate-90",
            )}
          />
          Original
        </Button>
        {group.selectedThreadId !== null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canOperate || pending}
            onClick={() => void submit(null)}
          >
            Use original
          </Button>
        ) : (
          <span className="inline-flex h-6 items-center gap-1 px-1.5 text-xs text-muted-foreground">
            <CheckIcon className="size-3 text-primary" />
            Original in thread
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Configure rewrite council"
                render={
                  <Link
                    to="/settings/threads"
                    search={{ machine: threadRef.environmentId }}
                    hash="rewrite-council"
                  />
                }
              />
            }
          >
            <SlidersHorizontalIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Configure rewrite council</TooltipPopup>
        </Tooltip>
      </div>
      {error}
      {showOriginal && (
        <div className="shrink-0 border-b border-border/70 bg-muted/25 dark:bg-white/[0.02]">
          <div className="flex items-center justify-between gap-2 px-3.5 pt-2 pb-1">
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <RewriteProviderIcon display={sourceDisplay} className="size-3.5" />
              <span className="font-medium text-foreground">Original</span>
              <span className="truncate text-muted-foreground">· {sourceDisplay.inlineLabel}</span>
            </div>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Hide original"
              onClick={() => setShowOriginal(false)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <ScrollArea scrollFade className="max-h-[36dvh]">
            <div className="px-3.5 pt-1 pb-3">
              <RewriteOutput threadRef={threadRef} runId={runId} />
            </div>
          </ScrollArea>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,21rem),1fr))] items-start gap-3 p-3">
          {group.candidates.map((candidate) => (
            <RewriteCard
              key={candidate.threadId}
              parentRef={threadRef}
              candidate={candidate}
              providers={config.providers}
              selected={group.selectedThreadId === candidate.threadId}
              canAdopt={canOperate && !pending && !threadRuntimeIsActive(parent?.runtime)}
              onSelect={(id) => void submit(id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
