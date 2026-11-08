/**
 * The repo page's new pieces, unit-tested where the page test cannot reach:
 * the merged feed order, the honest step-segment rule (segments only from
 * real step data — the project run list has none, so the strip is omitted),
 * the phone reflow of an activity row (the 120px workflow/agents column
 * leaves the grid below 640px and reprints under the title) and the chat
 * box's short placeholder there, and `AssistantNotes`, which renders nothing
 * without notes and the notes panel when a source finally hands them over.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { buildActivityRows, RepoActivity, runStepSegments } from "./RepoActivity";
import { RepoChatBox } from "./RepoChatBox";
import { AssistantNotes } from "./AssistantNotes";
import type { ConversationSummary, RunSummary } from "../../api/types";
import {
  claudeProfile,
  conversationFixture,
  meFixture,
  mockFetch,
  projectFixture,
} from "../../test/fakes";
import { testidOf } from "../../lib/format";
import { WIRE_PIPELINE_ID, WIRE_REVISION_ID } from "../../test/fixtures/m4/wire";

afterEach(cleanup);

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "01987c11-0000-7000-8000-abcdef012345",
    project_id: projectFixture.id,
    pipeline_id: WIRE_PIPELINE_ID,
    pipeline_revision_id: WIRE_REVISION_ID,
    revision_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    plan_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    status: "running",
    depth: 0,
    triggered_by: meFixture.id,
    priority: 0,
    created_at: "2026-11-01T09:00:00Z",
    started_at: "2026-11-01T09:01:00Z",
    ...overrides,
  };
}

function chat(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    ...conversationFixture,
    project_id: projectFixture.id,
    control: conversationFixture.control,
    origin: "manual",
    run_link: null,
    ...overrides,
  };
}

describe("buildActivityRows", () => {
  it("merges runs and chats by last activity, newest first", () => {
    const rows = buildActivityRows(
      [
        run({ id: "01987c11-000a-7000-8000-abcdef012345", finished_at: "2026-11-01T10:00:00Z" }),
        run({
          id: "01987c11-000b-7000-8000-abcdef012345",
          status: "completed",
          finished_at: "2026-10-30T10:00:00Z",
        }),
      ],
      [chat({ id: "01987c11-000c-7000-8000-abcdef012345", updated_at: "2026-11-01T09:30:00Z" })],
    );
    expect(rows.map((row) => row.kind)).toEqual(["run", "chat", "run"]);
    expect(rows[0]?.run?.finished_at).toBe("2026-11-01T10:00:00Z");
  });
});

describe("runStepSegments", () => {
  it("returns null without real step data — the project run list has none", () => {
    expect(runStepSegments(run())).toBeNull();
    expect(runStepSegments(run({ steps: [] } as never))).toBeNull();
  });

  it("counts the served steps into segments, never inventing one", () => {
    const segments = runStepSegments(
      run({
        steps: [
          { state: "succeeded" },
          { state: "succeeded" },
          { state: "running" },
          { state: "pending" },
          { state: "pending" },
        ],
      } as never),
    );
    expect(segments).toEqual([
      { kind: "done", count: 2 },
      { kind: "running", count: 1 },
      { kind: "open", count: 2 },
    ]);
  });
});

describe("the activity row's phone reflow (design 3a)", () => {
  function renderActivity(rows: ReturnType<typeof buildActivityRows>) {
    render(
      <MemoryRouter>
        <RepoActivity
          rows={rows}
          nameFor={(pipelineId) => (pipelineId === WIRE_PIPELINE_ID ? "Issue to PR" : null)}
          profileNameFor={() => "Claude Code"}
          meId={null}
          repositoryName="web"
          projectId={projectFixture.id}
          runsPending={false}
          runsError={null}
          onRetryRuns={() => {}}
          retryingRuns={false}
          chatsPending={false}
          chatsError={null}
          onRetryChats={() => {}}
          retryingChats={false}
        />
      </MemoryRouter>,
    );
  }

  it("drops the 120px column below 640px and reprints its words under the title", () => {
    const theRun = run({ title: "#412 Checkout rounds tax wrong" });
    const theChat = chat({ title: "Search revamp spike" });
    renderActivity(buildActivityRows([theRun], [theChat]));

    // The row grid: no 120px track below `sm`; the age moves up into it.
    const runLink = screen.getByTestId(`repo-run-${testidOf(theRun.id)}`);
    expect(runLink.className).toContain("grid-cols-[16px_44px_minmax(0,1fr)_36px]");
    expect(runLink.className).toContain("sm:grid-cols-[16px_44px_minmax(0,1fr)_120px_36px]");

    // The workflow column is the desktop one (hidden below `sm`, never
    // narrowed); the second line is the phone one (`sm:hidden`) — the title
    // and its status word keep the whole first line either way.
    const workflow = screen.getByTestId(`repo-run-workflow-${testidOf(theRun.id)}`);
    expect(workflow.textContent).toBe("Issue to PR");
    expect(workflow.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["hidden", "sm:block", "min-w-0", "truncate"]),
    );
    const runMeta = screen.getByTestId(`repo-run-meta-${testidOf(theRun.id)}`);
    expect(runMeta.textContent).toBe("Issue to PR");
    expect(runMeta.className.split(/\s+/)).toEqual(expect.arrayContaining(["block", "sm:hidden"]));
    expect(runLink.textContent).toContain("#412 Checkout rounds tax wrong");
    // The status word rides a `shrink-0` span: a long title truncates
    // before it, never through it.
    const statusRead = runLink.querySelector<HTMLSpanElement>("span.shrink-0");
    expect(statusRead?.className.split(/\s+/)).toContain("shrink-0");
    expect(statusRead?.textContent).toBe("· running");

    // Chat rows carry their agent the same two ways.
    const chatLink = screen.getByTestId(`repo-chat-row-${testidOf(theChat.id)}`);
    const agent = screen.getByTestId(`repo-chat-agent-${testidOf(theChat.id)}`);
    expect(agent.textContent).toBe("Claude Code");
    expect(agent.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["hidden", "sm:block", "min-w-0", "truncate"]),
    );
    const chatMeta = screen.getByTestId(`repo-chat-meta-${testidOf(theChat.id)}`);
    expect(chatMeta.textContent).toBe("Claude Code");
    expect(chatMeta.className.split(/\s+/)).toEqual(expect.arrayContaining(["block", "sm:hidden"]));
    expect(chatLink.textContent).toContain("Search revamp spike");
  });
});

describe("the chat box placeholder at phone width", () => {
  /** Answer `matchMedia` as a `width`-px viewport would. */
  function stubViewport(width: number): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: width < 640 && query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
  }

  function renderBox(width: number): void {
    stubViewport(width);
    mockFetch([{ path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } }]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RepoChatBox projectId={projectFixture.id} repositoryName="web" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("keeps the whole hint at 1280", () => {
    renderBox(1280);
    const input = screen.getByTestId("repo-chat-input") as HTMLInputElement;
    expect(input.placeholder).toBe("Thread in web… ask, plan, or paste an issue");
    // One row, one line: the input takes the space the controls leave.
    expect(screen.getByTestId("repo-chat-row").className).toContain("flex-nowrap");
    expect(input.className).toContain("flex-1");
  });

  it("keeps the repo cue below 640 — shortened, not stripped (round-19 3a)", () => {
    renderBox(390);
    const input = screen.getByTestId("repo-chat-input") as HTMLInputElement;
    // Review 3a (round 3) shortened the phone hint to the bare verb; round-19
    // review caught that losing the repository — the one line that says the
    // chat starts IN this repo (ADR-0067) is the line to keep. The phone
    // placeholder is the shortened sentence, repo cue first; the full hint
    // stays at 1280 and the accessible name always carries the repo.
    expect(input.placeholder).toBe("Thread in web…");
    expect(input.getAttribute("aria-label")).toBe("Thread in web");
  });

  it("gives the hint the whole first line below 640 — the controls wrap under it", () => {
    // Review 3a, item 1: even the short hint clipped to `Ask, plan or paste an
    // iss` because the chip and `Start` shared the row. The row wraps and the
    // input asks for the full width, so the hint reads whole and the two
    // controls ride the second line.
    renderBox(390);
    const input = screen.getByTestId("repo-chat-input") as HTMLInputElement;
    expect(screen.getByTestId("repo-chat-row").className).toContain("flex-wrap");
    expect(input.className).toContain("w-full");
    expect(input.className).not.toContain("flex-1");
    expect(screen.getByTestId("repo-chat-profile").className).toContain("ml-auto");
  });
});

