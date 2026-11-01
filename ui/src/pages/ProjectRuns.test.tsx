/**
 * The runs list as a real route: rows come from `GET /projects/{id}/runs`
 * through the same hooks the preview's live seam proved, the filter chips are
 * the design's, and the empty/404 states are honest.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";
import { queryKeys } from "../api/queries";
import { STATES } from "../components/ds/states";
import {
  WIRE_RUN_ID,
  wirePipelineList,
  wireProjectId,
  wireRun,
  wireRunList,
} from "../test/fixtures/m4/wire";
import { RunsListColumn, defaultRunsFilter, shortId } from "./ProjectRuns";

const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;
const childRun = { ...wireRun, id: "01987b11-0000-0000-8000-00000000000c", depth: 1 };

function routes(runs: unknown = wireRunList, extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: RUNS_PATH, body: runs },
  ];
}

function mountRuns(runs?: unknown, extra: RouteStub[] = []) {
  return renderApp({ path: `/projects/${wireProjectId}/runs`, routes: routes(runs, extra) });
}

describe("/projects/:projectId/runs", () => {
  it("lists top-level runs from the API with a readable title and state", async () => {
    const { requests } = mountRuns({ runs: [...wireRunList.runs, childRun] });

    const list = await screen.findByTestId("runs-list");
    const row = await within(list).findByTestId(`run-row-${WIRE_RUN_ID}`);
    // The row titles itself with the workflow slug from the library: this row
    // carries no `title` (a pre-ADR-0064 server or an unnamed run), and an id
    // never stands IN PLACE OF a name (pass-2 review: `#30OABCBF …` was).
    expect(row.textContent).toContain("feature-development");
    expect(within(row).getByTestId("run-status").textContent).toContain("running");
    // Rule 06: the chip carries the app's STATES glyph with its short word.
    expect(within(row).getByTestId("run-status").parentElement?.textContent).toContain(
      STATES.running.glyph,
    );
    // No unlabelled hex digest on the row: the revision the run is pinned to
    // is said on the run's own page, not as noise here.
    expect(row.textContent).not.toContain("3f2f3f2f3f2f");
    expect(requestsTo(requests, RUNS_PATH)).toHaveLength(1);

    // A child run belongs to its parent's tree, never to this list.
    expect(within(list).queryByTestId(`run-row-${childRun.id}`)).toBeNull();
  });

  it("prints the run's own title and repository when the server serves them (ADR-0064)", async () => {
    const titled = {
      ...wireRun,
      title: "Add saved cards to checkout",
      repository_id: "01987b11-0000-0000-8000-0000000000fe",
      repository_name: "widgets-core",
    };
    mountRuns({ runs: [titled] });

    const row = await screen.findByTestId(`run-row-${WIRE_RUN_ID}`);
    expect(row.textContent).toContain("Add saved cards to checkout");
    // The repository joins the mono line with the clock; the digest stays off.
    expect(row.textContent).toContain("widgets-core");
    expect(row.textContent).not.toContain("3f2f3f2f3f2f");
    // The titled row does not also print the slug headline — one name per row.
    expect(row.textContent).not.toContain("feature-development");
  });

  it("opens on a lens with rows, and an empty lens still says which one is empty", async () => {
    mountRuns({ runs: [{ ...wireRun, status: "waiting_human" }] });

    // `active` is empty here, so the column does not open on it: the first
    // non-empty lens in active → attention → waiting → all is pressed instead,
    // and the waiting run is on screen at once.
    expect(await screen.findByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
    expect(screen.getByTestId("runs-filter-active").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("runs-filter-attention").getAttribute("aria-pressed")).toBe("true");

    // Choosing an empty lens is still an honest empty answer, not a silent one.
    fireEvent.click(screen.getByTestId("runs-filter-active"));
    expect((await screen.findByTestId("runs-empty")).textContent).toContain("No active runs");

    fireEvent.click(screen.getByTestId("runs-filter-all"));
    expect(await screen.findByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
  });

  it("the attention lens gathers runs a person owes or that broke", async () => {
    const broken = [
      { ...wireRun, id: "01987b11-0000-0000-8000-0000000000a1", status: "failed" },
      { ...wireRun, id: "01987b11-0000-0000-8000-0000000000a2", status: "interrupted" },
      { ...wireRun, id: "01987b11-0000-0000-8000-0000000000a3", status: "waiting_human" },
    ];
    mountRuns({ runs: [wireRun, ...broken] });

    // Wait for the list to have data, then read the counts off the chips.
    expect(await screen.findByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
    // 4a leads with the attention lens: waiting, paused, failed, interrupted.
    const chip = screen.getByTestId("runs-filter-attention");
    expect(chip.textContent).toContain("attention 3");
    // The lens opens on `active` because active work exists in this project.
    expect(screen.queryByTestId(`run-row-${broken[0].id}`)).toBeNull();

    fireEvent.click(chip);
    for (const run of broken) {
      expect(await screen.findByTestId(`run-row-${run.id}`)).toBeTruthy();
    }
    // A healthy running run is not "needing attention".
    expect(screen.queryByTestId(`run-row-${WIRE_RUN_ID}`)).toBeNull();
  });

  it("shows the honest empty state when the project has never run", async () => {
    mountRuns({ runs: [] });
    expect((await screen.findByTestId("runs-empty")).textContent).toContain("No runs yet");
  });

  it("renders the 1b frame — band, tabs marked, no rail, no blank detail pane", async () => {
    // The page used to be a two-column grid whose right column was a large
    // empty "Pick a run to open…" pane. m5-layout live: at 390x844 the fixed
    // 15–20rem rail took 320 of the 358px the page had, that column collapsed
    // to 38px, and its "Pipelines" link hung past the viewport at right 423px.
    // Design 1b has one navigation in the header band, and a run row is a link
    // to the run page — so there is no detail column to starve, and nothing on
    // the phone is a blank pane.
    mountRuns({ runs: [] });
    const shell = await screen.findByTestId("project-runs");
    expect(shell.querySelector('[data-testid="project-header"]')).not.toBeNull();
    const tabs = within(screen.getByTestId("project-tabs"));
    expect(tabs.getByTestId("project-tab-runs").getAttribute("aria-current")).toBe("page");
    expect(tabs.getByTestId("project-tab-overview").getAttribute("aria-current")).toBeNull();
    // One navigation on the page: the old left section rail is gone.
    expect(screen.getAllByRole("navigation", { name: /project sections/i })).toHaveLength(1);
    // The honest empty state is the list's own, not a pointer at an inspector.
    expect(await screen.findByTestId("runs-empty")).toBeTruthy();
    expect(screen.queryByText(/Pick a run/)).toBeNull();
    expect(screen.queryByText(/execution tree and timeline\./)).toBeNull();
    expect(shell.textContent).not.toContain("Pipelines decide");
  });

  it("says the state in the app's short word, not the wire's status", async () => {
    mountRuns({ runs: [{ ...wireRun, status: "waiting_human" }] });
    const row = await screen.findByTestId(`run-row-${WIRE_RUN_ID}`);
    // A run's state is the app's short word — the same table the overview's
    // rows and the stage strip print. Rule 06 (pass-1 review
    // project-1b-runs): the chip carries the STATES glyph beside the word,
    // so the state is never word/colour alone.
    expect(within(row).getByTestId("run-status").textContent).toBe("need you");
    expect(within(row).getByTestId("run-status").parentElement?.textContent).toContain(
      STATES.waiting.glyph,
    );
    expect(row.textContent).not.toContain("waiting human");
  });

  it("renders a 404 as a 404 rather than an empty list", async () => {
    mountRuns(undefined, [
      {
        path: RUNS_PATH,
        status: 404,
        body: { type: "about:blank", title: "Not Found", status: 404 },
      },
    ]);
    expect(await screen.findByTestId("project-runs-not-found")).toBeTruthy();
    expect(screen.queryByTestId("runs-list")).toBeNull();
  });

  it("links each row to the run inspector route", async () => {
    mountRuns();
    const row = await screen.findByTestId(`run-row-${WIRE_RUN_ID}`);
    expect(row.getAttribute("href")).toBe(`/runs/${WIRE_RUN_ID}`);
    // The title is the workflow slug, not an upper-cased id-handle — but the
    // handle rides the mono line BESIDE the name (pass-1 review
    // project-1b-runs: two unnamed runs of one workflow were
    // indistinguishable), README-style.
    expect(row.textContent).toContain("feature-development");
    expect(row.textContent).toContain(`#${shortId(WIRE_RUN_ID)}`);
  });
});

/**
 * One door into the form (pass-2 review): the RUNS panel dropped its own
 * "New run" button — the header band's `Start run` navigates here with
 * `?new=1`, which opens `NewRunForm` above the list.
 */
