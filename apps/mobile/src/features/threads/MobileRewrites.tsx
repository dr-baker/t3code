import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type ChatAttachment,
  type OrchestrationV2Run,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  sentMessageFromToolItem,
} from "@t3tools/shared/toolOutput";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { rewriteModelLabel } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, View, type ColorValue } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useQuietThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadHtmlRender } from "./HtmlRenderWebView";
import { ThreadMcpApp } from "./McpAppWebView";

type AnswerProps = {
  threadRef: ScopedThreadRef;
  runId: RunId;
  renderText: (text: string) => ReactNode;
  renderAttachments: (attachments: ReadonlyArray<ChatAttachment>) => ReactNode;
  width: number;
  iconColor: ColorValue;
};

function MobileAnswer({
  threadRef,
  runId,
  renderText,
  renderAttachments,
  width,
  iconColor,
}: AnswerProps) {
  const detail = useAtomValue(environmentThreadDetails.quietThreadAtom(threadRef));
  const status = detail?.projection.runs.find((r) => r.id === runId)?.status;
  const history = useAtomValue(environmentThreadDetails.historyAtom(threadRef));
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const items = useAtomValue(environmentThreadDetails.visibleTurnItemsAtom(threadRef)).filter(
    (row) => row.sourceThreadId === threadRef.threadId && row.item.runId === runId,
  );
  const reachedRunStart = items.some(
    ({ item }) => item.type === "user_message" && item.inputIntent === "turn_start",
  );
  const output = items.map(({ item, sourceItemId }) => {
    if (item.type === "dynamic_tool") {
      const htmlRender = item.status === "completed" ? htmlRenderFromToolItem(item) : undefined;
      if (htmlRender)
        return (
          <ThreadHtmlRender
            key={item.id}
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            render={htmlRender}
            frameWidth={width}
            iconColor={iconColor}
          />
        );
      const sent = item.status === "completed" ? sentMessageFromToolItem(item) : undefined;
      if (sent !== undefined) return <View key={item.id}>{renderText(sent)}</View>;
      const app = mcpAppFromToolItem(item);
      if (app)
        return (
          <ThreadMcpApp
            key={item.id}
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            conversationThreadId={threadRef.threadId}
            itemId={sourceItemId}
            revision={turnItemDetailRevision(item)}
            app={app}
            width={width}
          />
        );
      return null;
    }
    if (item.type === "proposed_plan") {
      return <View key={item.id}>{renderText(item.markdown)}</View>;
    }
    if (item.type !== "assistant_message") return null;
    const attachments = item.attachments ?? [];
    return item.text || attachments.length ? (
      <View key={item.id}>
        {item.text ? renderText(item.text) : null}
        {renderAttachments(attachments)}
      </View>
    ) : null;
  });
  return (
    <View className="gap-3">
      {history.hasMoreHistory && !reachedRunStart ? (
        <Button
          label={history.loading ? "Loading earlier output…" : "Load earlier output"}
          size="compact"
          tone="text"
          disabled={history.loading}
          onPress={() =>
            void loadEarlier({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            })
          }
        />
      ) : null}
      {history.error && !reachedRunStart ? (
        <Text className="text-foreground-secondary">{history.error}</Text>
      ) : null}
      {output.some(Boolean) ? (
        output
      ) : (
        <Text className="text-foreground-secondary">
          {status === "failed"
            ? "This rewrite failed."
            : status === "interrupted"
              ? "This rewrite was interrupted."
              : status === "completed"
                ? "This answer has no visible output."
                : "Waiting for the answer…"}
        </Text>
      )}
    </View>
  );
}

type RewriteGroup = NonNullable<OrchestrationV2Run["rewrites"]>;