/** The problem+json a failed read answers, as the API client carries it. */
function serverProblem(title: string, status: number, detail: string): ApiError {
  const body = { type: "about:blank", title, status, detail };
  return new ApiError(body, body);
}

describe("the feed's load-failure card (review 3a, item 2)", () => {
  function renderActivityWithErrors(): void {
    render(
      <MemoryRouter>
        <RepoActivity
          rows={[]}
          nameFor={() => null}
          profileNameFor={() => null}
          meId={null}
          repositoryName="web"
          projectId={projectFixture.id}
          runsPending={false}
          runsError={serverProblem("Internal Server Error", 500, "emulated failure")}
          onRetryRuns={() => {}}
          retryingRuns={false}
          chatsPending={false}
          chatsError={null}
          onRetryChats={() => {}}
          retryingChats={false}
        />
      </MemoryRouter>,
    );
  }

  it("says the break ONCE, and keeps the server's words and the Retry", () => {
    renderActivityWithErrors();
    const card = screen.getByTestId("repo-runs-problem");
    expect(screen.getByTestId("repo-runs-problem-summary").textContent).toBe(
      "Couldn't load this repository's runs.",
    );
    // The three-sentence banner is the defect: neither the call site's
    // restatement nor the generic status sentence may ride the card.
    expect(card.textContent).not.toContain("Runs could not be loaded");
    expect(card.textContent).not.toContain("The server had a problem");
    // Evidence stays in the DOM behind the disclosure, and the verb stays.
    expect(screen.getByTestId("repo-runs-problem-server").textContent).toContain(
      "Internal Server Error: emulated failure",
    );
    expect(screen.getByTestId("repo-runs-retry").textContent).toBe("Retry");
    // A state is never colour alone: the bar carries glyph + word.
    expect(card.querySelector("[data-ds-bar]")?.textContent).toContain("COULDN'T LOAD");
  });

  it("re-asks for the failed read from the card's Retry", () => {
    const onRetryRuns = vi.fn();
    render(
      <MemoryRouter>
        <RepoActivity
          rows={[]}
          nameFor={() => null}
          profileNameFor={() => null}
          meId={null}
          repositoryName="web"
          projectId={projectFixture.id}
          runsPending={false}
          runsError={serverProblem("Not Found", 404, "")}
          onRetryRuns={onRetryRuns}
          retryingRuns={false}
          chatsPending={false}
          chatsError={null}
          onRetryChats={() => {}}
          retryingChats={false}
        />
      </MemoryRouter>,
    );
    // A refusal is a fact, not a break: no collapsed server quote, and the
    // card still answers with its one sentence.
    expect(screen.queryByTestId("repo-runs-problem-details")).toBeNull();
    expect(screen.getByTestId("repo-runs-problem-summary").textContent).toBe(
      "Couldn't load this repository's runs.",
    );
  });
});

