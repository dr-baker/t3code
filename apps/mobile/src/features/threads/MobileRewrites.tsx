import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatCostAmount,
  getRewriteCandidateCost,
  getThreadRunCost,
} from "@t3tools/client-runtime/state/usage";
import {
  CommandId,
  type ChatAttachment,
  type OrchestrationV2Run,
  type RunId,
  type ScopedThreadRef,
  type ThreadCost,
  type ThreadId,
} from "@t3tools/contracts";
import {
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  sentMessageFromToolItem,
} from "@t3tools/shared/toolOutput";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { rewriteModelLabel } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useCallback, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, View, type ColorValue } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SymbolView } from "../../components/ui/AppSymbol";
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
  const gt = useGT();
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
          label={history.loading ? gt("Loading earlier output…") : gt("Load earlier output")}
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
            ? gt("This rewrite failed.")
            : status === "interrupted"
              ? gt("This rewrite was interrupted.")
              : status === "completed"
                ? gt("This answer has no visible output.")
                : gt("Waiting for the answer…")}
        </Text>
      )}
    </View>
  );
}

type RewriteGroup = NonNullable<OrchestrationV2Run["rewrites"]>;

function useMobileRewritesController({
  threadRef,
  runId,
  group,
}: {
  threadRef: ScopedThreadRef;
  runId: RunId;
  group: OrchestrationV2Run["rewrites"];
}) {
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

  const showReader = () => {
    setTab(undefined);
    setError("");
    setOpen(true);
    if (!group && config?.settings.rewriteCouncil.length && canOperate) submit();
  };

  return {
    config,
    canOperate,
    open,
    setOpen,
    setTab,
    error,
    busy,
    current,
    submit,
    showReader,
  };
}

function MobileRewritesModal(
  props: AnswerProps & {
    group: OrchestrationV2Run["rewrites"];
    controller: ReturnType<typeof useMobileRewritesController>;
  },
) {
  const gt = useGT();
  const { threadRef, runId, group, controller } = props;
  const { config, canOperate, open, setOpen, setTab, error, busy, current, submit } = controller;
  const selectThreadCost = useCallback(
    (result: AsyncResult.AsyncResult<ThreadCost, unknown>) =>
      Option.getOrNull(AsyncResult.value(result)),
    [],
  );
  const threadCost = useAtomValue(
    serverEnvironment.threadCost({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    selectThreadCost,
  );

  if (!open || !config) return null;

  const originalRunCost = getThreadRunCost(threadCost, runId);
  const originalCostLabel = formatCostAmount(originalRunCost?.breakdown?.direct ?? originalRunCost);
  const activeCostLabel = current
    ? formatCostAmount(getRewriteCandidateCost(threadCost, runId, current.threadId))
    : originalCostLabel;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setOpen(false)}
    >
      <SafeAreaView className="flex-1 bg-screen">
        <View className="flex-row items-center justify-between px-4">
          <View className="flex-row items-baseline gap-2">
            <Text className="font-t3-medium text-xl text-foreground">{gt("Rewrites")}</Text>
            {activeCostLabel ? (
              <Text className="text-xs tabular-nums text-foreground-secondary">
                {activeCostLabel}
              </Text>
            ) : null}
          </View>
          <Button label={gt("Close")} size="compact" tone="text" onPress={() => setOpen(false)} />
        </View>
        {group && (
          <View>
            <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}>
              <Button
                label={gt("Original")}
                size="compact"
                tone={current ? "text" : "secondary"}
                onPress={() => setTab(null)}
              />
              {group.candidates.map((seat, index) => {
                const seatCostLabel = formatCostAmount(
                  getRewriteCandidateCost(threadCost, runId, seat.threadId),
                );
                const modelName = rewriteModelLabel(seat.modelSelection);
                return (
                  <Button
                    key={seat.threadId}
                    label={
                      seatCostLabel
                        ? `${index + 1}. ${modelName} · ${seatCostLabel}`
                        : `${index + 1}. ${modelName}`
                    }
                    size="compact"
                    tone={seat.threadId === current?.threadId ? "secondary" : "text"}
                    onPress={() => setTab(seat.threadId)}
                  />
                );
              })}
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
              label={gt("Use original")}
              disabled={!group.selectedThreadId || busy || !canOperate}
              onPress={() => submit(null)}
            />
          ) : config.settings.rewriteCouncil.length ? (
            <Button
              label={gt("Generate rewrites")}
              disabled={busy || !canOperate}
              onPress={() => submit()}
            />
          ) : (
            <Text className="text-foreground-secondary">
              {gt("Choose a rewrite council in Settings → Threads.")}
            </Text>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export function MobileRewriteButton(
  props: AnswerProps & {
    group: OrchestrationV2Run["rewrites"];
    tintColor: ColorValue;
    buttonSize?: number;
    iconSize?: number;
  },
) {
  const gt = useGT();
  const { threadRef, runId, group, tintColor, buttonSize = 28, iconSize = 13 } = props;
  const controller = useMobileRewritesController({ threadRef, runId, group });
  if (!controller.config || (!group && !controller.canOperate)) return null;
  const candidateCount = group?.candidates.length ?? 0;
  const accessibilityLabel =
    candidateCount > 0 ? gt("Rewrites ({count})", { count: candidateCount }) : gt("Rewrites");
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={6}
        className="items-center justify-center"
        style={{ width: buttonSize, height: buttonSize }}
        onPress={controller.showReader}
      >
        <SymbolView name="pencil.line" size={iconSize} tintColor={tintColor} />
      </Pressable>
      <MobileRewritesModal {...props} controller={controller} />
    </>
  );
}

export function MobileRewrites(
  props: AnswerProps & {
    group: OrchestrationV2Run["rewrites"];
    adopted: RewriteGroup["candidates"][number] | undefined;
  },
) {
  const gt = useGT();
  const { threadRef, runId, group, adopted, iconColor } = props;
  const controller = useMobileRewritesController({ threadRef, runId, group });
  if (!controller.config || (!group && !controller.canOperate)) return null;
  const candidateCount = group?.candidates.length ?? 0;
  const accessibilityLabel =
    candidateCount > 0 ? gt("Rewrites ({count})", { count: candidateCount }) : gt("Rewrites");
  return (
    <View>
      {adopted ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-secondary">
            {gt("Rewrite · {model}", { model: rewriteModelLabel(adopted.modelSelection) })}
          </Text>
          <MobileAnswer
            {...props}
            threadRef={{ ...threadRef, threadId: adopted.threadId }}
            runId={adopted.runId}
          />
        </View>
      ) : null}
      <View className="mt-1 flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          hitSlop={6}
          className="size-7 items-center justify-center"
          onPress={controller.showReader}
        >
          <SymbolView name="pencil.line" size={13} tintColor={iconColor} />
        </Pressable>
      </View>
      <MobileRewritesModal {...props} controller={controller} />
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
  const gt = useGT();
  const status = useAtomValue(
    environmentThreadDetails.quietThreadAtom(threadRef),
  )?.projection.runs.find((r) => r.id === seat.runId)?.status;
  return (
    <Button
      label={
        status === "failed"
          ? gt("Rewrite failed")
          : status === "interrupted"
            ? gt("Rewrite interrupted")
            : gt("Use this rewrite")
      }
      disabled={disabled || (status !== "completed" && status !== "waiting")}
      onPress={onUse}
    />
  );
}
