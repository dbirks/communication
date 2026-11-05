/**
 * The Lanes view's OWN contract (goal item 3, design 3b): nothing here proved
 * that dragging an issue into RUNNING starts a workflow. What this file
 * asserts, against a mocked API and no browser:
 *
 * - the drag: the card is the source, the RUNNING lane lights (dashed accent
 *   border over an accent-tint fill) with its in-flight preview, and the drop
 *   opens the `START #<n> WITH` menu anchored on the caught card WITH its
 *   pointer arrow (ds/Menu — the handoff's "all popovers/menus get an arrow");
 * - the start: choosing a workflow POSTs the run with the issue bound to the
 *   input the PINNED REVISION declares (ADR-0066 `input_specs` — the input is
 *   named `ticket` here, so a hard-coded `issue` would fail), plus the ADR-0064
 *   `issue: {number}` trigger fact, the issue's title as the run title, and
 *   ONE idempotency key on both the body and the header (ADR-0023 § 12);
 * - the result: the page moves onto the run it started, and once the run list
 *   answers with it the card sits in RUNNING as a live run card;
 * - the keyboard path (`Start…`) opens the same menu and starts the same run;
 * - the refusal: a failed start says so in the menu with the server's own
 *   words, the issue card stays where it is, and nothing navigates;
 * - the card's geometry: a long unbreakable issue title (`assign_copilot_to_
 *   issue`) breaks inside its own column and the `Start…` button never
 *   shrinks — the rcn-3b verification pass caught the title painting under
 *   the button at 1280x900, and jsdom has no layout, so this asserts the
 *   structure and the wrapping classes that make the overlap impossible.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoLanes } from "./RepoLanes";
import type { GitHubIssue, GitHubIssueList, useRepoIssues } from "../../api/issues";
import type {
  Assignment,
  ConversationSummary,
  PipelineRevision,
  Repository,
  RunSummary,
} from "../../api/types";
import {
  conversationSummaryFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RecordedRequest,
  type RouteStub,
} from "../../test/fakes";
import { testidOf } from "../../lib/format";
import { WIRE_PIPELINE_ID, wireAssignmentList, wireRevision } from "../../test/fixtures/m4/wire";

const repository: Repository = {
  id: "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0",
  project_id: projectFixture.id,
  name: "communication",
  git_url: "https://github.com/example/communication.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "none",
};

/** The repo's enabled pins — the menu's only workflow candidates. */
const issuePin: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repository.id,
  repository_name: repository.name,
};
const issuePinKey = testidOf(issuePin.id);

/** A second enabled pin whose pinned revision declares NO `github_issue`
 * input: the menu has no right to offer it, so it stays out. */
const plainPin: Assignment = {
  ...issuePin,
  id: "01987b22-2222-7000-8000-abcdef012345",
  pinned_revision_id: "01987b21-7777-7000-8000-abcdef012345",
};

const issue: GitHubIssue = {
  number: 512,
  title: "The build is red",
  body: "CI is failing on main.",
  labels: ["bug"],
  html_url: "https://github.com/example/communication/issues/512",
  state: "open",
  updated_at: "2026-11-01T17:00:00Z",
  body_truncated: false,
};

const issueList: GitHubIssueList = {
  repository: "example/communication",
  state: "open",
  items: [issue],
};

/** The issue pin's pinned revision (ADR-0066): the issue input is named
 * `ticket` — NOT `issue` — so the posted body proves the menu binds the issue
 * to the input the revision declares rather than to a name the UI guessed.
 * `base` is optional with a default, so the drop may post directly. */
const issueAcceptingRevision: PipelineRevision = {
  ...wireRevision,
  input_specs: [
    { name: "base", type: "branch", required: false, default: "main" },
    { name: "ticket", type: "github_issue", required: true, label: "Issue" },
  ],
};

const startedRunId = "01987c99-0000-7000-8000-abcdef012345";

/** A fixed clock: the seven-day window is the FINISHED lane's own promise. */
const NOW = Date.parse("2026-11-02T10:00:00Z");

