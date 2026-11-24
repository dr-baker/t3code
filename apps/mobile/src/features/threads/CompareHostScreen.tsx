import { useAtomMount } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { StackActions, useNavigation } from "@react-navigation/native";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/cn";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { ThreadScreenFallback } from "./ThreadScreenHost";

const compareHostVisitTracker = createThreadVisitTracker({
  threadShellAtom: environmentThreadShells.threadShellAtom,
  sessionGenerationAtom: environmentCatalog.sessionGenerationAtom,
  visit: threadEnvironment.visit,
});

function ContenderStatusPill(props: { readonly shell: EnvironmentThreadShell | null }) {
  const { shell } = props;
  if (!shell) return null;
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return (
      <View className="rounded-full bg-warning/20 px-2 py-0.5">
        <Text className="text-xs font-medium text-warning-foreground">
          <T>Approval</T>
        </Text>
      </View>
    );
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return (
      <View className="rounded-full bg-warning/20 px-2 py-0.5">
        <Text className="text-xs font-medium text-warning-foreground">
          <T>Input</T>
        </Text>
      </View>
    );
  }
  if (shell.latestRun?.status === "failed") {
    return (
      <View className="rounded-full bg-destructive/15 px-2 py-0.5">
        <Text className="text-xs font-medium text-destructive">
          <T>Failed</T>
        </Text>
      </View>
    );
  }
  if (threadRuntimeIsActive(shell.runtime)) {
    return (
      <View className="rounded-full bg-subtle px-2 py-0.5">
        <Text className="text-xs font-medium text-foreground-muted">
          <T>Running</T>
        </Text>
      </View>
    );
  }
  return (
    <View className="rounded-full bg-subtle px-2 py-0.5">
      <Text className="text-xs font-medium text-foreground-muted">
        <T>Ready</T>
      </Text>
    </View>
  );
}

function CompareContenderCard(props: {
  readonly environmentId: EnvironmentId;
  readonly contenderId: ThreadId;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly onOpen: (contenderId: ThreadId) => void;
  readonly onPickWinner: (contenderId: ThreadId) => void;
  readonly onPopOut: (contenderId: ThreadId) => void;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.contenderId));
  const modelName = shell ? formatModelSlugName(shell.modelSelection.model) : "…";
  const previewText = shell?.source.latestVisibleMessage?.text?.trim() ?? "";

  return (
    <View className="overflow-hidden rounded-xl border border-border bg-surface">
      <Pressable
        accessibilityRole="button"
        className="px-4 py-3"
        onPress={() => props.onOpen(props.contenderId)}
      >
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-medium text-foreground" numberOfLines={1}>
            {modelName}
          </Text>
          <ContenderStatusPill shell={shell} />
        </View>
        {previewText.length > 0 ? (
          <Text className="mt-1.5 text-sm text-foreground-muted" numberOfLines={3}>
            {previewText}
          </Text>
        ) : null}
      </Pressable>

      <View className="flex-row items-center gap-2 border-t border-border/70 px-3 py-2">
        <Pressable
          accessibilityRole="button"
          disabled={!props.canOperate || props.busy}
          className="rounded-lg bg-subtle px-3 py-1.5"
          onPress={() => props.onPickWinner(props.contenderId)}
        >
          <Text className="text-xs font-medium text-foreground">
            <T>Pick winner</T>
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!props.canOperate || props.busy}
          className="rounded-lg px-3 py-1.5"
          onPress={() => props.onPopOut(props.contenderId)}
        >
          <Text className="text-xs font-medium text-foreground-muted">
            <T>Pop out</T>
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function CompareHostScreen(props: {
  readonly hostThread: EnvironmentThreadShell;
  readonly hideHeader?: boolean;
}) {
  const { hostThread } = props;
  const gt = useGT();
  const navigation = useNavigation();
  const goBack = useWorkspaceBackNavigation();
  const canOperate = useEnvironmentScope(hostThread.environmentId, AuthOrchestrationOperateScope);
  const pickWinner = useAtomCommand(threadEnvironment.pickCompareWinner, { reportFailure: false });
  const undoPick = useAtomCommand(threadEnvironment.undoComparePick, { reportFailure: false });
  const popOut = useAtomCommand(threadEnvironment.popOutCompareContender, { reportFailure: false });
  const [busy, setBusy] = useState(false);

  useAtomMount(compareHostVisitTracker(scopeThreadRef(hostThread.environmentId, hostThread.id)));

  const contenderIds = hostThread.compare?.contenderThreadIds ?? [];

  const handleOpen = (contenderId: ThreadId) => {
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(hostThread.environmentId),
        threadId: String(contenderId),
      }),
    );
  };

  const handlePickWinner = async (winnerThreadId: ThreadId) => {
    if (busy || !canOperate) return;
    setBusy(true);
    const result = await pickWinner({
      environmentId: hostThread.environmentId,
      input: { threadId: hostThread.id, winnerThreadId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Could not pick winner"),
          error instanceof Error ? error.message : undefined,
        );
      }
      return;
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(hostThread.environmentId),
        threadId: String(winnerThreadId),
      }),
    );
    Dialog.alert(gt("Picked winner"), gt("Other models were settled."), [
      {
        text: gt("Undo"),
        onPress: () => {
          void undoPick({
            environmentId: hostThread.environmentId,
            input: { threadId: hostThread.id },
          }).then((undoResult) => {
            if (undoResult._tag !== "Success") return;
            navigation.dispatch(
              StackActions.replace("Thread", {
                environmentId: String(hostThread.environmentId),
                threadId: String(hostThread.id),
              }),
            );
          });
        },
      },
      { text: gt("Done"), style: "cancel" },
    ]);
  };

  const handlePopOut = async (contenderThreadId: ThreadId) => {
    if (busy || !canOperate) return;
    setBusy(true);
    const result = await popOut({
      environmentId: hostThread.environmentId,
      input: { threadId: hostThread.id, contenderThreadId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Could not pop out thread"),
          error instanceof Error ? error.message : undefined,
        );
      }
      return;
    }
    if (contenderIds.length <= 1) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(hostThread.environmentId),
          threadId: String(contenderThreadId),
        }),
      );
    }
  };

  return (
    <ThreadScreenFallback
      header={
        props.hideHeader ? undefined : (
          <AppBar
            title={hostThread.title}
            subtitle={gt("{count} models comparing", { count: contenderIds.length })}
            onBackToList={goBack}
            hideBottomBorder
          />
        )
      }
    >
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen android:bg-transparent"
        contentContainerStyle={{ padding: 16, gap: 12 }}
      >
        <Text className="text-xs font-medium text-foreground-muted">
          <T>
            Comparing <Var>{contenderIds.length}</Var> models. Tap any model to inspect or steer it.
          </T>
        </Text>
        {contenderIds.map((contenderId) => (
          <CompareContenderCard
            key={contenderId}
            environmentId={hostThread.environmentId}
            contenderId={contenderId}
            busy={busy}
            canOperate={canOperate}
            onOpen={handleOpen}
            onPickWinner={(id) => void handlePickWinner(id)}
            onPopOut={(id) => void handlePopOut(id)}
          />
        ))}
      </ScreenScrollView>
    </ThreadScreenFallback>
  );
}

