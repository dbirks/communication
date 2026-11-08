/**
 * The shared conversation surface: one panel for the page and the docks.
 *
 * Mocked at the fetch boundary, the same way the conversation page's suite is
 * (route stubs plus a fake `EventSource` the test drives), so the assertions
 * are about what a member sees: the dock's transcript and open-full link, the
 * viewer's disabled handoff, the controller's live composer, and the
 * non-controller's explainer.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { render as renderDom, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { setCsrfToken } from "../../api/client";
import {
  AgentConversationPanel,
  NO_CONTROLLER_GLYPH,
  NO_CONTROLLER_LABEL,
  controllerCopy,
} from "./AgentConversationPanel";
import {
  FakeEventSource,
  claudeProfile,
  codexProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  controlledByOther,
  meFixture,
  otherUserId,
  projectFixture,
  mockFetch,
  repositoryId,
  requestsTo,
  turnFixture,
  turnId,
  type RouteStub,
} from "../../test/fakes";
import type { Conversation } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The panel is a component, not a page: wrap it in the app's providers only.
 * `requests` is the fetch-boundary log, for the mutation assertions. */
function renderPanel(ui: ReactNode, routes: RouteStub[], container?: HTMLElement) {
  setCsrfToken(null);
  const { requests } = mockFetch(routes, {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return {
    ...renderDom(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
      container ? { container } : {},
    ),
    requests,
    queryClient,
  };
}

const projectPath = `/api/v1/projects/${projectFixture.id}`;
const conversationPath = `/api/v1/conversations/${conversationId}`;

function routes(conversation: Conversation, myRole: string = "maintainer"): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, method: "GET", body: { ...projectFixture, my_role: myRole } },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: conversationPath, method: "GET", body: conversation },
  ];
}

/** A conversation the factory still controls: a takeover is on offer. */
const runControlled: Conversation = {
  ...conversationFixture,
  origin: "run",
  control: { kind: "run_attempt", version: 2 },
};

/** A thread nobody holds (control `kind: "none"`) — Projects Review 1g's
 * glyph-only state. */
const unheld: Conversation = {
  ...conversationFixture,
  control: { kind: "none", version: 4 },
};

/** The attempt pane's historical ids, worn over the shared surface. */
const ATTEMPT_IDS = {
  controlBanner: "attempt-control-banner",
  stream: "attempt-work-stream",
  badge: "attempt-controller",
  takeControl: "attempt-take-control",
  returnControl: "attempt-return-control",
  stopTurn: "attempt-stop-turn",
  composerInput: "attempt-composer-input",
  composerSend: "attempt-composer-send",
  composerExplainer: "attempt-composer-explainer",
};

const dock = (props: Record<string, unknown> = {}) => (
  <AgentConversationPanel
    conversationId={conversationId}
    projectId={projectFixture.id}
    variant="dock"
    {...props}
  />
);

