import { useAtom, useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2Run,
  type RunId,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { Atom } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { ChevronRightIcon, PenLineIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useLongLivedAssetUrl } from "../../assets/longLivedAssetUrls";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { isImageAttachment, type ChatAttachment } from "../../types";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn, randomUUID } from "../../lib/utils";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import {
  useProject,
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadHistory,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { workEntryDisplayLabel } from "./MessagesTimeline.logic";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { MessageCopyButton } from "./MessageCopyButton";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";

export type AnswerRef = { threadRef: ScopedThreadRef; runId: RunId };
export type RewriteGroup = NonNullable<OrchestrationV2Run["rewrites"]>;

export interface RewriteModelDisplay {
  readonly provider: ServerProvider | undefined;
  readonly modelLabel: string;
  readonly providerLabel: string;
  readonly traits: ReadonlyArray<string>;
  readonly subtitle: string;
  readonly inlineLabel: string;
}

export function resolveRewriteModelDisplay(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider> | undefined,
): RewriteModelDisplay {
  const { model, options, instanceId } = selection;
  const provider = providers?.find((entry) => entry.instanceId === instanceId);
  const catalogModel = provider?.models.find((entry) => entry.slug === model);
  const modelLabel = catalogModel ? getDisplayModelName(catalogModel) : formatModelSlugName(model);
  const providerLabel = provider ? resolveProviderInstanceDisplayName(provider) : instanceId;
  const traits =
    options?.map(({ id, value }) => {
      const descriptor = catalogModel?.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === id,
      );
      if (typeof value === "boolean") return `${descriptor?.label ?? id} ${value ? "on" : "off"}`;
      return descriptor?.type === "select"
        ? (descriptor.options.find((option) => option.id === value)?.label ?? value)
        : value;
    }) ?? [];
  return {
    provider,
    modelLabel,
    providerLabel,
    traits,
    subtitle: [providerLabel, ...traits].join(" · "),
    inlineLabel: [modelLabel, ...traits].join(" · "),
  };
}

export function RewriteProviderIcon({
  display,
  className = "size-4",
}: {
  display: RewriteModelDisplay;
  className?: string;
}) {
  const { provider, providerLabel } = display;
  if (!provider) return null;
  return (
    <ProviderInstanceIcon
      driverKind={provider.driver}
      displayName={providerLabel}
      accentColor={provider.accentColor}
      {...(provider.driver === "acpRegistry" && provider.iconUrl
        ? { acpRegistryIconUrl: provider.iconUrl }
        : {})}
      size="compact"
      className={className}
      iconClassName={className}
    />
  );
}

export function useRewriteCopyText(threadRef: ScopedThreadRef | null, runId: RunId): string {
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const items = useThreadVisibleTurnItems(threadRef);
  if (!threadRef) return "";
  const runItems = items.filter(
    ({ sourceThreadId, item }) => sourceThreadId === threadRef.threadId && item.runId === runId,
  );
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: runItems,
    optimisticMessages: [],
    plans: projection?.plans ?? [],
  });
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "assistant" && entry.message.text) {
      parts.push(entry.message.text);
    } else if (entry.kind === "sent-message" && entry.text) {
      parts.push(entry.text);
    } else if (entry.kind === "proposed-plan" && entry.proposedPlan.planMarkdown) {
      parts.push(entry.proposedPlan.planMarkdown);
    }
  }
  return parts.join("\n\n");
}

function RewriteAttachment({
  threadRef,
  attachment,
}: {
  threadRef: ScopedThreadRef;
  attachment: ChatAttachment;
}) {
  const asset = useLongLivedAssetUrl(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
  });
  if (asset._tag !== "Success") return <span>{attachment.name}</span>;
  return (
    <a href={asset.url} target="_blank" rel="noreferrer">
      {isImageAttachment(attachment) ? (
        <img className="max-w-full rounded-md" src={asset.url} alt={attachment.name} />
      ) : (
        attachment.name
      )}
    </a>
  );
}