/** The ADR-0056 trigger fact ADR-0064 says an issue start records — the
 * wire's own answer to “which issue is this run?”, nothing invented. */
const issueTrigger = { kind: "issue" as const, ref: `${issueList.repository}#${issue.number}` };

/** The run the drop started, as the project run list answers it afterwards —
 * the lane buckets the served status, it never writes a hoped-for one. */
function startedRunRow(status: "queued" | "running", extra: Partial<RunSummary> = {}): RunSummary {
  return {
    id: startedRunId,
    project_id: projectFixture.id,
    pipeline_id: WIRE_PIPELINE_ID,
    pipeline_revision_id: issuePin.pinned_revision_id,
    assignment_id: issuePin.id,
    title: issue.title,
    repository_id: repository.id,
    repository_name: repository.name,
    revision_digest: issuePin.pinned_revision_digest,
    plan_digest: wireRevision.plan_digest,
    status,
    depth: 0,
    triggered_by: "01987a61-2345-7000-8000-abcdef012345",
    priority: 0,
    created_at: new Date(NOW).toISOString(),
    started_at: status === "running" ? new Date(NOW + 1_000).toISOString() : null,
    ...extra,
  };
}

/** A real refusal's shape (internal/api/runs.go answers this for an issue
 * start the assignment cannot carry). */
const REFUSAL_DETAIL = "issue can only start a run from an assignment pinned to a repository.";
const refusalBody = {
  type: "https://communication.dev/errors/issue_start_requires_repo_assignment",
  title: "Issue Start Requires a Repo-Scoped Assignment",
  status: 422,
  detail: REFUSAL_DETAIL,
};
function refusalStub(): RouteStub {
  return {
    method: "POST",
    path: `/api/v1/projects/${projectFixture.id}/runs`,
    status: 422,
    body: refusalBody,
  };
}

/** The repo page the view is mounted on, so a test can say plainly whether
 * the drop moved the page (a start lands on the run; a refusal stays). */
const PAGE_PATH = `/p/${projectFixture.id}/communication`;
let seenPath = PAGE_PATH;
function LocationProbe(): null {
  seenPath = useLocation().pathname;
  return null;
}

interface Mounted {
  requests: RecordedRequest[];
  /** Re-render with the runs the list now answers with — what the create's
   * run-list invalidation produces on a real page. */
  withRuns: (runs: RunSummary[]) => void;
  /** The hand-off the view makes when a picked workflow has other required
   * inputs with no default (1k). */
  onOpenRunForm: ReturnType<typeof vi.fn>;
}

function mount(
  overrides: RouteStub[] = [],
  issues: GitHubIssue[] = issueList.items,
  conversations: ConversationSummary[] = [],
): Mounted {
  const base: RouteStub[] = [
    { path: `/api/v1/revisions/${issuePin.pinned_revision_id}`, body: issueAcceptingRevision },
    {
      path: `/api/v1/revisions/${plainPin.pinned_revision_id}`,
      body: { ...wireRevision, input_specs: [] },
    },
    {
      method: "POST",
      path: `/api/v1/projects/${projectFixture.id}/runs`,
      status: 201,
      body: { run_id: startedRunId, status: "queued" },
    },
  ];
  const { requests } = mockFetch([...overrides, ...base]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  // The panel's fake query result: the issues read itself belongs to the page.
  const issuesResult = {
    data: { ...issueList, items: issues },
    error: null,
    isError: false,
    isPending: false,
  } as unknown as ReturnType<typeof useRepoIssues>;
  const onOpenRunForm = vi.fn();

  const ui = (runs: RunSummary[]) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[PAGE_PATH]}>
        <RepoLanes
          projectId={projectFixture.id}
          repositoryName={repository.name}
          issues={issuesResult}
          githubHosted
          runs={runs}
          conversations={conversations}
          runsPending={false}
          runsError={null}
          onRetryRuns={vi.fn()}
          retryingRuns={false}
          chatsPending={false}
          chatsError={null}
          onRetryChats={vi.fn()}
          retryingChats={false}
          gateFor={() => null}
          assignments={[issuePin, plainPin]}
          names={new Map([[WIRE_PIPELINE_ID, "Feature development"]])}
          profileDefaultId="01987a71-2222-7000-8000-abcdef012345"
          profilesPending={false}
          onOpenRunForm={onOpenRunForm}
          now={NOW}
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const view: RenderResult = render(ui([]));
  return {
    requests,
    withRuns: (runs) => view.rerender(ui(runs)),
    onOpenRunForm,
  };
}