describe("AgentConversationPanel (dock)", () => {
  it("renders the transcript and the open-full conversation link", async () => {
    renderPanel(dock(), routes(conversationFixture));
    const open = await screen.findByTestId("dock-open-conversation");
    expect(open.getAttribute("href")).toBe(
      `/projects/${projectFixture.id}/conversations/${conversationId}`,
    );
    expect(screen.getByText("Open full thread")).toBeTruthy();

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Fix the flaky spec",
        }),
      );
      source.emit(conversationEvent("conversation.message.agent", { text: "On it.", final: true }));
    });

    const transcript = await screen.findByTestId("transcript");
    const items = within(transcript).getAllByTestId("transcript-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Fix the flaky spec");
    // The dock badge says who is driving, in words.
    expect(screen.getByTestId("controller-badge").textContent).toContain("in control");
  });

  /**
   * rcn-review10, rcn-review11: the dock is a chat surface too — its
   * transcript keeps the pane's scroller pinned to the newest row, the way
   * the page's does. jsdom lays out nothing: the geometry is the test's own
   * numbers (the scroller's scroll facts and the transcript's rect), and
   * the ResizeObserver stub fires the moment a row lands.
   */
  it("keeps the pane's scroller pinned to the newest row as rows land", async () => {
    const roCallbacks = new Set<() => void>();
    class ResizeObserverStub {
      fire: () => void;
      constructor(cb: (entries: unknown[], observer: unknown) => void) {
        this.fire = () => cb([], this);
        roCallbacks.add(this.fire);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        roCallbacks.delete(this.fire);
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    scroller.scrollTop = 0;
    document.body.appendChild(scroller);

    renderPanel(dock(), routes(conversationFixture), scroller);
    // The fixture thread starts empty; the transcript block (the pin's
    // content) is up either way.
    const content = (await screen.findByTestId("transcript-empty")).parentElement;
    if (!content) throw new Error("the pin's content did not land in the scroller");
    // The transcript's own bottom, mocked the way a laid-out browser would
    // report it: the content is the whole scroller content here, so its
    // bottom is the scroller's scroll height minus the current offset.
    content.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: scroller.scrollHeight - scroller.scrollTop,
        left: 0,
        right: 0,
        width: 0,
        height: scroller.scrollHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    // The browser's first observer callback reports the laid-out size; the
    // test plays that moment — first load starts at the newest row.
    act(() => {
      roCallbacks.forEach((cb) => cb());
    });
    expect(scroller.scrollTop).toBe(700);

    const source = FakeEventSource.last();
    act(() => {
      source.emit(conversationEvent("conversation.message.agent", { text: "On it.", final: true }));
    });
    await screen.findByTestId("transcript");
    // The reply landed: the content grew, and the pinned view followed it.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
    act(() => {
      roCallbacks.forEach((cb) => cb());
    });
    expect(scroller.scrollTop).toBe(1100);
    scroller.remove();
  });

  /**
   * rcn-2f review item 3 (the wiring that never landed with ADR-0068's agent
   * naming): the dock owns the transcript too, and its failed turn must read
   * as the AGENT the person chose, not the executable the worker spawned.
   * `internal/worker/launchfailure.go` says `launcher "claude" is not signed
   * in`; the conversation's own profile row is the read that names it.
   */
  it("names the agent behind a sign-in refusal, in the words the member chose", async () => {
    renderPanel(dock(), routes(conversationFixture));
    await screen.findByTestId("dock-open-conversation");

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Run the tests.",
        }),
      );
      source.emit(
        conversationEvent("conversation.turn.failed", {
          turn_id: turnId,
          message:
            'worker: launcher "claude" is not signed in on this worker: the agent refused ' +
            "session/new because it requires a sign-in, JSON-RPC code -32000 \u2014 check " +
            "this launcher's credential directory on the worker that owns the turn",
        }),
      );
    });

    const notice = await screen.findByTestId("turn-failed");
    expect(within(notice).getByTestId("turn-failed-plain").textContent).toBe(
      "Claude Code isn't signed in on this worker, so this turn couldn't start.",
    );
    // The launcher id is gone from the reading line: it is in the disclosure.
    expect(within(notice).getByTestId("turn-failed-plain").textContent).not.toMatch(/launcher/);
    expect(within(notice).getByTestId("turn-failed-server").textContent).toContain(
      'launcher "claude" is not signed in',
    );
  });

  it("shows a disabled Take control to a viewer, and says watching is all they may do", async () => {
    renderPanel(dock(), routes(controlledByOther, "viewer"));
    const take = await screen.findByTestId("take-control");
    expect(take.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("composer-explainer").textContent).toContain("watch this thread");
    expect(screen.getByTestId("composer-input").hasAttribute("disabled")).toBe(true);
  });

  it("gives the controller an enabled composer", async () => {
    renderPanel(
      dock({
        composer: {
          inputId: "panel-prompt",
          rows: 2,
          nonControllerPlaceholder: "Only the controller can prompt.",
        },
      }),
      routes(conversationFixture),
    );
    const input = await screen.findByTestId("composer-input");
    expect(input.hasAttribute("disabled")).toBe(false);
    const send = screen.getByTestId("composer-send");
    // Empty prompts are never sent.
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "Check the tests" } });
    expect(send.hasAttribute("disabled")).toBe(false);
  });

  it("explains an open turn to the controller in plain words, not the wire status", async () => {
    // The thread header already says "starting — a worker has the turn"; the
    // composer used to print `(status: leased)` and left the member to decode it.
    const leased: Conversation = {
      ...conversationFixture,
      active_turn: turnFixture({ id: turnId, status: "leased" }),
    };
    renderPanel(dock(), routes(leased));
    const explainer = await screen.findByTestId("composer-explainer");
    expect(explainer.textContent).toContain("A turn is already open");
    expect(explainer.textContent).toContain("starting — a worker has the turn");
    expect(explainer.textContent).not.toMatch(/status: leased/);
    expect(screen.getByTestId<HTMLButtonElement>("composer-send").disabled).toBe(true);
  });

  it("shows the non-controller the explainer instead of a live composer", async () => {
    renderPanel(dock(), routes(controlledByOther));
    const input = await screen.findByTestId("composer-input");
    expect(input.hasAttribute("disabled")).toBe(true);
    const explainer = screen.getByTestId("composer-explainer");
    expect(explainer.textContent).toContain(
      "Only the controller (Dana Observer) can send prompts.",
    );
    expect(explainer.textContent).toContain("Take control to drive.");
  });

  it("shows the whole conversation, marking the attempt's turn and the human turns", async () => {
    // A takeover cancels the attempt's turn and opens a NEW turn in the same
    // conversation — the dock must keep the first turn AND show the human's
    // prompt and the reply, with markers at each boundary.
    const humanTurnId = "01987a99-0000-7000-8000-abcdef012346";
    renderPanel(dock({ attemptTurnId: turnId }), routes(conversationFixture));
    const source = FakeEventSource.last();
    act(() => {
      // The attempt's own (factory) turn: agent work, no user message.
      source.emit(
        conversationEvent("conversation.message.agent", { text: "Working on it.", final: true }),
      );
      // A human takes over and prompts — a new turn in the same conversation.
      source.emit(
        conversationEvent("conversation.message.user", {
          turn_id: humanTurnId,
          submitted_by: meFixture.id,
          text: "New direction: keep the diff minimal",
        }),
      );
      source.emit(
        conversationEvent("conversation.message.agent", {
          turn_id: humanTurnId,
          text: "Understood — minimal diff.",
          final: true,
        }),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    const items = within(transcript).getAllByTestId("transcript-item");
    // 3 journal rows plus 2 marker rows — nothing is hidden.
    expect(items).toHaveLength(5);
    expect(transcript.textContent).toContain("Working on it.");
    expect(transcript.textContent).toContain("New direction: keep the diff minimal");
    expect(transcript.textContent).toContain("Understood — minimal diff.");
    // The marker before the attempt's first frame names that turn…
    const attemptMarker = items.find((item) =>
      item.textContent?.includes("this attempt's turn starts here"),
    );
    expect(attemptMarker).toBeDefined();
    expect(items.indexOf(attemptMarker as HTMLElement)).toBe(0);
    // …and the marker before the human's turn names the person.
    const humanMarker = items.find((item) =>
      item.textContent?.includes("human turn — prompted by Ada Lovelace"),
    );
    expect(humanMarker).toBeDefined();
    expect(items.indexOf(humanMarker as HTMLElement)).toBe(2);
  });

  it("marks the attempt's unattended turn as one nobody typed (ADR-0062)", async () => {
    // A schedule fire's agent turn: the seam stamps the turn row (no
    // `conversation.message.user` frame — the prompt row belongs to a human's
    // own POST), so the only thing naming this turn is `active_turn`, and what
    // it names is the member who authorised the schedule.
    const fired: Conversation = {
      ...runControlled,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "schedule",
      }),
    };
    renderPanel(dock({ attemptTurnId: turnId }), routes(fired));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.agent", { turn_id: turnId, text: "Planning." }),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    const marker = within(transcript)
      .getAllByTestId("transcript-item")
      .find((item) => item.textContent?.includes("this attempt's turn starts here"));
    expect(marker?.textContent).toContain(
      "unattended turn — on behalf of Dana Observer · schedule",
    );
    // The line that would credit a person with typing it is gone.
    expect(marker?.textContent).not.toContain("human turn");
  });

  it("refuses to call an issue trigger's turn a human turn, even with a prompt row", async () => {
    // Precedence: the frame names a person and the row says no person queued
    // it, and the row is the fact (ADR-0062) — the old code called any user
    // frame proof a member had taken over and typed the prompt.
    const fired: Conversation = {
      ...runControlled,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "issue_trigger",
      }),
    };
    renderPanel(dock({ attemptTurnId: turnId }), routes(fired));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent(
          "conversation.message.user",
          { turn_id: turnId, submitted_by: otherUserId, text: "Open the PR for issue #7" },
          { global_seq: 5100 },
        ),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain(
      "unattended turn — on behalf of Dana Observer · issue trigger",
    );
    expect(transcript.textContent).not.toContain("human turn — prompted by");
    // The prompt bubble itself says the same thing rather than a bare author.
    const onBehalf = within(transcript).getAllByTestId("turn-on-behalf-of");
    expect(onBehalf).toHaveLength(1);
    expect(onBehalf[0].textContent).toBe("on behalf of Dana Observer · issue trigger");
  });

  it("keeps the human wording for a turn the row says a person typed", async () => {
    // The child_run/automation branch must not swallow the honest case: a turn
    // whose row says `human` still reads exactly as it did before.
    const typed: Conversation = {
      ...conversationFixture,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "human",
      }),
    };
    renderPanel(dock({ attemptTurnId: "01987a99-0000-7000-8000-abcdef012346" }), routes(typed));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent(
          "conversation.message.user",
          { turn_id: turnId, submitted_by: otherUserId, text: "Keep the diff minimal" },
          { global_seq: 5200 },
        ),
      );
    });

    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain("human turn — prompted by Dana Observer");
    expect(transcript.textContent).not.toContain("on behalf of");
    expect(within(transcript).queryAllByTestId("turn-on-behalf-of")).toHaveLength(0);
  });

  it("marks a child run's inherited turn as unattended too", async () => {
    const child: Conversation = {
      ...runControlled,
      active_turn: turnFixture({
        id: turnId,
        status: "running",
        submitted_by: otherUserId,
        submitted_by_display_name: "Dana Observer",
        submitted_via: "child_run",
      }),
    };
    renderPanel(dock({ attemptTurnId: turnId }), routes(child));
    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        conversationEvent("conversation.message.agent", { turn_id: turnId, text: "Reviewing." }),
      );
    });
    const transcript = await screen.findByTestId("transcript");
    expect(transcript.textContent).toContain(
      "unattended turn — on behalf of Dana Observer · child run",
    );
  });

  it("makes the dock's Take control a two-step confirm, and the card says what a takeover does", async () => {
    const taken: Conversation = {
      ...runControlled,
      control: {
        kind: "human",
        user_id: meFixture.id,
        display_name: meFixture.display_name,
        version: 3,
      },
    };
    const { requests } = renderPanel(dock({ stepName: "implement" }), [
      ...routes(runControlled),
      { path: `${conversationPath}/take-control`, method: "POST", status: 200, body: taken },
    ]);

    // The first click shows the card — it must NOT fire the mutation.
    fireEvent.click(await screen.findByTestId("take-control"));
    const card = await screen.findByTestId("take-control-card");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(screen.getByTestId("take-control-card-heading").textContent).toBe(
      "Take control of implement?",
    );
    expect(card.textContent).toContain(
      "The current attempt of implement stops and the run pauses.",
    );
    expect(card.textContent).toContain("runs again as a new attempt with whatever you changed.");
    expect(card.textContent).not.toContain("pauses before");
    // Focus moved to the primary action.
    expect(document.activeElement).toBe(screen.getByTestId("take-control-confirm"));
    expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(0);

    // Just watch (here: Escape) closes the card and still sends nothing.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("take-control-card")).toBeNull();
    expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(0);

    // Confirming is the only click that POSTs — once, echoing the version read.
    fireEvent.click(screen.getByTestId("take-control"));
    fireEvent.click(await screen.findByTestId("take-control-confirm"));
    await waitFor(() =>
      expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(1),
    );
    const posts = requestsTo(requests, `${conversationPath}/take-control`, "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body ?? "{}")).toEqual({ version: 2 });
    // The takeover landed: the badge says so, and the composer unlocks.
    await waitFor(async () =>
      expect(screen.getByTestId("controller-badge").textContent).toBe("you're in control"),
    );
    expect(screen.getByTestId("composer-input").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the one-click take when the surface opts out of the confirm card", async () => {
    // The standalone Conversation page wears exactly this: the take button
    // with `confirmTakeover` off — the first click fires the mutation, no card.
    const taken: Conversation = {
      ...runControlled,
      control: {
        kind: "human",
        user_id: meFixture.id,
        display_name: meFixture.display_name,
        version: 3,
      },
    };
    const { requests } = renderPanel(dock({ confirmTakeover: false }), [
      ...routes(runControlled),
      { path: `${conversationPath}/take-control`, method: "POST", status: 200, body: taken },
    ]);
    fireEvent.click(await screen.findByTestId("take-control"));
    await waitFor(() =>
      expect(requestsTo(requests, `${conversationPath}/take-control`, "POST")).toHaveLength(1),
    );
    expect(screen.queryByTestId("take-control-card")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("controller-badge").textContent).toBe("you're in control"),
    );
  });
});

