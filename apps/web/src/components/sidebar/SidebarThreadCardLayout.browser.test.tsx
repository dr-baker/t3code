import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";
import { SidebarThreadCardLayout } from "./SidebarThreadCardLayout";

function row(compact: boolean) {
  return (
    <SidebarThreadCardLayout compact={compact} metadata={<div>feature/sidebar</div>}>
      <div className="flex h-5 items-center gap-1.5">
        <span>SettingsUI</span>
        <span>Claude</span>
        <span>Codex</span>
        <button type="button">Settle</button>
      </div>
      <div className="mt-1">Clarify glass rendering modes</div>
    </SidebarThreadCardLayout>
  );
}

it("removes the metadata line and its height, and restores it when expanded", async () => {
  await using screen = await render(row(false));
  const expandedHeight = screen.container.firstElementChild!.getBoundingClientRect().height;
  await expect.element(screen.getByText("feature/sidebar")).toBeVisible();
  await screen.rerender(row(true));
  await expect.element(screen.getByText("feature/sidebar")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Settle" })).toBeVisible();
  const project = screen.getByText("SettingsUI").element().getBoundingClientRect();
  const claude = screen.getByText("Claude").element().getBoundingClientRect();
  const codex = screen.getByText("Codex").element().getBoundingClientRect();
  const title = screen.getByText("Clarify glass rendering modes").element().getBoundingClientRect();
  expect(claude.top).toBe(project.top);
  expect(codex.top).toBe(project.top);
  expect(claude.left).toBeGreaterThan(project.right);
  expect(title.top).toBeGreaterThanOrEqual(project.bottom);
  expect(screen.container.firstElementChild!.getBoundingClientRect().height).toBeLessThan(
    expandedHeight,
  );
  await screen.rerender(row(false));
  await expect.element(screen.getByText("feature/sidebar")).toBeVisible();
  expect(screen.container.firstElementChild!.getBoundingClientRect().height).toBe(expandedHeight);
});
