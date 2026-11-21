import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatWatchOversightCadence } from "@t3tools/shared/threadWatchOversight";

import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { useQuietThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadWatches(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const threads = useThreadShells();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const watch = useAtomCommand(threadEnvironment.watchThread, { reportFailure: true });
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState<"turn" | "settled">("turn");
  const change = async (targetThreadId: ThreadId, watching: boolean) => {
    setBusy(true);
    await watch({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, targetThreadId, watching, until },
    });
    setBusy(false);
  };
  if (thread?.threadWatches === undefined) return null;
  const candidates = threads.filter(
    (candidate) =>
      candidate.environmentId === props.environmentId &&
      candidate.id !== props.threadId &&
      candidate.archivedAt === null &&
      candidate.deletedAt === null &&
      !thread.threadWatches?.some((item) => item.threadId === candidate.id && !item.ended),
  );
  return (
    <View className="gap-2 border-b border-border py-4">
      <Text className="font-t3-medium text-sm text-foreground">Thread watches</Text>
      {thread.threadWatches.map((item) => (
        <View key={item.id} className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open watched thread ${item.title}`}
            onPress={() => props.onOpen(item.threadId)}
            className="min-w-0 flex-1 py-2 active:opacity-60"
          >
            <Text numberOfLines={1} className="text-sm text-foreground">
              {item.title}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {item.ended
                ? "Ended"
                : item.oversight
                  ? formatWatchOversightCadence(item.oversight)
                  : "Watching"}
            </Text>
          </Pressable>
          <IconButton
            icon="eye.slash"
            accessibilityLabel={`${item.ended ? "Remove" : "Stop watching"} ${item.title}`}
            disabled={!canOperate || busy}
            onPress={() => void change(item.threadId, false)}
          />
        </View>
      ))}
      {canOperate &&
      thread.archivedAt === null &&
      thread.settledAt === null &&
      thread.settledOverride !== "settled" ? (
        <>
          <Menu
            actions={[
              { id: "turn", title: "Until work finishes", state: until === "turn" ? "on" : "off" },
              {
                id: "settled",
                title: "Until thread is settled",
                state: until === "settled" ? "on" : "off",
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "turn" || nativeEvent.event === "settled")
                setUntil(nativeEvent.event);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Watch duration"
              className="py-2 active:opacity-60"
            >
              <Text className="text-sm text-foreground-muted">
                {until === "turn" ? "Until work finishes" : "Until thread is settled"}
              </Text>
            </Pressable>
          </Menu>
          <Menu
            actions={candidates.map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
              attributes: { disabled: busy },
            }))}
            onPressAction={({ nativeEvent }) => {
              const candidate = candidates.find((item) => item.id === nativeEvent.event);
              if (candidate !== undefined) void change(candidate.id, true);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Watch a thread"
              disabled={busy || candidates.length === 0}
              className="py-2 active:opacity-60"
            >
              <Text className="text-sm text-accent">Watch a thread…</Text>
            </Pressable>
          </Menu>
        </>
      ) : null}
    </View>
  );
}
