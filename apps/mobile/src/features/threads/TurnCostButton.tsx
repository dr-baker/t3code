import { useAtomValue } from "@effect/atom-react";
import { formatThreadCost, getThreadRunCost } from "@t3tools/client-runtime/state/usage";
import type { RunId, ScopedThreadRef, ThreadCost } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";

export function TurnCostButton({
  threadRef,
  runId,
  tintColor,
}: {
  threadRef: ScopedThreadRef;
  runId: RunId;
  tintColor: ColorValue;
}) {
  const selectCost = useCallback(
    (result: AsyncResult.AsyncResult<ThreadCost, unknown>) =>
      getThreadRunCost(Option.getOrNull(AsyncResult.value(result)), runId),
    [runId],
  );
  const cost = useAtomValue(
    serverEnvironment.threadCost({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    selectCost,
  );
  const label = formatThreadCost(cost);
  if (!cost || !label) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Turn cost: ${label}`}
      hitSlop={6}
      className="size-7 items-center justify-center"
      onPress={() =>
        Dialog.alert(
          "Turn API cost",
          `${label}\n\nEstimated API cost for this turn, including cache and speed pricing.${cost.partial ? "\n\nPartial total. Some usage or models are missing, or subagent usage is excluded." : ""}`,
        )
      }
    >
      <SymbolView name="dollarsign.circle" size={13} tintColor={tintColor} />
    </Pressable>
  );
}
