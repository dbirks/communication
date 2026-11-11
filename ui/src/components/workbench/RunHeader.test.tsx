/**
 * notice-390-bleed: the run page's "NEW REVISION PUBLISHED" notice read at
 * ONE WORD PER LINE at 390 because the `slug in the library` chip rode
 * Alert's `action` slot — a `shrink-0` sibling beside a zero-basis text
 * column — so a ~230px chip left the sentence ~101px. The notice now wraps:
 * the text span carries a 20rem flex-basis floor inside a wrapping row, so
 * below floor + chip the chip drops to its own line and the text keeps the
 * full width, while any host wide enough still seats them side by side.
 *
 * The header itself is finding 11's contract: three rows — breadcrumb, the
 * run's sentence with ONE state-chosen primary action and a `⋯` menu holding
 * every other verb, and a labeled facts row. The primary is the whole point of
 * the finding, so each run state gets its own case, and the stream status is a
 * fact the header keeps to itself only when the stream is NOT live.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { viewNodeExecution, viewRun } from "../../api/m4view";
import { meFixture, mockFetch, projectFixture, type RouteStub } from "../../test/fakes";
import {
  WIRE_NODE_PLAN,
  WIRE_RUN_ID,
  wireNodeList,
  wireProjectId,
  wireRun,
  wireRevision,
} from "../../test/fixtures/m4/wire";
import { routes } from "../../lib/routes";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";
import { NewRevisionNotice, RunHeader, type RunHeaderProps } from "./RunHeader";

afterEach(cleanup);

function mountNotice() {
  render(
    <MemoryRouter>
      <NewRevisionNotice
        notice={{ newest: 7, pinned: 1 }}
        slug="feature-development-deterministic"
        pipelineId="pl_feat"
        revisionDigest={`sha256:${"a".repeat(64)}`}
      />
    </MemoryRouter>,
  );
}

const PHONES_BODY = 390 - 32 - 20; // viewport − workbench `px-4` − Alert `px-[10px]`
const FLOOR_REM = 20; // the text span's flex-basis floor, in rem
const GAP = 10; // the row's gap, in px
// The shortest chip the row can ever carry: a 1-char slug, `x in the library`
// in 11px mono (~106px) plus the chip's own `px-2` padding and borders.
const MIN_CHIP = 120;

describe("NewRevisionNotice", () => {
  it("words the § 7.2 sentence exactly and links to the pinned workflow", () => {
    mountNotice();
    const notice = screen.getByTestId("run-new-revision-notice");
    expect(notice.textContent).toContain(
      "revision 7 published since this run started — this run is pinned to 1 (aaaaaaaaaaaa). " +
        "The run stays on the revision it started with.",
    );
    const link = screen.getByTestId("run-new-revision-link");
    expect(link.getAttribute("href")).toBe("/workflows/pl_feat");
    expect(link.textContent).toBe("feature-development-deterministic in the library");
  });

  it("wraps the chip below the text at phone widths instead of beside a 101px column", () => {
    mountNotice();
    const link = screen.getByTestId("run-new-revision-link");
    const text = link.previousElementSibling as HTMLElement;
    const row = link.parentElement as HTMLElement;
    // The chip rides inside the Alert BODY, not the `action` slot: the row it
    // shares with the sentence wraps, and the text refuses to shrink below
    // its floor — which is what pushes the chip onto its own line at 390.
    expect(row.className).toContain("flex-wrap");
    expect(text.className).toContain("flex-1");
    expect(text.className).toContain("min-w-0");
    expect(text.className).toContain(`basis-[${FLOOR_REM}rem]`);
    expect(link.className).toContain("shrink-0");
    // And the chip never hangs past the body box on its own line: whatever
    // the slug's natural width, `max-w-full` caps it at the row and the mono
    // label wraps inside the chip (a 354px chip in a 338px body was the bleed).
    expect(link.className).toContain("max-w-full");
    // The floor + gap + the narrowest possible chip exceed a phone's body box,
    // so the pair CANNOT share a line there — the chip takes its own row and
    // the text keeps the full width. Any ≥ floor + gap + chip host still seats
    // them side by side, pixel-identical to the old layout at 1280.
    expect(FLOOR_REM * 16 + GAP + MIN_CHIP).toBeGreaterThan(PHONES_BODY);
  });
});

/* ------------------------------------------------------- the run header */

const NODES: readonly NodeExecutionSummary[] = wireNodeList.node_executions.map(viewNodeExecution);

/** The same run parked at its gate: the approval row is the one waiting. */
const waitingNodes: readonly NodeExecutionSummary[] = NODES.map((node) =>
  node.id === WIRE_NODE_PLAN
    ? {
        ...node,
        kind: "human.approval",
        node_id: "approve",
        node_instance_key: "/approve",
        status: "waiting" as const,
        waiting_reason: "approval" as const,
        finished_at: null,
      }
    : { ...node, status: "succeeded" as const },
);

/** The same run with a failed step: route 31 has a target. */
const failedNodes: readonly NodeExecutionSummary[] = NODES.map((node) =>
  node.id === WIRE_NODE_PLAN
    ? { ...node, status: "failed" as const, error_class: "agent_error" as const }
    : node,
);

