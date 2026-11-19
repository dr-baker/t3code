import { useAtom, useAtomValue } from "@effect/atom-react";
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
  type ThreadId,
} from "@t3tools/contracts";
import { rewriteModelLabel } from "@t3tools/shared/model";
import { Atom } from "effect/reactivity";
import { PenLineIcon } from "lucide-react";
import { useState } from "react";

import { useLongLivedAssetUrl } from "../../assets/longLivedAssetUrls";
import { useRightPanelStore } from "../../rightPanelStore";
import { isImageAttachment, type ChatAttachment } from "../../types";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { WorkLogList, WorkLogRow } from "./WorkLog";
import { workEntryDisplayLabel } from "./MessagesTimeline.logic";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { MessageCopyButton } from "./MessageCopyButton";

export type AnswerRef = { threadRef: ScopedThreadRef; runId: RunId };
export type RewriteGroup = NonNullable<OrchestrationV2Run["rewrites"]>;

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
  showActivity = false,
}: AnswerRef & { attribution?: ModelSelection; showActivity?: boolean }) {
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
  return (
    <div className="min-w-0 space-y-4">
      {attribution && (
        <div className="text-xs text-muted-foreground">
          Rewrite · {rewriteModelLabel(attribution)}
        </div>
      )}
      {!reachedRunStart && <EarlierRewriteHistory threadRef={threadRef} />}
      {activity.length > 0 && (
        <div className="rounded-md bg-muted/30">
          <CollapsibleSectionHeader
            expanded={activityOpen}
            onClick={() => setActivityOpen(!activityOpen)}
          >
            Activity ({activity.length})
          </CollapsibleSectionHeader>
          {activityOpen && (
            <div className="max-h-48 overflow-y-auto px-2 pb-2">
              <WorkLogList>
                {activity.map(({ id, entry }) => (
                  <WorkLogRow
                    key={id}
                    label={workEntryDisplayLabel(entry, project?.workspaceRoot)}
                  />
                ))}
              </WorkLogList>
            </div>
          )}
        </div>
      )}
      {output}
      {output.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {run?.status === "failed"
            ? "This rewrite failed."
            : run?.status === "interrupted" ||
                run?.status === "cancelled" ||
                run?.status === "rolled_back"
              ? "This rewrite was interrupted."
              : run?.status === "completed" || run?.status === "waiting"
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

export function EarlierRewriteHistory({ threadRef }: Pick<AnswerRef, "threadRef">) {
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
          {history.loading ? "Loading earlier output…" : "Load earlier output"}
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
  const { canOperate, submit } = useRewriteCommand({ threadRef, runId }, !!group);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      disabled={!group && (!canOperate || !settings)}
      onClick={() => {
        useRightPanelStore.getState().openRewrites(threadRef, runId);
        if (!group && settings?.rewriteCouncil.length) void submit();
      }}
    >
      <PenLineIcon />
      Rewrites
    </Button>
  );
}
