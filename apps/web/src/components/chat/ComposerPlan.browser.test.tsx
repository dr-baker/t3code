import {
  NodeId,
  PlanId,
  RunId,
  ThreadId,
  type OrchestrationV2PlanArtifact,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { ComposerPlan } from "./ComposerPlan";

it("keeps a hidden plan dismissed through updates and temporary absence, then shows a new plan", async () => {
  const plan = {
    id: PlanId.make("composer-plan-1"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: NodeId.make("node-1"),
    kind: "todo_list",
    status: "active",
    steps: [
      { id: "inspect", text: "Inspect the layout", status: "completed" },
      { id: "check", text: "Check the controls", status: "running" },
    ],
  } satisfies OrchestrationV2PlanArtifact;
  await using screen = await render(<ComposerPlan plan={plan} working />);
  await expect.element(screen.getByRole("button", { name: "Hide plan" })).toBeVisible();
  await screen.getByRole("button", { name: "Hide plan" }).click();
  await expect
    .element(screen.getByRole("region", { name: "Current plan" }))
    .not.toBeInTheDocument();
  expect(screen.container.querySelector("[data-chat-composer-plan]")).toBeNull();

  await screen.rerender(
    <ComposerPlan
      plan={{
        ...plan,
        status: "completed",
        steps: plan.steps.map((step) => ({ ...step, status: "completed" })),
      }}
      working={false}
    />,
  );
  await expect
    .element(screen.getByRole("region", { name: "Current plan" }))
    .not.toBeInTheDocument();
  await screen.rerender(<ComposerPlan plan={null} working={false} />);
  await screen.rerender(<ComposerPlan plan={plan} working />);
  await expect
    .element(screen.getByRole("region", { name: "Current plan" }))
    .not.toBeInTheDocument();

  const nextPlan = { ...plan, id: PlanId.make("composer-plan-2") };
  await screen.rerender(<ComposerPlan plan={nextPlan} working />);
  await expect.element(screen.getByRole("region", { name: "Current plan" })).toBeVisible();
  await screen.getByRole("button", { name: "Hide plan" }).click();
  await screen.rerender(<ComposerPlan plan={plan} working />);
  await expect
    .element(screen.getByRole("region", { name: "Current plan" }))
    .not.toBeInTheDocument();
});