/** jsdom hands no DataTransfer on a synthetic drag (a browser hands the same
 * object either way); the lane reads its own drag state, never the payload. */
function dataTransferStub(): {
  data: Record<string, string>;
  effectAllowed: string;
  dropEffect: string;
  setData: (kind: string, value: string) => void;
  getData: (kind: string) => string;
} {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: "none",
    dropEffect: "none",
    setData: (kind, value) => {
      data[kind] = value;
    },
    getData: (kind) => data[kind] ?? "",
  };
}

/** Drag the issue card over RUNNING and let the lane catch it. */
async function dragIntoRunning(): Promise<HTMLElement> {
  const card = await screen.findByTestId(`repo-lane-issue-${issue.number}`);
  fireEvent.dragStart(card, { dataTransfer: dataTransferStub() });
  const lane = screen.getByTestId("repo-lane-running");
  fireEvent.dragOver(lane);
  fireEvent.drop(lane);
  return lane;
}

/** The one run request the menu's workflow row produced. */
async function postedRun(requests: RecordedRequest[]): Promise<RecordedRequest> {
  const path = `/api/v1/projects/${projectFixture.id}/runs`;
  return await waitFor(() => {
    const hits = requestsTo(requests, path, "POST");
    expect(hits.length, "the drop posts exactly one run request").toBe(1);
    return hits[0];
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  seenPath = PAGE_PATH;
});

describe("RepoLanes — dragging an issue into Running (3b)", () => {
  it("lights the RUNNING lane over an in-flight preview while the issue is dragged", async () => {
    mount();
    const card = await screen.findByTestId(`repo-lane-issue-${issue.number}`);
    const transfer = dataTransferStub();
    fireEvent.dragStart(card, { dataTransfer: transfer });

    const lane = screen.getByTestId("repo-lane-running");
    expect(lane.className, "no drop styling before the drag reaches the lane").not.toContain(
      "outline-dashed",
    );

    fireEvent.dragOver(lane, { dataTransfer: transfer });
    // The lane answers the drag: a dashed accent border over an accent-tint fill.
    expect(lane.className).toContain("outline-dashed");
    expect(lane.className).toContain("outline-accent");
    expect(lane.className).toContain("bg-accent-tint");
    const preview = screen.getByTestId("repo-lane-drop-preview");
    expect(preview.textContent).toContain(`#${issue.number} · dragging`);
    expect(preview.textContent).toContain(issue.title);
    // The dragged card dims while it is in the air.
    expect(card.className).toContain("opacity-50");

    // Leaving the lane without dropping takes the lighting back.
    fireEvent.dragLeave(lane);
    expect(lane.className).not.toContain("outline-dashed");
    expect(screen.queryByTestId("repo-lane-drop-preview")).toBeNull();
  });

  it("the drop opens START #<n> WITH over the caught card, with its pointer arrow", async () => {
    mount();
    await dragIntoRunning();

    const menu = await screen.findByTestId("repo-start-issue-menu");
    // The caption rides ds/Menu's mono caps (CSS uppercase over the DOM text).
    expect(menu.textContent?.toUpperCase()).toContain(`START #${issue.number} WITH`);
    expect(menu.getAttribute("aria-label")).toBe(`Start #${issue.number} with`);
    // Handoff rule: every anchored surface draws its own arrow, and the arrow
    // belongs to THIS menu's box (anchored on the caught card, not the lane).
    const arrow = screen.getByTestId("menu-arrow");
    expect(menu.contains(arrow), "the menu carries its pointer arrow").toBe(true);
    const caught = screen.getByTestId("repo-lane-drop-card");
    expect(caught.textContent).toContain(`#${issue.number}`);
    expect(caught.textContent).toContain(issue.title);

    // Only the pin whose pinned revision declares a `github_issue` input is
    // offered; the input-less pin stays out of the menu.
    const startable = await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`);
    expect(startable.textContent).toBe("Feature development");
    expect(
      menu.querySelectorAll('[data-testid^="repo-start-issue-workflow-"]'),
      "one workflow entry — the pin that really takes the issue",
    ).toHaveLength(1);
    expect(menu.textContent).toContain("Chat about it instead");

    // Esc closes the menu and the caught card with it.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("repo-start-issue-menu")).toBeNull());
    expect(screen.queryByTestId("repo-lane-drop-card")).toBeNull();
  });

  it("choosing the workflow posts the run with the issue in the input the revision declares", async () => {
    const { requests } = mount();
    await dragIntoRunning();
    fireEvent.click(await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`));

    const posted = await postedRun(requests);
    const body = JSON.parse(posted.body ?? "{}") as Record<string, unknown>;
    // ADR-0066: the issue rides the input the PINNED REVISION declares — the
    // `ticket` name is the proof nothing is hard-coded — in the ADR's runtime
    // shape, with the `owner/repo` the issue list echoed.
    expect(body).toEqual({
      assignment_id: issuePin.id,
      inputs: {
        ticket: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: issue.html_url,
          repo: issueList.repository,
        },
      },
      title: issue.title,
      // ADR-0064: the run records the issue trigger fact a fire would.
      issue: { number: issue.number },
      idempotency: expect.stringMatching(/^lanedrop-/),
    });
    // ADR-0023 § 12: the same key rides the header, so a replayed click is
    // one run — and the request itself was made once.
    expect(posted.headers.get("Idempotency-Key")).toBe(body.idempotency);
    // …and the page lands on the run it started.
    await waitFor(() => expect(seenPath).toBe(`/runs/${startedRunId}`));
  });

  it("the started run lands in RUNNING as a live run card", async () => {
    const { withRuns } = mount();
    await dragIntoRunning();
    fireEvent.click(await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`));
    await waitFor(() => expect(seenPath).toBe(`/runs/${startedRunId}`));

    // Nothing running yet: the lane is honest about the empty.
    expect(screen.getByTestId("repo-lane-running-empty")).toBeTruthy();

    // The run list answers with the run the drop started (what the create's
    // invalidation fetches on a real page) — the lane buckets that row.
    withRuns([startedRunRow("running")]);

    const lane = screen.getByTestId("repo-lane-running");
    const card = screen.getByTestId(`repo-lane-run-${testidOf(startedRunId)}`);
    expect(lane.contains(card), "the started run is a RUNNING card").toBe(true);
    expect(card.textContent).toContain("RUN · Feature development");
    expect(card.textContent).toContain("running");
    expect(card.textContent).toContain(issue.title);
    expect(
      screen.getByTestId(`repo-lane-run-open-${testidOf(startedRunId)}`).getAttribute("href"),
    ).toBe(`/runs/${startedRunId}`);
    // The issue it came from is still an issue: the lanes bucket SERVED
    // statuses, so the run joins RUNNING while the issue keeps its own card
    // in ISSUES — nothing is smuggled between the lanes by the click.
    expect(
      screen
        .getByTestId("repo-lane-issues")
        .contains(screen.getByTestId(`repo-lane-issue-${issue.number}`)),
    ).toBe(true);
    expect(screen.queryByTestId("repo-lane-running-empty")).toBeNull();
  });

  it("a workflow whose other required inputs have no default hands over to the run form", async () => {
    const { requests, onOpenRunForm } = mount([
      {
        path: `/api/v1/revisions/${issuePin.pinned_revision_id}`,
        body: {
          ...issueAcceptingRevision,
          input_specs: [
            ...issueAcceptingRevision.input_specs!,
            { name: "goal", type: "text", required: true },
          ],
        },
      },
    ]);
    await dragIntoRunning();
    fireEvent.click(await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`));

    // `goal` is required with no default: posting it would be a doomed run,
    // so 1k takes over with the issue and the pin in hand — and no run POST.
    await waitFor(() => expect(onOpenRunForm).toHaveBeenCalledWith(issue, issuePin));
    expect(requestsTo(requests, `/api/v1/projects/${projectFixture.id}/runs`, "POST")).toHaveLength(
      0,
    );
    // The form takes over the start — the lanes stay where they were.
    expect(seenPath).toBe(PAGE_PATH);
  });

  it("the keyboard Start… opens the same menu and starts the same run", async () => {
    const { requests } = mount();
    fireEvent.click(await screen.findByTestId(`repo-lane-issue-start-${issue.number}`));

    const menu = await screen.findByTestId("repo-start-issue-menu");
    expect(menu.textContent?.toUpperCase()).toContain(`START #${issue.number} WITH`);
    // The keyboard menu has no caught card — it anchors on the `Start…`
    // button — and it still draws its arrow.
    expect(screen.queryByTestId("repo-lane-drop-card")).toBeNull();
    expect(menu.contains(screen.getByTestId("menu-arrow"))).toBe(true);

    fireEvent.click(await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`));
    const body = JSON.parse((await postedRun(requests)).body ?? "{}") as Record<string, unknown>;
    expect(body.issue).toEqual({ number: issue.number });
    expect((body.inputs as Record<string, unknown>).ticket).toMatchObject({
      number: issue.number,
      repo: issueList.repository,
    });
    await waitFor(() => expect(seenPath).toBe(`/runs/${startedRunId}`));
  });

  it("a refused start says so in the menu and keeps the card", async () => {
    const { requests } = mount([refusalStub()]);
    await dragIntoRunning();
    fireEvent.click(await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`));

    // The honest message is the server's own sentence, in the menu that stays
    // open — whoever started it decides what happens next.
    const refusal = await screen.findByTestId("repo-start-issue-error");
    expect(refusal.textContent).toContain(REFUSAL_DETAIL);
    expect(screen.getByTestId("repo-start-issue-menu")).toBeTruthy();
    // Nothing moved: the issue keeps its card in ISSUES, nothing is running,
    // and the page has not navigated.
    expect(screen.getByTestId(`repo-lane-issue-${issue.number}`)).toBeTruthy();
    expect(screen.getByTestId("repo-lane-running-empty")).toBeTruthy();
    expect(seenPath).toBe(PAGE_PATH);
    // One request: the refusal is not retried into a second run behind the
    // person's back. The workflow row stays selectable — retrying is their
    // decision, not the menu's — and the caught card is still the anchor.
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/runs`, "POST"),
      ).toHaveLength(1),
    );
    expect(
      screen.getByTestId(`repo-start-issue-workflow-${issuePinKey}`).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByTestId("repo-lane-drop-card")).toBeTruthy();
  });

  it("names a pin whose revision the wire would not answer for, instead of passing it off as unable", async () => {
    mount([
      {
        path: `/api/v1/revisions/${issuePin.pinned_revision_id}`,
        status: 500,
        body: { type: "about:blank", title: "Internal Server Error", status: 500 },
      },
    ]);
    await dragIntoRunning();
    // The read has to fail before the menu can name it, so the wait is on the
    // naming rather than on a fixed tick.
    const named = await screen.findByText(/revision unreadable/);
    expect(named.textContent).toBe("Feature development — revision unreadable");
    expect(screen.getByTestId("repo-start-issue-menu").textContent).toContain(
      "Feature development — revision unreadable",
    );
    expect(screen.queryByTestId(`repo-start-issue-workflow-${issuePinKey}`)).toBeNull();
  });

  it("reads the pinned revision of every enabled pin when the menu opens", async () => {
    const { requests } = mount();
    await dragIntoRunning();
    await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`);
    // Both pins' pinned revisions are read — never a pipeline's latest — so
    // the answer is about the revision a run would actually pin.
    expect(requestsTo(requests, `/api/v1/revisions/${issuePin.pinned_revision_id}`)).toHaveLength(
      1,
    );
    expect(requestsTo(requests, `/api/v1/revisions/${plainPin.pinned_revision_id}`)).toHaveLength(
      1,
    );
  });
});