function mountHeader(
  over: Partial<RunHeaderProps> = {},
  extra: RouteStub[] = [],
  initialEntries: string[] = [routes.run(WIRE_RUN_ID)],
) {
  mockFetch([
    ...extra,
    { path: "/api/v1/me", body: { ...meFixture, is_org_admin: true } },
    { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <RunHeader
          projectId={wireProjectId}
          run={viewRun(wireRun)}
          goal="ship M4"
          runTitle={null}
          slug="feature-development"
          streamStatus="live"
          revision={{
            revision_number: wireRevision.revision_number,
            revision_digest: wireRevision.revision_digest,
          }}
          nodes={NODES}
          repoName="billing-service"
          startedBy="Priya Natarajan"
          {...over}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The header's primary verb — the one button the row shows outside the menu. */
const primary = () =>
  screen.getByTestId("run-header-actions").querySelector('[data-primary="true"]');

describe("RunHeader row 2 — one primary action, chosen by the run's state", () => {
  it("a waiting run leads with Review plan, pointing at its gate", () => {
    mountHeader({
      run: viewRun({ ...wireRun, status: "waiting_human" }),
      nodes: waitingNodes,
    });

    const review = screen.getByTestId("run-review-plan");
    expect(review.textContent).toBe("Review plan");
    // Where the review affordance already lived: the workbench URL's node
    // selection, which is what opens the dock's gate card.
    const href = review.getAttribute("href") ?? "";
    expect(href).toContain("/runs/");
    expect(href).toContain("node=approve");
    expect(primary()).toBe(review);
    // The run's own state still rides the chip, in the app's word.
    expect(screen.getByTestId("run-header-status").textContent).toBe("need you");
  });

  it("a failed run leads with Retry step — the existing retry verb, renamed for the header", async () => {
    mountHeader({ run: viewRun({ ...wireRun, status: "failed" }), nodes: failedNodes });

    const retry = screen.getByTestId("run-retry");
    expect(retry.textContent).toBe("Retry step");
    expect(retry.getAttribute("title")).toContain("/plan");
    expect(primary()).toBe(retry);
    // The menu keeps the rest, and never repeats the primary verb.
    fireEvent.click(screen.getByTestId("run-more-actions"));
    const menu = screen.getByTestId("run-more-menu");
    expect(menu.textContent).toContain("Open pinned workflow");
    // The draft verb arrives with the caller's own role read.
    expect((await screen.findByTestId("run-new-draft")).textContent).toBe("Fix the workflow…");
    expect(menu.textContent).not.toContain("Retry");
  });

  it("a running run leads with Pause, and leaves Cancel to the menu", () => {
    mountHeader();

    const pause = screen.getByTestId("run-pause");
    expect(pause.textContent).toBe("Pause");
    expect(primary()).toBe(pause);

    expect(screen.queryByTestId("run-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("run-more-actions"));
    const menu = screen.getByTestId("run-more-menu");
    expect(menu.textContent).toContain("Cancel");
    expect(menu.textContent).not.toContain("Pause");
    expect(screen.getByTestId("run-cancel")).toBeTruthy();
  });

  // Finding 11, review pass on the 907a578 captures: row 2 is "the title,
  // a state chip, and one primary action", and the chip was wrapping to a
  // line BELOW the title at 1280. Flex line-breaking runs on each item's
  // hypothetical size — the h1's `auto` basis is its max-content width, the
  // whole sentence on one line — so a wrapping title column evicted the chip
  // even where the title never needed the second line. The class tokens are
  // the contract (the same reading the `NewRevisionNotice` test uses): the
  // row refuses to wrap from `sm` up, so the h1 takes the shrink instead.
  it("keeps the state chip on the title's own row, baseline-aligned (finding 11)", () => {
    mountHeader({ run: viewRun({ ...wireRun, status: "waiting_human" }), nodes: waitingNodes });

    const row = screen.getByTestId("run-header-title");
    const title = screen.getByTestId("run-title");
    // `run-header-status` is the chip's LABEL span; the chip box wraps it.
    const chipBox = screen.getByTestId("run-header-status").parentElement;
    expect(chipBox).not.toBeNull();

    // The chip is the title's sibling in the title row, not a row of its own.
    expect(title.parentElement).toBe(row);
    expect(chipBox!.parentElement).toBe(row);
    const tokens = row.className.split(/\s+/);
    // Same row from `sm` up (only a phone's wrapping title may push it down),
    // and the pair shares a baseline rather than a centred box.
    expect(tokens).toContain("sm:flex-nowrap");
    expect(tokens).toContain("items-baseline");
    // For the h1 to shrink into the space beside the chip it must be allowed
    // to go below its content width — and the chip must not be the thing that
    // gets squeezed instead.
    expect(title.className.split(/\s+/)).toContain("min-w-0");
    expect(chipBox!.className.split(/\s+/)).toContain("shrink-0");
  });

  it("a finished run has no primary at all — everything rides the menu", () => {
    mountHeader({ run: viewRun({ ...wireRun, status: "completed" }), nodes: NODES });

    expect(primary()).toBeNull();
    expect(screen.queryByTestId("run-pause")).toBeNull();
    expect(screen.queryByTestId("run-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("run-more-actions"));
    expect(screen.getByTestId("run-more-menu").textContent).toContain("Open pinned workflow");
  });
});

describe("RunHeader row 2 — the ⋯ menu", () => {
  it("opens on a button the reader can find by name, and Esc closes it", () => {
    mountHeader();
    const trigger = screen.getByTestId("run-more-actions");
    expect(trigger.getAttribute("aria-label")).toBe("More run actions");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("run-more-menu")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The ds Menu box: ink border, 2px offset shadow, pointer arrow.
    const menu = screen.getByTestId("run-more-menu");
    expect(menu.className).toContain("border-ink");
    expect(menu.className).toContain("shadow-raised");
    expect(screen.getByTestId("menu-arrow")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("run-more-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a click outside the box", () => {
    mountHeader();
    fireEvent.click(screen.getByTestId("run-more-actions"));
    expect(screen.getByTestId("run-more-menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("run-more-menu")).toBeNull();
  });
});

describe("RunHeader rows 1 and 3", () => {
  it("row 1 is the way back: the project and its Runs tab", async () => {
    mountHeader();
    const crumb = screen.getByTestId("run-breadcrumb");
    // The name arrives with the project read; until it does the crumb carries
    // the id rather than nothing.
    expect(await screen.findByText("Widgets")).toBeTruthy();
    expect(crumb.textContent).toContain("›");
    expect(crumb.textContent).not.toContain("run");
    const links = Array.from(crumb.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      routes.project(wireProjectId),
      routes.projectTab(wireProjectId, "runs"),
    ]);
  });

  it("row 3 prints the facts as labels over values", () => {
    mountHeader();
    const facts = screen.getByTestId("run-header-meta");
    expect(Array.from(facts.querySelectorAll("dt")).map((label) => label.textContent)).toEqual([
      "Workflow",
      "Repository",
      "Started",
      "Pinned digest",
    ]);
    // The label is mono uppercase; the value is the fact, not a sentence.
    expect(facts.querySelector("dt")?.className).toContain("uppercase");
    const values = Array.from(facts.querySelectorAll("dd"));
    expect(values[0].textContent).toBe("feature-development · rev 7");
    expect(values[1].textContent).toBe("billing-service");
    expect(values[1].className).toContain("font-mono");
    expect(values[2].textContent).toMatch(/ago by Priya Natarajan$/);
    // § 7.2 W4: the whole 12 hex chars, mono, so the reader can compare it
    // against the library's digests.
    expect(values[3].textContent).toBe("3f2f3f2f3f2f");
    expect(values[3].className).toContain("font-mono");
  });

  it("the rev fact links to the pinned revision, and says nothing the read cannot", () => {
    mountHeader();
    const pin = screen.getByTestId("run-pinned-revision");
    expect(pin.textContent).toBe("rev 7");
    expect(pin.getAttribute("href")).toBe(routes.workflow(wireRun.pipeline_id));

    // No revision read, no number: the digest fact still carries the pin.
    cleanup();
    mountHeader({ revision: null });
    expect(screen.queryByTestId("run-pinned-revision")).toBeNull();
    expect(screen.getByTestId("run-fact-digest").textContent).toBe("Pinned digest3f2f3f2f3f2f");
  });

  // axe `link-in-text-block` (lab-e2e a11y, workbench surfaces): a link that
  // sits inside running text — both crumbs, the facts row's `rev {n}` — must
  // be distinguishable WITHOUT colour, i.e. carry the underline class (the
  // same cue the inline links on Today/Projects/Catch up carry). `underline`
  // must be its own class token: `underline-offset-2` alone is not a cue.
  it("every inline link in the breadcrumb and the facts row is underlined, not colour-only", () => {
    mountHeader();
    const inlineLinks = [
      ...Array.from(screen.getByTestId("run-breadcrumb").querySelectorAll("a")),
      ...Array.from(screen.getByTestId("run-header-meta").querySelectorAll("a")),
    ];
    expect(inlineLinks.length).toBe(3); // project, Runs, rev 7
    for (const link of inlineLinks) {
      expect(link.className.split(/\s+/)).toContain("underline");
    }
  });

  it("leaves out the facts the run's data cannot name", () => {
    mountHeader({ repoName: null, startedBy: null });
    expect(screen.queryByTestId("run-fact-repository")).toBeNull();
    expect(screen.getByTestId("run-fact-started").textContent).toMatch(/^Started\S+ ago$/);
  });
});

describe("RunHeader stream status", () => {
  it("says nothing while the stream is live", () => {
    mountHeader({ streamStatus: "live" });
    expect(screen.queryByTestId("run-stream-status")).toBeNull();
  });

  it("speaks with the retrying glyph the moment it is not", () => {
    mountHeader({ streamStatus: "reconnecting" });
    const status = screen.getByTestId("run-stream-status");
    expect(status.textContent).toBe("↻ reconnecting");
  });
});
