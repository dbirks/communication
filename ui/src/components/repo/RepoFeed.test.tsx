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
    expect(input.placeholder).toBe("Chat in web… ask, plan, or paste an issue");
  });

  it("shortens to the repository's name below 640 — never a mid-word clip", () => {
    renderBox(390);
    const input = screen.getByTestId("repo-chat-input") as HTMLInputElement;
    // The design's prefix survives (the journey test pins `^Chat in app…`);
    // the hint that used to clip away simply is not offered at that width.
    expect(input.placeholder).toBe("Chat in web…");
  });
});

describe("AssistantNotes", () => {
  it("renders nothing at all without notes — no placeholder, no rule", () => {
    const { container } = render(<AssistantNotes notes={[]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("repo-assistant-notes")).toBeNull();
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