/**
 * The DEFECT the rcn-3b verification pass caught on every run at 1280x900:
 * `span.min-w-0 "Test issue for assign_copilo…"` overlapping
 * `repo-lane-issue-start-11666`. An issue title whose longest word has no
 * break opportunity (`assign_copilot_to_issue`) is wider than the ~235px the
 * lane leaves it, so with the default `overflow-wrap: normal` it overflowed
 * the (visible) title box and drew under the `Start…` button.
 *
 * jsdom runs no layout, so this cannot measure boxes; it asserts the
 * structure the layout rests on — the title may shrink AND breaks anywhere,
 * the button cannot shrink at all, and the two are siblings rather than one
 * wrapped in the other (a box cannot overflow onto a sibling it contains).
 */
describe("RepoLanes — a long unbreakable title stays in its own column (rcn-3b overlap)", () => {
  /** The real titles from the failing screen, snake_case and unbreakable. */
  const LONG_TITLES = [
    "Test issue for assign_copilot_to_issue",
    "Test issue for add_issue_comment",
  ];

  it("breaks the title inside its column and keeps the Start button whole", async () => {
    const long: GitHubIssue[] = LONG_TITLES.map((title, i) => ({
      ...issue,
      number: 11661 + i * 5,
      title,
    }));
    mount([], long);

    for (const one of long) {
      const card = await screen.findByTestId(`repo-lane-issue-${one.number}`);
      const title = screen.getByTestId(`repo-lane-issue-title-${one.number}`);
      const button = screen.getByTestId(`repo-lane-issue-start-${one.number}`);

      expect(title.textContent).toBe(one.title);
      // `wrap-anywhere` is Tailwind v4's `overflow-wrap: anywhere`: the word
      // breaks inside the column, and it shrinks the column's min-content so
      // the row divides the card instead of the title running over the button.
      expect(title.className, "the title breaks an unbreakable word").toContain("wrap-anywhere");
      // min-width:0 is what lets a flex item get narrower than its content.
      expect(title.className, "the title column may shrink").toContain("min-w-0");
      expect(title.className).toContain("flex-1");
      // `flex: none` — the button never shrinks into the title, and its label
      // stays one line (the pass also saw `Start…` clipped in a narrow card).
      expect(button.className, "the Start button never shrinks").toContain("flex-none");
      expect(button.className).toContain("whitespace-nowrap");
      // Siblings in one flex row: the title's overflow cannot land on a box it
      // contains, and neither of them is the card's whole width by accident.
      const row = title.parentElement;
      expect(row, "the title sits in a flex row").not.toBeNull();
      expect(row?.className).toContain("flex");
      expect(row?.contains(button), "the button is a sibling, not a parent").toBe(true);
      expect(title.contains(button)).toBe(false);
      expect(button.contains(title)).toBe(false);
      // The row is inside the card, not the card itself.
      expect(card.contains(row as HTMLElement)).toBe(true);
      // The `#num` chip is not a shrinking item either — three items, one of
      // them (the title) carries all the flexibility.
      const number = row?.firstElementChild as HTMLElement | null;
      expect(number?.textContent).toBe(`#${one.number}`);
      expect(number?.className).toContain("flex-none");
    }
  });

  it("says the same about a chat card's title beside its age", async () => {
    // A chat title is the same hazard: `Plan · implement_the_thing` in a
    // 235px lane, with the mono age pinned beside it.
    const chat: ConversationSummary = {
      ...conversationSummaryFixture,
      title: "Discuss assign_copilot_to_issue",
      status: "active",
      updated_at: new Date(NOW - 60_000).toISOString(),
    };
    mount([], [], [chat]);
    const title = await screen.findByTestId(`repo-lane-chat-title-${testidOf(chat.id)}`);
    const age = title.nextElementSibling as HTMLElement | null;
    expect(title.textContent).toBe(chat.title);
    expect(title.className).toContain("wrap-anywhere");
    expect(title.className).toContain("min-w-0");
    expect(age?.className, "the age stamp never shrinks").toContain("flex-none");
  });
});