describe("the Runs tab opens its form through the band's Start run", () => {
  it("presses no form on a plain visit — and the panel has no button of its own", async () => {
    mountRuns();
    expect(await screen.findByTestId("runs-list")).toBeTruthy();
    // No panel button of its own any more…
    expect(screen.queryByTestId("runs-new")).toBeNull();
    // …and no form on a plain visit to the tab.
    expect(screen.queryByTestId("new-run-form")).toBeNull();
    // The band's verb carries the intent in the URL.
    expect(screen.getByTestId("project-start-run").getAttribute("href")).toBe(
      `/p/${wireProjectId}/runs?new=1`,
    );
  });

  it("opens NewRunForm above the list at ?new=1, and Cancel cleans the URL", async () => {
    renderApp({ path: `/projects/${wireProjectId}/runs?new=1`, routes: routes() });
    expect(await screen.findByTestId("new-run-form", undefined, { timeout: 5_000 })).toBeTruthy();
    fireEvent.click(screen.getByTestId("new-run-cancel"));
    expect(screen.queryByTestId("new-run-form")).toBeNull();
  });
});

/**
 * The opening lens (runs-default-filter): a list that lands on an empty filter
 * makes the project look idle when it is only parked elsewhere.
 */
describe("the opening lens of the runs list", () => {
  const WAITING = [
    { ...wireRun, id: "01987b11-0000-0000-8000-0000000000b1", status: "waiting_human" },
    { ...wireRun, id: "01987b11-0000-0000-8000-0000000000b2", status: "waiting_human" },
  ];

  it("picks the first non-empty lens, falling back to all", () => {
    expect(defaultRunsFilter({ active: 0, waiting: 2 })).toBe("waiting");
    expect(defaultRunsFilter({ active: 1, attention: 3, waiting: 2, all: 6 })).toBe("active");
    expect(defaultRunsFilter({ active: 0, attention: 2, waiting: 2, all: 4 })).toBe("attention");
    expect(defaultRunsFilter({ active: 0, attention: 0, waiting: 0, all: 0 })).toBe("all");
  });

  it("keeps the lens a person clicked through a refetch", async () => {
    const { queryClient, requests } = mountRuns({ runs: WAITING });

    // Wait for what the refetch actually depends on: the first response on
    // screen and the query settled. The chips render while the first GET is
    // still in flight, and while it is, `refetchQueries` reuses that in-flight
    // request rather than starting a second one (query-core `Query#fetch`
    // cancels only a fetch that already has data) — so counting "the second
    // request" after a chip alone was the flake: on a fast tick the response
    // had landed, on a loaded CI runner it had not, and the refetch was
    // deduped away. Requiring `success` + `fetchStatus: "idle"` + exactly one
    // request closes that window instead of racing it.
    expect(await screen.findByTestId(`run-row-${WAITING[0].id}`)).toBeTruthy();
    await waitFor(() => {
      const state = queryClient.getQueryState(queryKeys.runs(wireProjectId));
      expect(state?.status).toBe("success");
      expect(state?.fetchStatus).toBe("idle");
    });
    expect(requestsTo(requests, RUNS_PATH)).toHaveLength(1);
    // The data latched the lens onto `attention`; the click below is the human
    // choice that a later refetch must not move.
    expect(screen.getByTestId("runs-filter-attention").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("runs-filter-active").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByTestId("runs-filter-active"));
    expect(screen.getByTestId("runs-filter-active").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.runs(wireProjectId) });
    });

    // The refetch really happened — and the lens did not move under the click.
    expect(requestsTo(requests, RUNS_PATH)).toHaveLength(2);
    expect(screen.getByTestId("runs-filter-active").getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByTestId("runs-empty")).textContent).toContain("No active runs");
  });

  it("lists the open run even when the lens excludes it", async () => {
    const parked = {
      ...wireRun,
      id: "01987b11-0000-0000-8000-0000000000b3",
      status: "interrupted",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    mockFetch(routes({ runs: [wireRun, parked] }));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RunsListColumn projectId={wireProjectId} selectedRunId={parked.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // There is active work, so the list opens on it — but the run whose page is
    // open (interrupted: not active) is still listed, and still marked.
    const row = await screen.findByTestId(`run-row-${parked.id}`);
    expect(screen.getByTestId("runs-filter-active").getAttribute("aria-pressed")).toBe("true");
    expect(row.className).toContain("shadow-(--shadow-raised)");
    expect(screen.queryByTestId(`run-row-${WIRE_RUN_ID}`)).toBeTruthy();
  });
});

