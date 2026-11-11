import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { memo, useId, useState } from "react";

import { cn } from "~/lib/utils";

type TodoPlan = Extract<OrchestrationV2PlanArtifact, { kind: "todo_list" }>;

export const ComposerPlan = memo(function ComposerPlan({
  plan,
  working,
}: {
  plan: TodoPlan;
  working: boolean;
}) {
  const complete = plan.steps.every((step) => step.status === "completed");
  if (plan.steps.length === 0) return null;
  return (
    <PlanDetails key={`${plan.id}:${complete}`} plan={plan} working={working} complete={complete} />
  );
});

function PlanDetails({
  plan,
  working,
  complete,
}: {
  plan: TodoPlan;
  working: boolean;
  complete: boolean;
}) {
  const [expanded, setExpanded] = useState(!complete && plan.steps.length <= 5);
  const detailsId = useId();
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const current =
    plan.steps.find((step) => step.status === "running") ??
    plan.steps.find((step) => step.status === "pending");
  return (
    <section aria-label="Current plan" className="relative z-10 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-t-xl px-3 py-2.5 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {complete ? (
          <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
        ) : (
          <ListTodoIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-xs text-muted-foreground max-sm:sr-only">Plan</span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {complete ? "Plan complete" : current?.text}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {done} / {plan.steps.length}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")}
        />
      </button>
      <div id={detailsId} hidden={!expanded}>
        <ol className="max-h-48 space-y-1 overflow-y-auto px-3 pb-3">
          {plan.steps.map((step) => {
            const running = working && step.status === "running";
            const completed = step.status === "completed";
            const Icon = completed ? CheckIcon : running ? CircleDotIcon : CircleIcon;
            return (
              <li key={step.id} className="flex items-start gap-2.5 py-1">
                <Icon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    completed ? "text-success" : running ? "text-info" : "text-muted-foreground",
                  )}
                />
                <span className="sr-only">
                  {completed ? "Completed: " : running ? "In progress: " : "Pending: "}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 wrap-anywhere",
                    completed ? "text-muted-foreground" : running && "font-medium",
                  )}
                >
                  {step.text}
                </span>
                {running ? (
                  <span className="shrink-0 text-xs text-info max-sm:sr-only">In progress</span>
                ) : null}
              </li>
            );
          })}
        </ol>
        {!working && !complete ? (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            Turn ended · {plan.steps.length - done}{" "}
            {plan.steps.length - done === 1 ? "step" : "steps"} remaining
          </p>
        ) : null}
      </div>
    </section>
  );
}
