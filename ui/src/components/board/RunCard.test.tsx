/**
 * The board card, against the DOM: the segmented bar's aria label spells the
 * counts (state is never color alone), the per-state action rows behave
 * (NEEDS YOU opens the run for the decision, FAILED links into the workbench),
 * and clicking the card hands the run id to the board's `?run=` handler.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunCard } from "./RunCard";
import type { CrossProjectRun, CrossProjectRunStep } from "./columns";

afterEach(cleanup);

const NOW = new Date(2026, 5, 18, 14, 0, 0);

function steps(states: CrossProjectRunStep["state"][]): CrossProjectRunStep[] {
  const ids = ["plan", "implement", "test", "publish"];
  return states.map((state, index) => ({
    node_id: ids[index % ids.length],
    kind: "agent.acp",
    state,
  }));
}

function run(
  overrides: Partial<CrossProjectRun> & { source_conversation_id?: string | null } = {},
): CrossProjectRun {
  return {
    id: "9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000",
    project_id: "p1",
    pipeline_id: "w1",
    pipeline_revision_id: "r1",
    revision_digest: "d",
    plan_digest: "d",
    status: "running",
    depth: 0,
    priority: 0,
    created_at: NOW.toISOString(),
    started_at: null,
    finished_at: null,
    project_name: "acme-api",
    pipeline_slug: "process-ready-issues",
    pipeline_display_name: "process-ready-issues",
    steps: steps(["succeeded", "succeeded", "running", "pending"]),
    ...overrides,
  };
}

function renderCard(run: CrossProjectRun, onOpenRun = vi.fn()) {
  render(
    <MemoryRouter>
      <RunCard run={run} onOpenRun={onOpenRun} now={NOW} />
    </MemoryRouter>,
  );
  return { onOpenRun };
}

describe("RunCard", () => {
  it("shows the workflow line, the title fallback, the project chip and the age", () => {
    renderCard(run());
    const card = screen.getByTestId("board-card-9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000");
    expect(card.textContent).toContain("process-ready-issues");
    expect(card.textContent).toContain("#9c1e");
    expect(card.textContent).toContain("acme-api");
    expect(card.textContent).toContain("0m");
  });

  it("leads with the run's own title when the server serves one (ADR-0064)", () => {
    renderCard(run({ title: "Export invoices as CSV" }));
    const card = screen.getByTestId("board-card-9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000");
    expect(card.textContent).toContain("Export invoices as CSV");
    // The fallback keeps the card's mono identity line honest: slug + #id stay.
    expect(card.textContent).toContain("#9c1e");
  });

  it("spells the segmented bar's counts in its aria-label and names the current step", () => {
    renderCard(run());
    expect(screen.getByRole("img", { name: "2 of 4 steps done, 1 running" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(
      screen.getByTestId("board-card-step-9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000").textContent,
    ).toContain("test");
  });

  it("saying 'not available' is the only way to show empty step data", () => {
    renderCard(run({ steps: [] }));
    expect(screen.getByText("step progress not available")).toBeTruthy();
  });

  it("a running card has no action row and opens on click", () => {
    const { onOpenRun } = renderCard(run());
    expect(screen.queryByText("Approve")).toBeNull();
    fireEvent.click(screen.getByTestId("board-card-open-9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000"));
    expect(onOpenRun).toHaveBeenCalledWith("9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000");
  });

  it("a waiting card offers Approve and Read plan, both opening the run", () => {
    const { onOpenRun } = renderCard(
      run({
        status: "waiting_human",
        steps: steps(["succeeded", "waiting", "pending", "pending"]),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Read plan" }));
    expect(onOpenRun).toHaveBeenCalledTimes(2);
    expect(onOpenRun).toHaveBeenCalledWith("9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000");
  });

  it("a failed card links both actions into the run workbench and names the failed step", () => {
    const { onOpenRun } = renderCard(
      run({ status: "failed", steps: steps(["succeeded", "succeeded", "failed", "pending"]) }),
    );
    const retry = screen.getByRole("link", { name: /Retry from publish/ });
    const fix = screen.getByRole("link", { name: "Fix the workflow" });
    expect(retry.getAttribute("href")).toBe("/runs/9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000");
    expect(fix.getAttribute("href")).toBe("/runs/9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000");
    expect(onOpenRun).not.toHaveBeenCalled();
  });
});

describe("RunCard — trigger badge", () => {
  const badgeId = "board-trigger-badge-9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000";

  it("a manual run renders no badge", () => {
    renderCard(run({ trigger: { kind: "manual", ref: null } }));
    expect(screen.queryByTestId(badgeId)).toBeNull();
  });

  it("a scheduled run renders the ⏱ scheduled badge", () => {
    renderCard(run({ trigger: { kind: "schedule", ref: "sch-12" } }));
    const badge = screen.getByTestId(badgeId);
    expect(badge.textContent).toContain("scheduled");
  });

  it("an issue run renders the #number badge linking to the GitHub issue when the ref parses", () => {
    renderCard(run({ trigger: { kind: "issue", ref: "acme/api#512" } }));
    const badge = screen.getByTestId(badgeId);
    expect(badge.getAttribute("href")).toBe("https://github.com/acme/api/issues/512");
    expect(badge.textContent).toContain("#512");
  });

  it("an unparseable issue ref renders no badge", () => {
    renderCard(run({ trigger: { kind: "issue", ref: "not-a-ref" } }));
    expect(screen.queryByTestId(badgeId)).toBeNull();
  });

  it("a thread run renders the ↩ from thread badge linking to the thread", () => {
    renderCard(
      run({
        trigger: { kind: "thread", ref: null },
        source_conversation_id: "conv-1",
      }),
    );
    const badge = screen.getByTestId(badgeId);
    expect(badge.getAttribute("href")).toBe("/threads/conv-1");
    expect(badge.textContent).toContain("from thread");
  });

  it("a thread run without a source conversation renders no badge", () => {
    renderCard(run({ trigger: { kind: "thread", ref: null } }));
    expect(screen.queryByTestId(badgeId)).toBeNull();
  });
});