/**
 * The rcn-3b round-19 MINORs, read off `rcn-3b--lanes-running.png`:
 * 1. the run card's progress area was a bordered `steps` box around an
 *    (all-open) bar — it read as an empty focused input. It is now the
 *    design's thin segmented strip over the List feed's OWN served step
 *    states, and no served steps means the honest `starting` word;
 * 2. an issue-started run showed its bare title — the design says
 *    `#418 Add Apple Pay`, and ADR-0064 says the run row carries the issue
 *    ref to say so;
 * 3. the issue a live run already carried sat in ISSUES with `Start…` and
 *    nothing about its run — it now wears the List view's active-run tag
 *    (a link, dimming the card) instead of the start button;
 * 4. at the phone cut the anchored `START #<n> WITH` menu flipped up over
 *    the NEEDS YOU lane — it is a bottom sheet there now, as the app's
 *    other narrow menus are.
 */
describe("RepoLanes — the run card tells the truth about its progress and its issue (rcn-3b round 19)", () => {
  /** The ADR-0070 progress the project run list serves on a live row. */
  function progressingRun(): RunSummary {
    return {
      ...startedRunRow("running", { trigger: issueTrigger }),
      // `progress` rides RunListRow, the shape the page's list answers with.
      progress: {
        steps: [
          { node_id: "plan", state: "done" },
          { node_id: "implement", state: "running" },
          { node_id: "review", state: "open" },
          { node_id: "pr", state: "open" },
        ],
        more: 0,
      },
    } as RunSummary;
  }

  it("draws the strip from the served step states — no bordered steps box", async () => {
    const { withRuns } = mount();
    withRuns([progressingRun()]);
    const card = screen.getByTestId(`repo-lane-run-${testidOf(startedRunId)}`);
    const strip = within(card).getByTestId("repo-lane-run-steps");
    // Segments come from the real step states; the counts ride the name
    // (rule 06: state is never color-only).
    expect(strip.getAttribute("role")).toBe("img");
    expect(strip.getAttribute("aria-label")).toBe("Progress: 1 done, 1 running, 2 open");
    // Not the variant-J box: no `steps` label, no framed input look.
    expect(card.textContent, "the strip carries no 'steps' label box").not.toContain("steps");
    expect(
      card.querySelector(".border-ink, [class*='bg-accent-wash']"),
      "no heavy frame or accent wash around the progress area",
    ).toBeNull();
  });

  it("says `starting` when no steps are served yet, instead of drawing an empty box", async () => {
    const { withRuns } = mount();
    // The row as the wire answers it before any step projection exists.
    withRuns([startedRunRow("running", { trigger: issueTrigger })]);
    const card = screen.getByTestId(`repo-lane-run-${testidOf(startedRunId)}`);
    const starting = within(card).getByTestId(`repo-lane-run-starting-${testidOf(startedRunId)}`);
    expect(starting.textContent).toContain("starting");
    expect(within(card).queryByTestId("repo-lane-run-steps")).toBeNull();
  });

  it("wears the issue number the run's own trigger carries beside its title", async () => {
    const { withRuns } = mount();
    withRuns([startedRunRow("running", { trigger: issueTrigger })]);
    const open = screen.getByTestId(`repo-lane-run-open-${testidOf(startedRunId)}`);
    // The design's `#418 Add Apple Pay`: the number is the served ref, not
    // a guess, and the title rides along with it.
    expect(open.textContent).toContain(`#${issue.number}`);
    expect(open.textContent).toContain(issue.title);
  });

  it("names no number when the run's trigger named no issue", async () => {
    const { withRuns } = mount();
    withRuns([startedRunRow("running", { trigger: { kind: "manual" } })]);
    const open = screen.getByTestId(`repo-lane-run-open-${testidOf(startedRunId)}`);
    expect(open.textContent).not.toContain("#");
    expect(open.textContent).toContain(issue.title);
  });

  it("marks the running issue in ISSUES with its live run — and no second Start", async () => {
    const { withRuns } = mount();
    // Before the run exists: the plain card with its keyboard start.
    expect(screen.getByTestId(`repo-lane-issue-start-${issue.number}`)).toBeTruthy();
    expect(screen.queryByTestId(`repo-lane-issue-run-${issue.number}`)).toBeNull();

    withRuns([startedRunRow("running", { trigger: issueTrigger })]);

    const card = screen.getByTestId(`repo-lane-issue-${issue.number}`);
    expect(card.className, "the live issue dims like the design's #421").toContain("opacity-60");
    const tag = screen.getByTestId(`repo-lane-issue-run-${issue.number}`);
    expect(tag.getAttribute("href"), "the tag links to the run").toBe(`/runs/${startedRunId}`);
    expect(tag.textContent).toContain("running");
    expect(
      within(card).queryByTestId(`repo-lane-issue-start-${issue.number}`),
      "the start button stands down while the issue runs",
    ).toBeNull();

    // The run reaches a terminal status: the tag goes, the start returns —
    // the mark reads the served status, never a hoped-for one.
    withRuns([{ ...startedRunRow("running", { trigger: issueTrigger }), status: "completed" }]);
    expect(screen.queryByTestId(`repo-lane-issue-run-${issue.number}`)).toBeNull();
    expect(screen.getByTestId(`repo-lane-issue-start-${issue.number}`)).toBeTruthy();
    expect(card.className).not.toContain("opacity-60");
  });

  it("ties the mark to THIS repository's ref, not to any number", async () => {
    const { withRuns } = mount();
    // Same number, another repository — not this lane's issue.
    withRuns([
      startedRunRow("running", { trigger: { kind: "issue", ref: `other/repo#${issue.number}` } }),
    ]);
    expect(screen.queryByTestId(`repo-lane-issue-run-${issue.number}`)).toBeNull();
    expect(screen.getByTestId(`repo-lane-issue-start-${issue.number}`)).toBeTruthy();
  });
});