export function MobileRewrites(
  props: AnswerProps & {
    group: OrchestrationV2Run["rewrites"];
    adopted: RewriteGroup["candidates"][number] | undefined;
  },
) {
  const { threadRef, runId, group, adopted } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const parent = useQuietThreadShell(threadRef);
  const canOperate =
    useAtomValue(
      orchestrationEnvironment.v2.dispatchCommand.permissionAtom(threadRef.environmentId, {
        type: "thread.rewrites.start",
      }),
    ) && parent?.archivedAt == null;
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, "rewrite answer");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ThreadId | null | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const candidateId =
    tab === undefined ? (group?.selectedThreadId ?? group?.candidates[0]?.threadId) : tab;
  const candidate = group?.candidates.find((c) => c.threadId === candidateId);
  const available = useQuietThreadShell(
    open && candidate ? { ...threadRef, threadId: candidate.threadId } : null,
  );
  const current = available ? candidate : undefined;
  function submit(selection?: ThreadId | null) {
    setBusy(true);
    setError("");
    const base = {
      commandId: CommandId.make(uuidv4()),
      threadId: threadRef.threadId,
      runId,
      createdBy: "user",
      creationSource: "mobile",
    } as const;
    const showError = (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause));
    void dispatch({
      environmentId: threadRef.environmentId,
      input:
        selection === undefined
          ? { ...base, type: "thread.rewrites.start" }
          : { ...base, type: "thread.rewrites.select", candidateThreadId: selection },
    }).then(
      (result) => {
        if (AsyncResult.isFailure(result)) showError(squashAtomCommandFailure(result));
        else if (selection !== undefined) setOpen(false);
        setBusy(false);
      },
      (cause: unknown) => {
        showError(cause);
        setBusy(false);
      },
    );
  }
  if (!config || (!group && !canOperate)) return null;
  const showReader = () => {
    setTab(undefined);
    setError("");
    setOpen(true);
    if (!group && config.settings.rewriteCouncil.length && canOperate) submit();
  };
  return (
    <View>
      {adopted ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-secondary">
            Rewrite · {rewriteModelLabel(adopted.modelSelection)}
          </Text>
          <MobileAnswer
            {...props}
            threadRef={{ ...threadRef, threadId: adopted.threadId }}
            runId={adopted.runId}
          />
        </View>
      ) : null}
      <Pressable accessibilityRole="button" onPress={showReader} className="self-start px-1 py-2">
        <Text className="text-xs text-primary-text">Rewrites</Text>
      </Pressable>
      {open && (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setOpen(false)}
        >
          <SafeAreaView className="flex-1 bg-screen">
            <View className="flex-row items-center justify-between px-4">
              <Text className="font-t3-medium text-xl text-foreground">Rewrites</Text>
              <Button label="Close" size="compact" tone="text" onPress={() => setOpen(false)} />
            </View>
            {group && (
              <View>
                <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}>
                  <Button
                    label="Original"
                    size="compact"
                    tone={current ? "text" : "secondary"}
                    onPress={() => setTab(null)}
                  />
                  {group.candidates.map((seat, index) => (
                    <Button
                      key={seat.threadId}
                      label={`${index + 1}. ${rewriteModelLabel(seat.modelSelection)}`}
                      size="compact"
                      tone={seat.threadId === current?.threadId ? "secondary" : "text"}
                      onPress={() => setTab(seat.threadId)}
                    />
                  ))}
                </ScrollView>
              </View>
            )}
            <ScrollView key={current?.threadId ?? "original"} className="flex-1 px-4 py-3">
              <MobileAnswer
                {...props}
                threadRef={current ? { ...threadRef, threadId: current.threadId } : threadRef}
                runId={current?.runId ?? runId}
              />
            </ScrollView>
            <View className="gap-2 px-4 py-2">
              {error ? (
                <Text accessibilityRole="alert" className="text-danger-foreground">
                  {error}
                </Text>
              ) : null}
              {current ? (
                <MobileUseAnswer
                  threadRef={{ ...threadRef, threadId: current.threadId }}
                  seat={current}
                  disabled={busy || !canOperate}
                  onUse={() => submit(current.threadId)}
                />
              ) : group ? (
                <Button
                  label="Use original"
                  disabled={!group.selectedThreadId || busy || !canOperate}
                  onPress={() => submit(null)}
                />
              ) : config.settings.rewriteCouncil.length ? (
                <Button
                  label="Generate rewrites"
                  disabled={busy || !canOperate}
                  onPress={() => submit()}
                />
              ) : (
                <Text className="text-foreground-secondary">
                  Choose a rewrite council in Settings → Threads.
                </Text>
              )}
            </View>
          </SafeAreaView>
        </Modal>
      )}
    </View>
  );
}

function MobileUseAnswer({
  threadRef,
  seat,
  disabled,
  onUse,
}: {
  threadRef: ScopedThreadRef;
  seat: RewriteGroup["candidates"][number];
  disabled: boolean;
  onUse: () => void;
}) {
  const status = useAtomValue(
    environmentThreadDetails.quietThreadAtom(threadRef),
  )?.projection.runs.find((r) => r.id === seat.runId)?.status;
  return (
    <Button
      label={
        status === "failed"
          ? "Rewrite failed"
          : status === "interrupted"
            ? "Rewrite interrupted"
            : "Use this rewrite"
      }
      disabled={disabled || (status !== "completed" && status !== "waiting")}
      onPress={onUse}
    />
  );
}
