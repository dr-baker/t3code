import { useAtomValue } from "@effect/atom-react";
import {
  formatCostAmount,
  formatThreadCost,
  getThreadRunCost,
} from "@t3tools/client-runtime/state/usage";
import type { RunId, ScopedThreadRef, ThreadCost } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
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
  const gt = useGT();
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

  const breakdownLines: Array<string> = [];
  if (cost.breakdown) {
    const directAmount = formatCostAmount(cost.breakdown.direct);
    if (directAmount) breakdownLines.push(gt("Direct: {amount}", { amount: directAmount }));
    if (cost.breakdown.rewrites) {
      const rewritesAmount = formatCostAmount(cost.breakdown.rewrites);
      if (rewritesAmount) {
        breakdownLines.push(
          gt("Rewrites ({count}): {amount}", {
            count: cost.breakdown.rewrites.threadCount,
            amount: rewritesAmount,
          }),
        );
      }
    }
    if (cost.breakdown.subagents) {
      const subagentsAmount = formatCostAmount(cost.breakdown.subagents);
      if (subagentsAmount) {
        breakdownLines.push(
          gt("Subagents ({count}): {amount}", {
            count: cost.breakdown.subagents.threadCount,
            amount: subagentsAmount,
          }),
        );
      }
    }
  }
  const detailSections = [
    label,
    ...(breakdownLines.length > 0 ? [breakdownLines.join("\n")] : []),
    gt("Estimated API cost for this turn, including cache and speed pricing."),
    ...(cost.partial
      ? [gt("Partial total. Some turns, models, or provider-native subagents are not included.")]
      : []),
  ];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Turn cost: {label}", { label })}
      hitSlop={6}
      className="size-7 items-center justify-center"
      onPress={() => Dialog.alert(gt("Turn API cost"), detailSections.join("\n\n"))}
    >
      <SymbolView name="dollarsign.circle" size={13} tintColor={tintColor} />
    </Pressable>
  );
}