/**
 * The non-member case (M5 QA): `/runs` used to render the run column around a
 * project the reader cannot open, with a raw 500 banner where the list should
 * have been. The project's own refusal is the page's answer now.
 */
describe("/projects/:projectId/runs as a non-member", () => {
  const problem = (status: number) => ({
    type: "about:blank",
    title: status === 403 ? "Forbidden" : "Not Found",
    status,
    detail: status === 403 ? "Nope." : "No such project.",
  });

  it("shows the project refusal instead of the shell when the runs read is 404", async () => {
    mountRuns(undefined, [
      {
        path: `/api/v1/projects/${wireProjectId}`,
        status: 404,
        body: problem(404),
      },
      { path: RUNS_PATH, status: 404, body: problem(404) },
    ]);

    expect((await screen.findByTestId("project-runs-not-found")).textContent).toContain(
      "Project not found or you do not have access",
    );
    // Not a shell with partial data: no run column, no "New run", no rail.
    expect(screen.queryByTestId("project-runs")).toBeNull();
    expect(screen.queryByTestId("runs-list")).toBeNull();
    expect(screen.queryByTestId("runs-new")).toBeNull();
    expect(screen.queryByText(/Internal Server Error/)).toBeNull();
  });

  it("shows the same refusal when the project read answers 403", async () => {
    mountRuns({ runs: [] }, [
      { path: `/api/v1/projects/${wireProjectId}`, status: 403, body: problem(403) },
    ]);

    expect((await screen.findByTestId("project-runs-not-found")).textContent).toContain(
      "Project not found or you do not have access",
    );
    expect(screen.queryByTestId("runs-empty")).toBeNull();
  });

  it("keeps the banner in place for a failure that is not an access refusal", async () => {
    mountRuns(undefined, [{ path: RUNS_PATH, status: 500, body: problem(500) }]);

    expect(await screen.findByTestId("runs-list")).toBeTruthy();
    expect(screen.queryByTestId("project-runs-not-found")).toBeNull();
  });
});
