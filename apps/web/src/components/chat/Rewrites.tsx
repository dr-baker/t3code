import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2Run,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { rewriteModelLabel } from "@t3tools/shared/model";
import { useLongLivedAssetUrl } from "../../assets/longLivedAssetUrls";
import { isImageAttachment, type ChatAttachment } from "../../types";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
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
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { MessageCopyButton } from "./MessageCopyButton";

type AnswerRef = { threadRef: ScopedThreadRef; runId: RunId };
type RewriteGroup = NonNullable<OrchestrationV2Run["rewrites"]>;

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

export function RewriteOutput({
  threadRef,
  runId,
  attribution,
}: AnswerRef & { attribution?: ModelSelection }) {
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const project = useProject(
    projection
      ? { environmentId: threadRef.environmentId, projectId: projection.thread.projectId }
      : null,
  );
  const history = useThreadHistory(threadRef);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory);
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
    const body =
      entry.kind === "message" && entry.message.role === "assistant"
        ? entry.message.text
        : entry.kind === "sent-message"
          ? entry.text
          : entry.kind === "proposed-plan"
            ? entry.proposedPlan.planMarkdown
            : "";
    const attachments =
      entry.kind === "message" && entry.message.role === "assistant"
        ? entry.message.attachments
        : undefined;
    if (!body && !attachments?.length) return [];
    if (body) text.push(body);
    return [
      <div key={entry.id}>
        {body && (
          <ChatMarkdown
            text={body}
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
  return (
    <div className="min-w-0 space-y-4">
      {attribution && (
        <div className="text-xs text-muted-foreground">
          Rewrite · {rewriteModelLabel(attribution)}
        </div>
      )}
      {history.hasMoreHistory && !reachedRunStart && (
        <Button
          size="xs"
          variant="ghost"
          disabled={history.loading}
          onClick={() =>
            void loadEarlier({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            })
          }
        >
          {history.loading ? "Loading earlier output…" : "Load earlier output"}
        </Button>
      )}
      {history.error && !reachedRunStart && <p role="status">{history.error}</p>}
      {output}
      {output.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {run?.status === "failed"
            ? "This rewrite failed."
            : run?.status === "interrupted"
              ? "This rewrite was interrupted."
              : run?.status === "completed"
                ? "This answer has no visible output."
                : "Waiting for the answer…"}
        </p>
      )}
      {attribution && text.length > 0 && (
        <MessageCopyButton text={text.join("\n\n")} label="Copy rewrite" variant="ghost" />
      )}
    </div>
  );
}

export function RewriteButton({
  threadRef,
  runId,
  group,
}: AnswerRef & { group?: RewriteGroup | undefined }) {
  const [open, setOpen] = useState(false);
  const parent = useQuietThreadShell(threadRef);
  const canOperate =
    useAtomValue(
      orchestrationEnvironment.v2.dispatchCommand.permissionAtom(threadRef.environmentId, {
        type: "thread.rewrites.start",
      }),
    ) && parent?.archivedAt == null;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  const [tab, setTab] = useState<ThreadId | null | undefined>(undefined);
  const candidateId =
    tab === undefined ? (group?.selectedThreadId ?? group?.candidates[0]?.threadId) : tab;
  const seat = group?.candidates.find((candidate) => candidate.threadId === candidateId);
  const available = useQuietThreadShell(
    open && seat ? { ...threadRef, threadId: seat.threadId } : null,
  );
  const candidate = available ? seat : undefined;
  const ref = candidate ? { ...threadRef, threadId: candidate.threadId } : threadRef;
  const viewed = useQuietThreadProjection(open && candidate ? ref : null)?.projection;
  const viewedStatus = viewed?.runs.find((run) => run.id === candidate?.runId)?.status;
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand);
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(selection?: ThreadId | null) {
    setBusy(true);
    setError("");
    try {
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
          selection === undefined
            ? { ...command, type: "thread.rewrites.start" }
            : { ...command, type: "thread.rewrites.select", candidateThreadId: selection },
      });
      if (AsyncResult.isFailure(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      } else if (selection !== undefined) {
        setOpen(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  }
  const needsCouncil = !group && settings !== null && !settings?.rewriteCouncil.length;
  const start = () => {
    setOpen(true);
    setTab(undefined);
    setError("");
    if (!group && settings?.rewriteCouncil.length) void submit();
  };
  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={!group && (!canOperate || !settings)}
        onClick={start}
      >
        Rewrites
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogPopup className="flex h-[85dvh] w-full max-w-4xl flex-col">
            <DialogHeader>
              <DialogTitle>Rewrites</DialogTitle>
            </DialogHeader>
            {group && (
              <RewriteTabs group={group} active={candidate?.threadId ?? null} onPick={setTab} />
            )}
            <DialogPanel key={candidate?.threadId ?? "original"} className="min-h-0 flex-1">
              {needsCouncil ? (
                <p>Choose the models and reasoning effort for your rewrite council in Settings.</p>
              ) : (
                <RewriteOutput threadRef={ref} runId={candidate?.runId ?? runId} />
              )}
            </DialogPanel>
            <DialogFooter>
              {candidate && viewed?.runtimeRequests.some((r) => r.status === "pending") && (
                <Button
                  variant="outline"
                  onClick={() => void navigate({ to: "/$environmentId/$threadId", params: ref })}
                >
                  Open side chat to respond
                </Button>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {needsCouncil ? (
                <Button
                  onClick={() =>
                    void navigate({
                      to: "/settings/threads",
                      search: { machine: threadRef.environmentId },
                      hash: "rewrite-council",
                    })
                  }
                >
                  Set up council
                </Button>
              ) : !group ? (
                <Button disabled={busy || !settings || !canOperate} onClick={() => void submit()}>
                  {busy ? "Starting…" : "Generate rewrites"}
                </Button>
              ) : (
                <Button
                  disabled={
                    busy ||
                    !canOperate ||
                    (candidate
                      ? viewedStatus !== "completed" && viewedStatus !== "waiting"
                      : !group.selectedThreadId)
                  }
                  onClick={() => void submit(candidate?.threadId ?? null)}
                >
                  {candidate ? "Use this rewrite" : "Use original"}
                </Button>
              )}
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

function RewriteTabs({
  group,
  active,
  onPick,
}: {
  group: RewriteGroup;
  active: ThreadId | null;
  onPick: (id: ThreadId | null) => void;
}) {
  return (
    <nav
      aria-label="Answers"
      className="flex shrink-0 gap-1 overflow-x-auto px-5 pb-2 [&>button]:shrink-0"
    >
      <Button
        size="sm"
        variant={active === null ? "secondary" : "ghost"}
        aria-pressed={active === null}
        onClick={() => onPick(null)}
      >
        Original
      </Button>
      {group.candidates.map((seat) => (
        <Button
          key={seat.threadId}
          size="sm"
          variant={active === seat.threadId ? "secondary" : "ghost"}
          aria-pressed={active === seat.threadId}
          onClick={() => onPick(seat.threadId)}
        >
          {rewriteModelLabel(seat.modelSelection)}
        </Button>
      ))}
    </nav>
  );
}