describe("controller status with no controller (Projects Review 1g)", () => {
  it("labels the state in words only — the badge itself prints no sentence", () => {
    // 1g drops "controller: nobody": `controllerCopy` keeps the words as the
    // accessible name, and the surface draws `NO_CONTROLLER_GLYPH` instead.
    expect(controllerCopy({ kind: "none", version: 4 }, false)).toBe("No controller");
    expect(controllerCopy({ kind: "none", version: 4 }, false)).not.toContain("take control");
    // The states that name a holder are untouched.
    expect(controllerCopy({ kind: "run_attempt", version: 2 }, false)).toBe(
      "Controlled by a pipeline run",
    );
  });

  it("draws the page badge as a glyph whose accessible name is the state", async () => {
    renderPanel(dock(), routes(unheld));
    const badge = await screen.findByTestId("controller-badge");
    // What a member reads is the glyph — no sentence, and no pill of words.
    expect(badge.textContent).toBe("○");
    expect(badge.textContent).not.toMatch(/no controller|take control/i);
    // What a screen reader reads is the state, in words.
    expect(badge.textContent).toContain(NO_CONTROLLER_GLYPH);
    expect(badge.querySelector("[role='img']")?.getAttribute("aria-label")).toBe(
      NO_CONTROLLER_LABEL,
    );
    // Take control is the way forward, and it stays visible.
    expect(screen.getByTestId("take-control").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the attempt pane's glyph inside its control banner and its own ids", async () => {
    renderPanel(dock({ ids: ATTEMPT_IDS, watching: true }), routes(unheld));
    const banner = await screen.findByTestId("attempt-control-banner");
    const badge = banner.querySelector("[data-testid='attempt-controller']");
    expect(badge?.textContent).toBe(`○· you are watching`);
    expect(
      banner.querySelector("[data-testid='attempt-controller-glyph']")?.getAttribute("aria-label"),
    ).toBe(NO_CONTROLLER_LABEL);
    expect(screen.getByTestId("attempt-take-control")).toBeTruthy();
  });
});

/**
 * The composer's `/`-skill and `#`-issue affordances (design 2e/1h):
 * the placeholder names both, the "/ skill" button opens the ds menu over
 * the NEXT-turn profile's `apm_contents.skills`, typing `/` opens the same
 * menu, and typing `#` opens the open-issues menu ONLY for a repo-scoped
 * chat on a GitHub remote (`isGitHubRepository`, the handoff's own guard).
 * Picking completes the token at the caret: `/<skill> `, `#<number> `.
 */
describe("the composer's / skill and # issue affordances (design 2e/1h)", () => {
  const reposPath = `/api/v1/projects/${projectFixture.id}/repos`;
  // The fetch mock strips query strings, so the stub — and `requestsTo` —
  // key on the path alone; the live read is `…/issues?state=open`.
  const issuesPath = `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`;

  /** The thread works in the `backend` repository (ADR-0067's binding). The
   * read carries `repository_name`; the id arrives from the repos read. */
  const repoConversation: Conversation = {
    ...conversationFixture,
    repository_name: "backend",
  };

  /** The project's one repository, GitHub-hosted — the issues route can answer. */
  const githubRepo = {
    id: repositoryId,
    project_id: projectFixture.id,
    name: "backend",
    git_url: "https://github.com/example/backend.git",
    default_branch: "main",
    created_at: "2026-10-14T18:00:00Z",
  };
  /** The same row on a local remote — `isGitHubRepository` refuses it. */
  const localRepo = { ...githubRepo, git_url: "file:///srv/backend" };

  const openIssues = {
    repository: "example/backend",
    state: "open",
    items: [
      {
        number: 7,
        title: "Search pagination",
        body: "",
        labels: [],
        html_url: "https://github.com/example/backend/issues/7",
        state: "open",
        updated_at: "2026-10-14T18:00:00Z",
        body_truncated: false,
      },
      {
        number: 12,
        title: "Mirror timeout",
        body: "",
        labels: [],
        html_url: "https://github.com/example/backend/issues/12",
        state: "open",
        updated_at: "2026-10-14T18:02:00Z",
        body_truncated: false,
      },
    ],
  };

  const profile = (apm_contents: unknown) => ({ ...claudeProfile, apm_contents });

  /** `routes` minus its default profile stub, so the test supplies the profile's own `apm_contents`. */
  function skillRoutes(conversation: Conversation, apm_contents: unknown): RouteStub[] {
    return [
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/agent-profiles", body: { items: [profile(apm_contents), codexProfile] } },
      { path: projectPath, method: "GET", body: projectFixture },
      { path: "/api/v1/users", method: "GET", body: { items: [] } },
      { path: conversationPath, method: "GET", body: conversation },
    ];
  }

  it("names both typed affordances in the placeholder", async () => {
    renderPanel(dock(), skillRoutes(conversationFixture, { skills: ["review"], truncated: false }));
    const input = await screen.findByTestId("composer-input");
    expect(input.getAttribute("placeholder")).toBe("Reply, / for skills, # for issues…");
  });

  it("keeps the '/ skill' label visible at 390px too, not a bare /", async () => {
    renderPanel(dock(), skillRoutes(conversationFixture, { skills: ["review"], truncated: false }));
    const button = (await screen.findByTestId("composer-skill-button")) as HTMLElement;
    expect(button.getAttribute("aria-label")).toBe("Skills");
    // Round-8 review: a lone "/" on its own row named nothing, so the word
    // no longer folds below `sm` — "/ skill" is the visible label at every
    // width (the controls row under the textbox keeps all three controls
    // without overflow, because the agent chip shrinks).
    const word = Array.from(button.querySelectorAll("span")).find((span) =>
      span.textContent?.includes("skill"),
    ) as HTMLElement;
    expect(word.className).not.toContain("hidden");
    expect(word.className).not.toContain("sm:inline");
    expect(button.textContent).toBe("/skill");
  });

  it("gives the textbox its own full row and the controls one row below (design 2e)", async () => {
    renderPanel(dock(), skillRoutes(conversationFixture, { skills: ["review"], truncated: false }));
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    // The textbox owns its row — `flex-1 min-w-0` takes the remaining width,
    // so the full "Reply, / for skills, # for issues…" placeholder fits at
    // 1280 instead of clipping beside the controls.
    const box = input.parentElement as HTMLElement;
    expect(box.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["w-full", "min-w-0", "flex-1"]),
    );
    // The / skill button and Send share ONE row under the textbox, and that
    // row is a sibling of the textbox row in the form.
    const send = screen.getByTestId("composer-send");
    const row = send.parentElement as HTMLElement;
    expect(row.className.split(/\s+/)).toContain("flex");
    const skill = screen.getByTestId("composer-skill-button");
    // The button sits in its own `relative` wrapper (its menu's anchor);
    // that wrapper is what the row holds.
    expect(skill.parentElement?.parentElement).toBe(row);
    expect(box.parentElement).toBe(row.parentElement);
  });

  it("lists the NEXT-turn profile's skills in the button's menu, and picking inserts `/<skill> `", async () => {
    renderPanel(
      dock(),
      skillRoutes(conversationFixture, { skills: ["review", "refactor"], truncated: false }),
    );
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId("composer-skill-button"));
    const menu = await screen.findByTestId("composer-skill-menu");
    expect(within(menu).getByTestId("composer-skill-review").textContent).toContain("review");
    expect(within(menu).getByTestId("composer-skill-refactor").textContent).toContain("refactor");
    // The conversation runs Claude: the list is Claude's lock, not Codex's.
    expect(within(menu).queryByTestId(`composer-skill-${codexProfile.id}`)).toBeNull();
    fireEvent.click(within(menu).getByTestId("composer-skill-refactor"));
    await waitFor(() => expect(input.value).toBe("/refactor "));
    expect(screen.queryByTestId("composer-skill-menu")).toBeNull();
    // The caret parks right after the completed token.
    expect(input.selectionStart).toBe("/refactor ".length);
  });

  it("opens the same menu when / starts the message, filtered by what follows", async () => {
    renderPanel(
      dock(),
      skillRoutes(conversationFixture, { skills: ["review", "refactor"], truncated: false }),
    );
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/" } });
    const menu = await screen.findByTestId("composer-skill-menu");
    expect(within(menu).queryByTestId("composer-skill-refactor")).toBeTruthy();
    // Typing `ref` narrows to the one skill it starts with.
    fireEvent.change(input, { target: { value: "/ref" } });
    input.setSelectionRange(4, 4);
    await waitFor(() => expect(within(menu).queryByTestId("composer-skill-review")).toBeNull());
    expect(within(menu).getByTestId("composer-skill-refactor")).toBeTruthy();
    // An ordinary sentence owes no skill menu — even with a `/` inside it.
    fireEvent.change(input, { target: { value: "run /build" } });
    await waitFor(() => expect(screen.queryByTestId("composer-skill-menu")).toBeNull());
  });

  it("says the skills aren't locked, and says a no-skill lock has none", async () => {
    renderPanel(dock(), skillRoutes(conversationFixture, null));
    await screen.findByTestId("composer-input");
    fireEvent.click(screen.getByTestId("composer-skill-button"));
    const menu = await screen.findByTestId("composer-skill-menu");
    expect(menu.textContent).toContain("This agent's skills aren't locked yet.");
    expect(within(menu).queryByTestId("composer-skill-review")).toBeNull();

    cleanup();
    renderPanel(dock(), skillRoutes(conversationFixture, { skills: [], truncated: false }));
    await screen.findByTestId("composer-input");
    fireEvent.click(screen.getByTestId("composer-skill-button"));
    const empty = await screen.findByTestId("composer-skill-menu");
    expect(empty.textContent).toContain("This agent has no skills.");
  });

  it("opens the issues menu on # for a GitHub repo, and picking inserts `#<number> `", async () => {
    const { requests } = renderPanel(dock(), [
      ...skillRoutes(repoConversation, { skills: ["review"], truncated: false }),
      { path: reposPath, body: { items: [githubRepo] } },
      { path: issuesPath, body: openIssues },
    ]);
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    // The chat renders without spending the GitHub read — only `#` asks.
    expect(requestsTo(requests, issuesPath)).toHaveLength(0);
    fireEvent.change(input, { target: { value: "#" } });
    const menu = await screen.findByTestId("composer-issue-menu");
    // The read fires on the open, so the items land after the answer.
    expect((await within(menu).findByTestId("composer-issue-7")).textContent).toBe(
      "#7 Search pagination",
    );
    expect((await within(menu).findByTestId("composer-issue-12")).textContent).toBe(
      "#12 Mirror timeout",
    );
    fireEvent.click(within(menu).getByTestId("composer-issue-7"));
    await waitFor(() => expect(input.value).toBe("#7 "));
    expect(screen.queryByTestId("composer-issue-menu")).toBeNull();
    expect(input.selectionStart).toBe("#7 ".length);
    // The read fired exactly once, on the open.
    expect(requestsTo(requests, issuesPath)).toHaveLength(1);
  });

  it("opens no issues menu for a non-GitHub remote — the # stays typed punctuation", async () => {
    const { requests } = renderPanel(dock(), [
      ...skillRoutes(repoConversation, { skills: ["review"], truncated: false }),
      { path: reposPath, body: { items: [localRepo] } },
      { path: issuesPath, body: openIssues },
    ]);
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    // Wait for the repos read to land so the guard has run on real data —
    // the menu stays shut because the remote is not GitHub's.
    await waitFor(() => expect(requestsTo(requests, reposPath)).toHaveLength(1));
    fireEvent.change(input, { target: { value: "#" } });
    expect(screen.queryByTestId("composer-issue-menu")).toBeNull();
    expect(input.value).toBe("#");
    // The GitHub budget is never spent for a remote the route would refuse.
    expect(requestsTo(requests, issuesPath)).toHaveLength(0);
  });

  it("opens no issues menu for a chat that is not repo-scoped", async () => {
    renderPanel(dock(), [
      ...skillRoutes(conversationFixture, { skills: ["review"], truncated: false }),
      { path: issuesPath, body: openIssues },
    ]);
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "#" } });
    expect(screen.queryByTestId("composer-issue-menu")).toBeNull();
  });
});
