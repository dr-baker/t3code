import type {
  EnvironmentId,
  UsageModelFilter,
  UsageSummaryInput,
  RewriteCandidateCost,
  ThreadCost,
  ThreadId,
  RunCost,
  RunId,
  UsageCostEstimate,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<EnvironmentId, Promise<unknown>>();

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (pending !== undefined) {
    return automatic ? undefined : ((await pending) as A);
  }
  const refreshAfter = limitsRefreshAfter.get(environmentId) ?? 0;
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < refreshAfter) return;
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      limitsRefreshes.delete(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshAfter.set(environmentId, Date.now() + 5 * 60_000);
    });
  limitsRefreshes.set(environmentId, current);
  return await current;
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({
        environmentId,
        input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
      });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}

const threadCostFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCostAmount(cost: UsageCostEstimate | null): string | null {
  if (!cost) return null;
  if (cost.costUsd === null) return null;
  const amount =
    cost.costUsd > 0 && cost.costUsd < 0.01 ? "<$0.01" : threadCostFormatter.format(cost.costUsd);
  return `${amount}${cost.partial ? "+" : ""}`;
}

export function formatThreadCost(cost: UsageCostEstimate | null): string | null {
  if (!cost) return null;
  if (cost.costUsd === null) return cost.unpricedTurns > 0 ? "API estimate unavailable" : null;
  const amount = formatCostAmount(cost);
  return amount === null ? null : `API ≈ ${amount}`;
}

const costsByRun = new WeakMap<ThreadCost, ReadonlyMap<RunId, RunCost>>();

export function getThreadRunCost(summary: ThreadCost | null, runId: RunId): RunCost | null {
  if (!summary) return null;
  let index = costsByRun.get(summary);
  if (!index) {
    index = new Map(summary.runs.map((cost) => [cost.runId, cost]));
    costsByRun.set(summary, index);
  }
  return index.get(runId) ?? null;
}

export function getRewriteCandidateCost(
  summary: ThreadCost | null,
  runId: RunId,
  candidateThreadId: ThreadId,
): RewriteCandidateCost | null {
  const runCost = getThreadRunCost(summary, runId);
  return (
    runCost?.breakdown?.rewriteCandidates?.find(
      (candidate) => candidate.threadId === candidateThreadId,
    ) ?? null
  );
}
