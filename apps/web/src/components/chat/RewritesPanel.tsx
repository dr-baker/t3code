import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2RunStatus,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, PenLineIcon } from "lucide-react";
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
import { getDisplayModelName } from "./providerIconUtils";
import { Spinner } from "../ui/spinner";
import {
  EarlierRewriteHistory,
  RewriteOutput,
  useRewriteCommand,
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
  provider,
  selected,
  canAdopt,
  onSelect,
}: {
  parentRef: ScopedThreadRef;
  candidate: RewriteGroup["candidates"][number];
  provider: ServerProvider | undefined;
  selected: boolean;
  canAdopt: boolean;
  onSelect: (threadId: ThreadId) => void;
}) {
  const ref = scopeThreadRef(parentRef.environmentId, candidate.threadId);
  const shell = useQuietThreadShell(ref);
  const hasSnapshot = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  const projection = useQuietThreadProjection(shell ? ref : null)?.projection;
  const status = projection?.runs.find((run) => run.id === candidate.runId)?.status;
  const ready = status === "completed" || status === "waiting";
  const needsInput = projection?.runtimeRequests.some(
    (request) =>
      request.status === "pending" &&
      projection.nodes.some((node) => node.id === request.nodeId && node.runId === candidate.runId),
  );
  const { model, options, instanceId } = candidate.modelSelection;
  const catalogModel = provider?.models.find((entry) => entry.slug === model);
  const label = catalogModel ? getDisplayModelName(catalogModel) : formatModelSlugName(model);
  const traits = options?.map(({ id, value }) => {
    const descriptor = catalogModel?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === id,
    );
    if (typeof value === "boolean") return `${descriptor?.label ?? id} ${value ? "on" : "off"}`;
    return descriptor?.type === "select"
      ? (descriptor.options.find((option) => option.id === value)?.label ?? value)
      : value;
  });
  const attribution = [
    provider ? resolveProviderInstanceDisplayName(provider) : instanceId,
    ...(traits ?? []),
  ].join(" · ");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links in candidate output open in the parent chat's panel
  useEffect(() => hostRightPanel(ref, parentRef), [ref, parentRef]);
  return (
    <section
      aria-label={`Rewrite by ${label}, ${attribution}`}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card/60",
        selected ? "border-primary/50" : "border-border/80",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/25 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="break-words text-sm font-medium">{label}</h3>
          <Badge
            size="sm"
            variant={needsInput ? "warning" : status === "failed" ? "error" : "secondary"}
            role="status"
          >
            {!shell && hasSnapshot
              ? "Unavailable"
              : needsInput
                ? "Needs input"
                : status
                  ? statusLabel[status]
                  : "Loading…"}
          </Badge>
          <p className="w-full break-words text-xs text-muted-foreground">{attribution}</p>
        </div>
        {shell && (
          <Button
            size="xs"
            variant={ready && canAdopt && !selected ? "default" : "ghost-muted"}
            disabled={selected || !ready || needsInput || !canAdopt}
            onClick={() => onSelect(candidate.threadId)}
          >
            {selected ? (
              <>
                <CheckIcon /> In thread
              </>
            ) : (
              "Use this rewrite"
            )}
          </Button>
        )}
      </header>
      {shell ? (
        <>
          <div className="max-h-[45dvh] overflow-auto px-3.5 py-3 @2xl:max-h-[72dvh]">
            <RewriteOutput threadRef={ref} runId={candidate.runId} showActivity />
          </div>
          <div className="border-t border-border/60 px-2 py-1">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                useRightPanelStore.getState().openSideChat(parentRef, candidate.threadId)
              }
            >
              {needsInput ? "Open side chat to respond" : "Open side chat"} <ArrowUpRightIcon />
            </Button>
          </div>
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
    <p role="alert" className="px-3 py-2 text-sm text-destructive-foreground">
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
          <p role="status">{pending ? "Starting rewrite council…" : "Loading council…"}</p>
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
          <Button size="sm" disabled={!canOperate} onClick={() => void submit()}>
            Generate rewrites
          </Button>
        )}
        {error}
      </Empty>
    );
  return (
    <div data-rewrites-panel={runId} className="@container flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <h2 className="me-auto ps-1 text-xs font-medium">Turn {source.ordinal} rewrites</h2>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={showOriginal}
          onClick={() => setShowOriginal(!showOriginal)}
        >
          <ChevronDownIcon className={cn("size-3.5", !showOriginal && "-rotate-90")} />
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
          <span className="flex items-center gap-1 pe-1 text-xs text-muted-foreground">
            <CheckIcon className="size-3" /> In thread
          </span>
        )}
      </div>
      {error}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {showOriginal && (
          <div className="max-h-[45dvh] overflow-auto border-b border-border px-4 py-3">
            <RewriteOutput threadRef={threadRef} runId={runId} />
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,21rem),1fr))] items-start gap-3 p-3">
          {group.candidates.map((candidate) => (
            <RewriteCard
              key={candidate.threadId}
              parentRef={threadRef}
              candidate={candidate}
              provider={config.providers.find(
                (provider) => provider.instanceId === candidate.modelSelection.instanceId,
              )}
              selected={group.selectedThreadId === candidate.threadId}
              canAdopt={canOperate && !pending && !threadRuntimeIsActive(parent?.runtime)}
              onSelect={(id) => void submit(id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
