import { useAtomValue } from "@effect/atom-react";
import { formatThreadCost, getThreadRunCost } from "@t3tools/client-runtime/state/usage";
import type { RunId, ScopedThreadRef, ThreadCost } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CircleDollarSignIcon } from "lucide-react";

import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function TurnCostButton({ threadRef, runId }: { threadRef: ScopedThreadRef; runId: RunId }) {
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
            aria-label={`Turn cost: ${label}`}
          />
        }
      >
        <CircleDollarSignIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="top" align="start" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          <p className="font-medium tabular-nums">{label}</p>
          <p className="text-muted-foreground">
            Estimated API cost for this turn, including cache and speed pricing.
          </p>
          {cost.partial ? (
            <p className="text-muted-foreground">
              Partial total. Some usage or models are missing, or subagent usage is excluded.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