function RewriteWaitingSkeleton() {
  return (
    <div role="status" className="space-y-2.5 py-1">
      <span className="sr-only">
        <T>Waiting for the answer…</T>
      </span>
      <Skeleton shape="pill" className="h-2.5 w-4/5" />
      <Skeleton shape="pill" className="h-2.5 w-full" />
      <Skeleton shape="pill" className="h-2.5 w-3/5" />
    </div>
  );
}

export function RewriteOutput({
  threadRef,
  runId,
  attribution,
  showActivity = false,
  actions,
}: AnswerRef & {
  attribution?: ModelSelection;
  showActivity?: boolean;
  actions?: ReactNode;
}) {
  const gt = useGT();
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const project = useProject(
    projection
      ? { environmentId: threadRef.environmentId, projectId: projection.thread.projectId }
      : null,
  );
  const [activityOpen, setActivityOpen] = useState(false);
  const items = useThreadVisibleTurnItems(threadRef);
  const runItems = items.filter(
    ({ sourceThreadId, item }) => sourceThreadId === threadRef.threadId && item.runId === runId,
  );
  const reachedRunStart = runItems.some(
    ({ item }) => item.type === "user_message" && item.inputIntent === "turn_start",
  );
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: runItems,
    optimisticMessages: [],
    plans: projection?.plans ?? [],
  });
  const run = projection?.runs.find((item) => item.id === runId);
  const activity = showActivity ? entries.filter((entry) => entry.kind === "work") : [];
  const attributionDisplay = attribution
    ? resolveRewriteModelDisplay(attribution, config?.providers)
    : null;
  const text: string[] = [];
  const output = entries.flatMap((entry) => {
    if (entry.kind === "html-render")
      return [
        <HtmlRenderFrame
          key={entry.id}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
          htmlRender={entry.htmlRender}
        />,
      ];
    if (entry.kind === "mcp-app")
      return [
        <McpAppFrame
          key={entry.id}
          environmentId={threadRef.environmentId}
          threadId={entry.sourceThreadId}
          conversationThreadId={threadRef.threadId}
          itemId={entry.itemId}
          revision={entry.revision}
          app={entry.mcpApp}
          onSendMessage={undefined}
        />,
      ];
    const assistant =
      entry.kind === "message" && entry.message.role === "assistant" ? entry.message : undefined;
    const body =
      assistant?.text ??
      (entry.kind === "sent-message"
        ? entry.text
        : entry.kind === "proposed-plan"
          ? entry.proposedPlan.planMarkdown
          : "");
    const attachments = assistant?.attachments;
    if (!body && !attachments?.length) return [];
    if (body) text.push(body);
    return [
      <div key={entry.id}>
        {body && (
          <ChatMarkdown
            text={body}
            isStreaming={Boolean(assistant?.streaming)}
            renderInsights
            cwd={projection?.thread.worktreePath ?? project?.workspaceRoot}
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
          />
        )}
        {attachments?.map((attachment) => (
          <RewriteAttachment key={attachment.id} attachment={attachment} threadRef={threadRef} />
        ))}
      </div>,
    ];
  });
  const isTerminalRun =
    run?.status === "failed" ||
    run?.status === "interrupted" ||
    run?.status === "cancelled" ||
    run?.status === "rolled_back" ||
    run?.status === "completed" ||
    run?.status === "waiting";
  return (
    <div className="min-w-0 space-y-3">
      {attributionDisplay && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <RewriteProviderIcon display={attributionDisplay} className="size-3.5" />
          <span className="truncate">
            <T>
              Rewritten by{" "}
              <span className="font-medium text-foreground/85">
                <Var>{attributionDisplay.inlineLabel}</Var>
              </span>
            </T>
          </span>
        </div>
      )}
      {!reachedRunStart && <EarlierRewriteHistory threadRef={threadRef} />}
      {activity.length > 0 && (
        <div className="min-w-0">
          <button
            type="button"
            aria-expanded={activityOpen}
            onClick={() => setActivityOpen(!activityOpen)}
            className="inline-flex cursor-pointer select-none items-center gap-1 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150",
                activityOpen && "rotate-90",
              )}
            />
            <span className="tabular-nums">
              <T>
                Activity (<Var>{activity.length}</Var>)
              </T>
            </span>
          </button>
          {activityOpen && (
            <div className="mt-1.5 ms-1.5 max-h-48 overflow-y-auto border-s border-border/60 ps-3">
              <ul className="space-y-1 text-xs text-secondary-label">
                {activity.map(({ id, entry }) => (
                  <li key={id} className="truncate leading-relaxed">
                    {workEntryDisplayLabel(entry, project?.workspaceRoot)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {output}
      {output.length === 0 &&
        (isTerminalRun ? (
          <p role="status" className="text-sm text-muted-foreground">
            {run?.status === "failed"
              ? gt("This rewrite failed.")
              : run?.status === "interrupted" ||
                  run?.status === "cancelled" ||
                  run?.status === "rolled_back"
                ? gt("This rewrite was interrupted.")
                : gt("This answer has no visible output.")}
          </p>
        ) : (
          <RewriteWaitingSkeleton />
        ))}
      {((attribution && text.length > 0) || actions) && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {attribution && text.length > 0 && (
            <MessageCopyButton
              text={text.join("\n\n")}
              label={gt("Copy rewrite")}
              variant="ghost"
            />
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

export function EarlierRewriteHistory({ threadRef }: Pick<AnswerRef, "threadRef">) {
  const gt = useGT();
  const history = useThreadHistory(threadRef);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory);
  return (
    <>
      {history.hasMoreHistory && (
        <Button
          size="xs"
          variant="outline"
          disabled={history.loading}
          onClick={() =>
            void loadEarlier({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            })
          }
        >
          {history.loading ? gt("Loading earlier output…") : gt("Load earlier output")}
        </Button>
      )}
      {history.error && <p role="status">{history.error}</p>}
    </>
  );
}

type RewriteRequest = { status: "idle" | "pending" } | { status: "failed"; message: string };

// The timeline button and panel share feedback for the same command, even if the row scrolls away.
const requestAtom = Atom.family((_answer: AnswerRef) =>
  Atom.make<RewriteRequest>({ status: "idle" }),
);

export function useRewriteCommand(answer: AnswerRef, hasCouncil: boolean) {
  const { threadRef, runId } = answer;
  const action = hasCouncil ? "thread.rewrites.select" : "thread.rewrites.start";
  const permitted = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(threadRef.environmentId, {
      type: action,
    }),
  );
  const parent = useQuietThreadShell(threadRef);
  const canOperate = permitted && parent?.archivedAt === null;
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [request, setRequest] = useAtom(requestAtom(answer));
  const submit = async (candidateThreadId?: ThreadId | null) => {
    if (!canOperate || request.status === "pending") return;
    setRequest({ status: "pending" });
    const command = {
      commandId: CommandId.make(randomUUID()),
      threadId: threadRef.threadId,
      runId,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const result = await dispatch({
      environmentId: threadRef.environmentId,
      input:
        candidateThreadId === undefined
          ? { ...command, type: "thread.rewrites.start" }
          : { ...command, type: "thread.rewrites.select", candidateThreadId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setRequest({
        status: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } else {
      setRequest({ status: "idle" });
    }
  };
  return { canOperate, request, submit };
}

export function RewriteButton({
  threadRef,
  runId,
  group,
}: AnswerRef & { group?: RewriteGroup | undefined }) {
  const gt = useGT();
  const { canOperate, submit } = useRewriteCommand({ threadRef, runId }, !!group);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  const isPanelActive = useRightPanelStore((state) => {
    const panel = selectThreadRightPanelState(state.byThreadKey, threadRef);
    return panel.isOpen && panel.activeSurfaceId === `rewrites:${runId}`;
  });
  const candidateCount = group?.candidates.length ?? 0;
  const label =
    candidateCount > 0 ? gt("Rewrites ({count})", { count: candidateCount }) : gt("Rewrites");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            data-pressed={isPanelActive ? "" : undefined}
            disabled={!group && (!canOperate || !settings)}
            onClick={() => {
              useRightPanelStore.getState().openRewrites(threadRef, runId);
              if (!group && settings?.rewriteCouncil.length) void submit();
            }}
          />
        }
      >
        <PenLineIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