describe("AssistantNotes", () => {
  it("keeps the heading with its honest empty line without notes — no placeholder, no rule", () => {
    render(<AssistantNotes notes={[]} />);
    // rcn-review13 item 3: the section is the reader's contract — the
    // heading stands with one muted line; a placeholder note would be a
    // fake one.
    const panel = screen.getByTestId("repo-assistant-notes");
    expect(panel.textContent).toContain("ASSISTANT NOTICED");
    expect(screen.getByTestId("repo-assistant-notes-empty").textContent).toContain(
      "Nothing noticed yet",
    );
    expect(panel.querySelector("[data-testid^='repo-assistant-note-'")).toBeNull();
  });

  it("renders up to three notes, each with its action and dismiss", () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    const notes = [1, 2, 3, 4].map((n) => ({
      id: `note-${n}`,
      text: `Note number ${n}.`,
      action: { label: "Start a fix chat", onSelect: onAction },
    }));
    render(<AssistantNotes notes={notes} onDismiss={onDismiss} />);
    expect(screen.getByTestId("repo-assistant-notes")).toBeTruthy();
    expect(screen.queryByTestId("repo-assistant-note-note-4")).toBeNull();
    expect(screen.getByTestId("repo-assistant-note-note-1").textContent).toContain(
      "Note number 1.",
    );
    fireEvent.click(screen.getByTestId("repo-assistant-note-note-1-action"));
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("repo-assistant-note-note-2-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0]?.[0]?.id).toBe("note-2");
  });
});
