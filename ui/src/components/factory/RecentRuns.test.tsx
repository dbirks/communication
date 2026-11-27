/**
 * RecentRuns: the rows are the scope's runs newest first, ten at a time until
 * "Show more" is pressed; the project name rides the row only in the
 * All-projects scope; a run that was never named says how it started rather
 * than nothing; the state is glyph + word in the state's colour; child runs are
 * not listed as runs; and the empty sentence only comes from a read that
 * answered with nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RecentRuns, recentRuns, runTriggerWords } from "./RecentRuns";
import type { CrossProjectRunSummary } from "../../api/home";
import { mockFetch, projectFixture, type RouteStub } from "../../test/fakes";

const now = Date.UTC(2026, 10, 20, 12, 0, 0);
/** An ISO instant `minutes` before the fixed clock the fixtures are built on. */
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

let counter = 0;
function runFixture(overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary {
  counter += 1;
  return {
    id: `01987a9a-4444-7000-8000-${String(counter).padStart(12, "0")}`,
    project_id: projectFixture.id,
    pipeline_id: "01987a9a-5555-7000-8000-eeeeeeeeeeee",
    pipeline_revision_id: "01987a9a-6666-7000-8000-ffffffffffff",
    revision_digest: "sha256:1",
    plan_digest: "sha256:2",
    status: "completed",
    depth: 0,
    priority: 0,
    created_at: ago(30),
    project_name: "Project One",
    pipeline_slug: "wf-1",
    pipeline_display_name: "Workflow One",
    title: "Ship the change",
    steps: [],
    ...overrides,
  };
}

/** Build a run whose instant comes from a minute offset (keeps order obvious). */
function runAt(minutesAgo: number, overrides: Partial<CrossProjectRunSummary> = {}) {
  return runFixture({ created_at: ago(minutesAgo), ...overrides });
}

function mount(runs: CrossProjectRunSummary[] | null, props: { scope: string | null }) {
  const stubs: RouteStub[] = [
    {
      path: "/api/v1/runs",
      body: runs
        ? { runs, next_cursor: null }
        : (): never => {
            throw new Error("unused");
          },
    },
  ];
  if (runs === null) {
    stubs[0] = { path: "/api/v1/runs", status: 500, body: null };
  }
  mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RecentRuns scope={props.scope} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The row ids in the order the section printed them. */
function printedRowIds() {
  return Array.from(document.querySelectorAll("[data-testid^='recent-run-']"))
    .map((node) => (node.getAttribute("data-testid") ?? "").replace("recent-run-", ""))
    .filter((id) => id.startsWith("01987a9a"));
}

afterEach(() => {
  cleanup();
  counter = 0;
});

describe("RecentRuns", () => {
  it("prints the newest run first, in a row that links to the workbench", async () => {
    mount(
      [
        runAt(600, { id: "01987a9a-4444-7000-8000-000000000001" }),
        runAt(60, { id: "01987a9a-4444-7000-8000-000000000002" }),
        runAt(5, { id: "01987a9a-4444-7000-8000-000000000003" }),
      ],
      { scope: null },
    );
    await screen.findByTestId("recent-runs");
    expect(printedRowIds()).toEqual([
      "01987a9a-4444-7000-8000-000000000003",
      "01987a9a-4444-7000-8000-000000000002",
      "01987a9a-4444-7000-8000-000000000001",
    ]);
    const row = screen.getByTestId("recent-run-01987a9a-4444-7000-8000-000000000003");
    expect(row.getAttribute("href")).toBe("/runs/01987a9a-4444-7000-8000-000000000003");
    expect(row.textContent).toContain("Workflow One");
    expect(row.textContent).toContain("Ship the change");
    expect(screen.getByTestId("recent-runs-heading").textContent).toBe("Recent runs");
    expect(screen.getByTestId("recent-runs-heading").className).toContain("uppercase");
  });

  it("shows ten rows, and twenty after Show more", async () => {
    const rows = Array.from({ length: 25 }, (_row, index) => runAt((index + 1) * 10));
    mount(rows, { scope: null });
    await screen.findByTestId("recent-runs");
    expect(printedRowIds()).toHaveLength(10);
    fireEvent.click(screen.getByTestId("recent-runs-more"));
    expect(printedRowIds()).toHaveLength(20);
    fireEvent.click(screen.getByTestId("recent-runs-more"));
    expect(printedRowIds()).toHaveLength(25);
    expect(screen.queryByTestId("recent-runs-more")).toBeNull();
  });

  it("names the project only when showProject is on", async () => {
    mount([runAt(10, { project_name: "Project One" })], { scope: null });
    const allRow = await screen.findByTestId(
      "recent-run-project-01987a9a-4444-7000-8000-000000000001",
    );
    expect(allRow.textContent).toBe("Project One");
    expect(allRow.className).toContain("text-accent-text");
    cleanup();

    counter = 0;
    mount([runAt(10, { project_name: "Project One" })], { scope: projectFixture.id });
    await screen.findByTestId(/^recent-run-01987a9a/);
    expect(screen.queryByTestId(/^recent-run-project-/)).toBeNull();
  });

  it("says the state as glyph and word in the state's colour", async () => {
    mount(
      [
        runAt(10, { id: "01987a9a-4444-7000-8000-0000000000a1", status: "running" }),
        runAt(20, { id: "01987a9a-4444-7000-8000-0000000000a2", status: "waiting_human" }),
        runAt(30, { id: "01987a9a-4444-7000-8000-0000000000a3", status: "failed" }),
        runAt(40, { id: "01987a9a-4444-7000-8000-0000000000a4", status: "completed" }),
        runAt(50, { id: "01987a9a-4444-7000-8000-0000000000a5", status: "cancelled" }),
      ],
      { scope: null },
    );
    await screen.findByTestId("recent-runs");
    const word = (id: string) =>
      screen.getByTestId(`recent-run-state-${id}`).textContent?.replace(/\s+/g, " ").trim();
    expect(word("01987a9a-4444-7000-8000-0000000000a1")).toBe("● running");
    expect(word("01987a9a-4444-7000-8000-0000000000a2")).toBe("! waiting");
    expect(word("01987a9a-4444-7000-8000-0000000000a3")).toBe("× failed");
    expect(word("01987a9a-4444-7000-8000-0000000000a4")).toBe("✓ done");
    expect(word("01987a9a-4444-7000-8000-0000000000a5")).toBe("⊘ interrupted");
    expect(
      screen.getByTestId("recent-run-state-01987a9a-4444-7000-8000-0000000000a3").className,
    ).toContain("text-st-failed-tag-fg");
  });

  it("falls back to how the run started when it was never named", async () => {
    mount(
      [
        runAt(10, {
          id: "01987a9a-4444-7000-8000-0000000000b1",
          title: null,
          trigger: { kind: "issue", ref: "acme/widgets#12" },
        }),
        runAt(20, {
          id: "01987a9a-4444-7000-8000-0000000000b2",
          title: null,
          trigger: { kind: "manual", ref: null },
        }),
        runAt(30, {
          id: "01987a9a-4444-7000-8000-0000000000b3",
          title: null,
        }),
      ],
      { scope: null },
    );
    await screen.findByTestId("recent-runs");
    expect(
      screen.getByTestId("recent-run-detail-01987a9a-4444-7000-8000-0000000000b1").textContent,
    ).toBe("started from issue acme/widgets#12");
    expect(
      screen.getByTestId("recent-run-detail-01987a9a-4444-7000-8000-0000000000b2").textContent,
    ).toBe("started by hand");
    // A run with no title and no trigger invents no sentence.
    expect(
      screen.queryByTestId("recent-run-detail-01987a9a-4444-7000-8000-0000000000b3"),
    ).toBeNull();
  });

  it("lists runs, not the child runs inside them", async () => {
    mount(
      [
        runAt(10, { id: "01987a9a-4444-7000-8000-0000000000c1" }),
        runAt(5, { id: "01987a9a-4444-7000-8000-0000000000c2", depth: 1 }),
      ],
      { scope: null },
    );
    await screen.findByTestId("recent-runs");
    expect(printedRowIds()).toEqual(["01987a9a-4444-7000-8000-0000000000c1"]);
  });

  it("prints one empty sentence when the read answered with nothing", async () => {
    mount([], { scope: null });
    const empty = await screen.findByTestId("recent-runs-empty");
    expect(empty.textContent).toBe("No runs yet.");
  });

  it("says nothing while the read is in flight or broken", async () => {
    mount(null, { scope: null });
    await waitFor(() => expect(screen.queryByTestId("recent-runs")).toBeNull());
    expect(screen.queryByTestId("recent-runs-empty")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("recent-runs")).toBeNull();
  });
});

describe("recentRuns / runTriggerWords", () => {
  it("orders by the moment the run ended when it has one", () => {
    const rows = [
      runAt(100, { id: "01987a9a-4444-7000-8000-0000000000d1", finished_at: ago(2) }),
      runAt(50, { id: "01987a9a-4444-7000-8000-0000000000d2" }),
      runAt(10, { id: "01987a9a-4444-7000-8000-0000000000d3", status: "running" }),
    ];
    expect(recentRuns(rows).map((row) => row.id)).toEqual([
      "01987a9a-4444-7000-8000-0000000000d1",
      "01987a9a-4444-7000-8000-0000000000d3",
      "01987a9a-4444-7000-8000-0000000000d2",
    ]);
  });

  it("words each trigger kind, and nothing at all for a row that has none", () => {
    expect(runTriggerWords(runAt(1, { trigger: { kind: "manual", ref: null } }))).toBe(
      "started by hand",
    );
    expect(runTriggerWords(runAt(1, { trigger: { kind: "schedule", ref: "sch-1" } }))).toBe(
      "started on a schedule",
    );
    expect(runTriggerWords(runAt(1, { trigger: { kind: "thread", ref: null } }))).toBe(
      "started from a chat",
    );
    expect(runTriggerWords(runAt(1, { trigger: { kind: "issue" } }))).toBe("started from an issue");
    expect(runTriggerWords(runAt(1))).toBe("");
  });
});