/**
 * rcn-3b round 19, item 4: at 390 the anchored `START #<n> WITH` menu
 * flipped up and buried the NEEDS YOU lane. Below the phone cut the same
 * items mount as a bottom sheet — the pattern the app's other narrow menus
 * use — with the same test hooks so the start's contract is unchanged.
 */
describe("RepoLanes — at the phone cut the start menu is a bottom sheet (rcn-3b round 19)", () => {
  function stubMatchMedia(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  it("the sheet carries the caption, the workflow and the chat, and it starts the run", async () => {
    stubMatchMedia(true);
    const { requests } = mount();
    await dragIntoRunning();

    const sheet = await screen.findByTestId("repo-start-issue-sheet");
    const menu = screen.getByTestId("repo-start-issue-menu");
    expect(sheet.contains(menu), "the sheet box IS the start menu").toBe(true);
    // No anchored arrow: this surface is pinned to the viewport edge.
    expect(screen.queryByTestId("menu-arrow"), "no arrow — no anchor").toBeNull();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe(`Start #${issue.number} with`);
    expect(menu.textContent?.toUpperCase()).toContain(`START #${issue.number} WITH`);

    fireEvent.click(await screen.findByTestId(`repo-start-issue-workflow-${issuePinKey}`));
    const body = JSON.parse((await postedRun(requests)).body ?? "{}") as Record<string, unknown>;
    expect(body.issue).toEqual({ number: issue.number });
    await waitFor(() => expect(seenPath).toBe(`/runs/${startedRunId}`));
  });

  it("Esc and the scrim close the sheet with the caught card", async () => {
    stubMatchMedia(true);
    mount();
    await dragIntoRunning();
    await screen.findByTestId("repo-start-issue-sheet");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("repo-start-issue-sheet")).toBeNull());
    expect(screen.queryByTestId("repo-lane-drop-card")).toBeNull();
  });

  it("at desktop width the menu stays anchored with its arrow", async () => {
    stubMatchMedia(false);
    mount();
    await dragIntoRunning();
    const menu = await screen.findByTestId("repo-start-issue-menu");
    expect(screen.queryByTestId("repo-start-issue-sheet")).toBeNull();
    expect(menu.contains(screen.getByTestId("menu-arrow"))).toBe(true);
  });
});
