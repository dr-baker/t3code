import { type OrchestrationV2RunUpdateError, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class RunUpdateErrors extends Context.Service<
  RunUpdateErrors,
  {
    readonly report: (error: OrchestrationV2RunUpdateError) => Effect.Effect<void>;
    readonly clear: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
    readonly changes: (threadId?: ThreadId) => Stream.Stream<{
      readonly kind: "update-errors";
      readonly errors: ReadonlyArray<OrchestrationV2RunUpdateError>;
    }>;
  }
>()("t3/orchestration-v2/RunUpdateErrors") {}

export const make = Effect.gen(function* () {
  // Persistence failures must reach clients even while the database cannot accept a failure event.
  const errors = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, OrchestrationV2RunUpdateError>>(
    new Map(),
  );
  const report = Effect.fn("RunUpdateErrors.report")(function* (
    error: OrchestrationV2RunUpdateError,
  ) {
    yield* SubscriptionRef.update(errors, (current) => new Map(current).set(error.threadId, error));
  });
  const clear = Effect.fn("RunUpdateErrors.clear")(function* (threadId: ThreadId, runId: RunId) {
    yield* SubscriptionRef.update(errors, (current) => {
      if (current.get(threadId)?.runId !== runId) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
  });
  return RunUpdateErrors.of({
    report,
    clear,
    changes: (threadId) =>
      SubscriptionRef.changes(errors).pipe(
        Stream.map((current) => {
          const error = threadId === undefined ? undefined : current.get(threadId);
          return {
            kind: "update-errors" as const,
            errors:
              threadId === undefined
                ? Array.from(current.values())
                : error === undefined
                  ? []
                  : [error],
          };
        }),
      ),
  });
});

export const layer = Layer.effect(RunUpdateErrors, make);