function ContenderPill(props: {
  readonly environmentId: EnvironmentId;
  readonly contenderId: ThreadId;
  readonly active: boolean;
  readonly onSelect: (contenderId: ThreadId) => void;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.contenderId));
  const label = shell ? formatModelSlugName(shell.modelSelection.model) : "…";
  const needs =
    shell?.hasPendingApprovals === true || shell?.pendingSubagentRequest === "approval"
      ? "approval"
      : shell?.hasPendingUserInput === true || shell?.pendingSubagentRequest === "user_input"
        ? "input"
        : null;

  return (
    <Pressable
      accessibilityRole="button"
      className={cn(
        "flex-row items-center gap-1.5 rounded-full px-3 py-1",
        props.active ? "bg-foreground" : "bg-subtle",
      )}
      onPress={() => props.onSelect(props.contenderId)}
    >
      {needs !== null ? (
        <View
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            needs === "approval" ? "bg-warning-foreground" : "bg-adaptive-indigo-600-300",
          )}
        />
      ) : null}
      <Text
        className={cn("text-xs font-medium", props.active ? "text-screen" : "text-foreground")}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Shown above a contender's timeline when viewing a compare model on mobile,
 * letting the user switch sibling models or pick the current model as winner.
 */
export function CompareContenderSwitcherBar(props: {
  readonly environmentId: EnvironmentId;
  readonly hostThreadId: ThreadId;
  readonly currentContenderId: ThreadId;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const hostShell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.hostThreadId));
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const pickWinner = useAtomCommand(threadEnvironment.pickCompareWinner, { reportFailure: false });
  const undoPick = useAtomCommand(threadEnvironment.undoComparePick, { reportFailure: false });
  const [busy, setBusy] = useState(false);

  const contenderIds = hostShell?.compare?.contenderThreadIds ?? [];
  if (contenderIds.length === 0) return null;

  const handleSelect = (contenderId: ThreadId) => {
    if (contenderId === props.currentContenderId) return;
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(props.environmentId),
        threadId: String(contenderId),
      }),
    );
  };

  const handlePick = async () => {
    if (busy || !canOperate) return;
    setBusy(true);
    const result = await pickWinner({
      environmentId: props.environmentId,
      input: { threadId: props.hostThreadId, winnerThreadId: props.currentContenderId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Could not pick winner"),
          error instanceof Error ? error.message : undefined,
        );
      }
      return;
    }
    Dialog.alert(gt("Picked winner"), gt("Other models were settled."), [
      {
        text: gt("Undo"),
        onPress: () => {
          void undoPick({
            environmentId: props.environmentId,
            input: { threadId: props.hostThreadId },
          }).then((undoResult) => {
            if (undoResult._tag !== "Success") return;
            navigation.dispatch(
              StackActions.replace("Thread", {
                environmentId: String(props.environmentId),
                threadId: String(props.hostThreadId),
              }),
            );
          });
        },
      },
      { text: gt("Done"), style: "cancel" },
    ]);
  };

  return (
    <View
      className={cn(
        "flex-row items-center gap-2 border-b border-border/60 px-3 py-2",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row items-center gap-1.5 pr-2">
          {contenderIds.map((contenderId) => (
            <ContenderPill
              key={contenderId}
              environmentId={props.environmentId}
              contenderId={contenderId}
              active={contenderId === props.currentContenderId}
              onSelect={handleSelect}
            />
          ))}
        </View>
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        disabled={!canOperate || busy}
        className="rounded-full bg-subtle px-3 py-1"
        onPress={() => void handlePick()}
      >
        <Text className="text-xs font-medium text-foreground">
          <T>Pick</T>
        </Text>
      </Pressable>
    </View>
  );
}
