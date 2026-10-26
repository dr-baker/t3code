import { useRef, useState } from "react";
import { expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import { PinnedThreadActivity } from "./PinnedThreadActivity";
import "../../index.css";

const now = "2026-10-24T10:05:00Z";
function question() {
  return makeThreadFixture({
    hasPendingUserInput: true,
    runtime: {
      status: "running",
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      activeRunId: null,
      lastError: null,
      updatedAt: now,
    },
  });
}

function Fixture({
  threads,
  initiallyHidden = false,
  dragging = false,
}: {
  threads: readonly SidebarThreadSummary[];
  initiallyHidden?: boolean;
  dragging?: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [hidden, setHidden] = useState(initiallyHidden);
  return (
    <div style={{ position: "relative", width: 300 }}>
      <div data-slot="scroll-area-viewport" style={{ height: 180, overflow: "auto" }}>
        <ul ref={listRef}>
          <li style={{ height: 500 }}>Active threads</li>
          <li data-testid="sidebar-pinned-header">
            <button type="button">Pinned section</button>
            {!hidden ? (
              <span data-thread-item="pin">
                <span data-sidebar-pinned-icon="pin">Pin icon</span>
              </span>
            ) : null}
          </li>
        </ul>
      </div>
      <PinnedThreadActivity
        threads={threads}
        now={now}
        expanded={false}
        hidden={hidden}
        dragging={dragging}
        animate={false}
        listRef={listRef}
        onReveal={() => setHidden(false)}
      />
    </div>
  );
}

it("reveals offscreen pins, restores their icons, and hides when the section is visible", async () => {
  await using screen = await render(<Fixture threads={[question()]} initiallyHidden />);
  const pill = screen.getByRole("button", { name: "Show pinned activity: 1 question pending" });
  await expect.element(pill).toBeVisible();
  await pill.click();
  await expect.element(screen.getByText("Pin icon")).toBeVisible();
  await expect.element(pill).not.toBeInTheDocument();
  expect(document.activeElement?.textContent).toBe("Pinned section");
});

it("updates activity while offscreen and returns when scrolling away from pins", async () => {
  await using screen = await render(<Fixture threads={[question()]} />);
  const pill = screen.getByRole("button", { name: "Show pinned activity: 1 question pending" });
  await expect.element(pill).toBeVisible();
  await screen.rerender(<Fixture threads={[makeThreadFixture({ runtime: null })]} />);
  await expect.element(pill).not.toBeInTheDocument();
  await screen.rerender(<Fixture threads={[question()]} />);
  await expect.element(pill).toBeVisible();
  await pill.click();
  await expect.element(pill).not.toBeInTheDocument();
  await act(() => {
    screen.container.querySelector('[data-slot="scroll-area-viewport"]')!.scrollTop = 0;
  });
  await expect.element(pill).toBeVisible();
  await screen.rerender(<Fixture threads={[question()]} dragging />);
  await expect.element(pill).not.toBeInTheDocument();
});
