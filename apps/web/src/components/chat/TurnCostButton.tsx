import { useAtomValue } from "@effect/atom-react";
import {
  formatCostAmount,
  formatThreadCost,
  getThreadRunCost,
} from "@t3tools/client-runtime/state/usage";
import type { RunId, ScopedThreadRef, ThreadCost } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { CircleDollarSignIcon } from "lucide-react";

import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function TurnCostButton({ threadRef, runId }: { threadRef: ScopedThreadRef; runId: RunId }) {
  const gt = useGT();
  const selectCost = (result: AsyncResult.AsyncResult<ThreadCost, unknown>) =>
    getThreadRunCost(Option.getOrNull(AsyncResult.value(result)), runId);
  const cost = useAtomValue(
    serverEnvironment.threadCost({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    selectCost,
  );
  const label = formatThreadCost(cost);
  if (!cost || !label) return null;

  const breakdown = cost.breakdown;
  const directAmount = breakdown ? formatCostAmount(breakdown.direct) : null;
  const rewritesAmount = breakdown?.rewrites ? formatCostAmount(breakdown.rewrites) : null;
  const subagentsAmount = breakdown?.subagents ? formatCostAmount(breakdown.subagents) : null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Turn cost: {label}", { label })}
          />
        }
      >
        <CircleDollarSignIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="top" align="start" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          <p className="font-medium tabular-nums">{label}</p>
          {breakdown ? (
            <div className="flex flex-col gap-0.5 tabular-nums text-muted-foreground">
              {directAmount ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <T>Direct</T>
                  </span>
                  <span>{directAmount}</span>
                </div>
              ) : null}
              {breakdown.rewrites && rewritesAmount ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <T>
                      Rewrites (<Var>{breakdown.rewrites.threadCount}</Var>)
                    </T>
                  </span>
                  <span>{rewritesAmount}</span>
                </div>
              ) : null}
              {breakdown.subagents && subagentsAmount ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <T>
                      Subagents (<Var>{breakdown.subagents.threadCount}</Var>)
                    </T>
                  </span>
                  <span>{subagentsAmount}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="text-muted-foreground">
            <T>Estimated API cost for this turn, including cache and speed pricing.</T>
          </p>
          {cost.partial ? (
            <p className="text-muted-foreground">
              <T>
                Partial total. Some turns, models, or provider-native subagents are not included.
              </T>
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
