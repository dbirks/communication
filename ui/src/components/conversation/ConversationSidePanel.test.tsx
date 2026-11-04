/**
 * The 2e context rail: every section prints only from real data, and the
 * panel with no data at all renders nothing — empty boxes are not sections.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { agentRunStateCopy, ConversationSidePanel, turnRangeCopy } from "./ConversationSidePanel";
import { AssistantNote, MAKE_WORKFLOW_ACTION_ID } from "./AssistantNote";
import { ASSISTANT_OPEN_EVENT, type AssistantOpenRequest } from "../assistant/AssistantPopover";
import { claudeProfile, codexProfile, projectFixture } from "../../test/fakes";
import type { TurnRecord } from "../../api/transcript";
import type { ConversationChatAgent } from "./ConversationSidePanel";

afterEach(cleanup);

const agents: ConversationChatAgent[] = [
  {
    agent_profile_id: claudeProfile.id,
    agent_profile_name: "Claude Code",
    model: "opus",
    first_turn: 1,
    last_turn: 2,
    turn_count: 2,
  },
  {
    agent_profile_id: codexProfile.id,
    agent_profile_name: "Codex",
    model: "gpt-5",
    first_turn: 3,
    last_turn: 3,
    turn_count: 1,
  },
];

function panel(props: Parameters<typeof ConversationSidePanel>[0]) {
  // A throwaway query cache: the WORKS IN switcher reads the thread's own
  // binding through the shared conversation read (round-8 item 3), and those
  // tests pass a `workflowChat` without a repository name — the section now
  // renders the switcher there too, so the provider is the panel's floor.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConversationSidePanel {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** One journal turn row, in the order the fold builds them (`transcript.turns`). */
function turnRow(turnId: string, status: TurnRecord["status"]): TurnRecord {
  return {
    turnId,
    status,
    stopReason: status === "completed" ? "end_turn" : null,
    interruptReason: null,
    requestedBy: null,
    sessionOrigin: null,
    startedAt: "2026-11-01T12:00:00Z",
  };
}

describe("agentRunStateCopy", () => {
  const rows = [
    turnRow("t-1", "completed"),
    turnRow("t-2", "failed"),
    turnRow("t-3", "failed"),
    turnRow("t-4", "running"),
  ];

  it("says nothing about a run with no failure", () => {
    expect(agentRunStateCopy({ first_turn: 1, last_turn: 1 }, rows)).toBeNull();
    // An open turn is not a failed one, and is not called anything here.
    expect(agentRunStateCopy({ first_turn: 4, last_turn: 4 }, rows)).toBeNull();
  });

  it("names a single-turn run that failed", () => {
    expect(agentRunStateCopy({ first_turn: 2, last_turn: 2 }, rows)).toBe("failed");
  });

  it("counts the failures inside a longer run", () => {
    expect(agentRunStateCopy({ first_turn: 1, last_turn: 2 }, rows)).toBe("1 failed");
    expect(agentRunStateCopy({ first_turn: 1, last_turn: 4 }, rows)).toBe("2 failed");
  });

  it("claims nothing about a turn this read does not reach", () => {
    // An older/partial transcript read must not borrow a neighbour's state.
    expect(agentRunStateCopy({ first_turn: 5, last_turn: 6 }, rows)).toBeNull();
    expect(agentRunStateCopy({ first_turn: 5, last_turn: 6 }, [])).toBeNull();
  });
});

describe("turnRangeCopy", () => {
  it("spells ranges and single turns", () => {
    expect(turnRangeCopy(1, 2)).toBe("turns 1\u20132");
    expect(turnRangeCopy(3, 3)).toBe("turn 3");
  });
});

describe("ConversationSidePanel", () => {
  it("renders nothing without any data", () => {
    panel({ projectId: projectFixture.id });
    expect(screen.queryByTestId("conversation-side-panel")).toBeNull();
  });

  it("names the repository, read-only, linked to its page", () => {
    panel({ projectId: projectFixture.id, repoName: "storefront" });
    const works = screen.getByTestId("side-panel-works-in");
    expect(works.textContent).toContain("storefront");
    expect(works.textContent).toContain("Read-only");
    expect(screen.getByTestId("side-panel-repo-link").getAttribute("href")).toBe(
      `/p/${projectFixture.id}/storefront`,
    );
    // No branch, no agents, no skills, no note: the other sections are absent.
    expect(screen.queryByTestId("side-panel-branch")).toBeNull();
    expect(screen.queryByTestId("side-panel-agents")).toBeNull();
    expect(screen.queryByTestId("side-panel-skills")).toBeNull();
    expect(screen.queryByTestId("side-panel-assistant-slot")).toBeNull();
  });

  it("shows the branch with its file count, and no PR link because none has a source", () => {
    panel({ projectId: projectFixture.id, branch: "chat/search-spike", filesChanged: 4 });
    const branch = screen.getByTestId("side-panel-branch");
    expect(branch.textContent).toContain("chat/search-spike");
    expect(screen.getByTestId("side-panel-files-changed").textContent).toBe("4 files changed");
    expect(screen.queryByTestId("side-panel-pr-link")).toBeNull();
  });

  it("omits the file count the read never answered", () => {
    panel({ projectId: projectFixture.id, branch: "chat/search-spike", filesChanged: null });
    expect(screen.getByTestId("side-panel-branch").textContent).toContain("chat/search-spike");
    expect(screen.queryByTestId("side-panel-files-changed")).toBeNull();
  });

  it("lists the agents with their turn ranges, in transcript order", () => {
    panel({ projectId: projectFixture.id, agents });
    const rows = screen.getAllByTestId(/^side-panel-agent-row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Claude Code · opus");
    expect(screen.getByTestId("side-panel-agent-range-0").textContent).toBe("turns 1\u20132");
    expect(screen.getByTestId("side-panel-agent-range-1").textContent).toBe("turn 3");
    // A profile with no pinned model prints its bare name only.
    expect(rows[1].textContent).toContain("Codex · gpt-5");
    // …and with no turn rows handed to the rail, nothing is claimed about
    // those turns' state.
    expect(screen.queryAllByTestId(/^side-panel-agent-state-/)).toHaveLength(0);
  });

  it("says so on the range when the turn it names failed", () => {
    panel({
      projectId: projectFixture.id,
      agents,
      turns: [turnRow("t-1", "completed"), turnRow("t-2", "failed"), turnRow("t-3", "failed")],
    });
    const rows = screen.getAllByTestId(/^side-panel-agent-row-/);
    // The Claude run (turns 1–2) carries one failure inside a longer range.
    expect(screen.getByTestId("side-panel-agent-state-0").textContent).toBe(
      "\u00b7 \u00d7 1 failed",
    );
    // The Codex run is one turn and that turn failed: the row reads
    // “Codex · gpt-5 · turn 3 · × failed”, not a range that implies the work
    // happened.
    expect(screen.getByTestId("side-panel-agent-state-1").textContent).toBe("\u00b7 \u00d7 failed");
    expect(screen.getByTestId("side-panel-agent-range-1").textContent).toBe("turn 3");
    // Never colour alone (rule 06): glyph and word both ride the row.
    expect(rows[1].textContent).toContain("\u00d7");
    expect(rows[1].textContent).toContain("failed");
  });

  it("leaves a healthy run's range on its own", () => {
    panel({
      projectId: projectFixture.id,
      agents,
      turns: [
        turnRow("t-1", "completed"),
        turnRow("t-2", "completed"),
        turnRow("t-3", "cancelled"),
      ],
    });
    // A cancelled turn is not a failed one, and is not called anything here.
    expect(screen.queryAllByTestId(/^side-panel-agent-state-/)).toHaveLength(0);
  });

  it("renders skills and the assistant slot only when handed them", () => {
    panel({
      projectId: projectFixture.id,
      skills: ["review"],
      assistantNote: <AssistantNote text="Plan → implement → review. This could be a workflow." />,
    });
    expect(screen.getByTestId("side-panel-skills").textContent).toContain("review");
    expect(screen.getByTestId("side-panel-assistant-slot")).toBeTruthy();
    // The repository section is still absent — no read named one.
    expect(screen.queryByTestId("side-panel-works-in")).toBeNull();
  });

  it("keeps the repository id out of the row keys — the same profile twice reads as the transcript says", () => {
    const backAndForth: ConversationChatAgent[] = [
      { ...agents[0], first_turn: 1, last_turn: 1, turn_count: 1 },
      { ...agents[1], first_turn: 2, last_turn: 2, turn_count: 1 },
      { ...agents[0], first_turn: 3, last_turn: 3, turn_count: 1 },
    ];
    panel({ projectId: projectFixture.id, agents: backAndForth });
    const rows = screen.getAllByTestId(/^side-panel-agent-row-/);
    expect(rows).toHaveLength(3);
    expect(rows[2].textContent).toContain("turn 3");
  });
});

describe("AssistantNote", () => {
  it("renders text, actions and dismiss as handed", () => {
    const calls: string[] = [];
    render(
      <AssistantNote
        text="This could be a workflow."
        actions={[{ id: "workflow", label: "Make a workflow…", onSelect: () => calls.push("w") }]}
        onDismiss={() => calls.push("d")}
      />,
    );
    const note = screen.getByTestId("assistant-note");
    expect(note.textContent).toContain("Assistant");
    expect(note.textContent).toContain("This could be a workflow.");
    screen.getByTestId("assistant-note-action-workflow").click();
    screen.getByTestId("assistant-note-dismiss").click();
    expect(calls).toEqual(["w", "d"]);
    // The kind marker the 2e rail reads back to avoid duplicating an action
    // its own notes already offer (ConversationSidePanel).
    expect(
      screen.getByTestId("assistant-note-action-workflow").getAttribute("data-action-kind"),
    ).toBe("workflow");
  });

  it("shows no action row when the note offers none", () => {
    render(<AssistantNote text="Just a note." />);
    expect(screen.queryByTestId("assistant-note-dismiss")).toBeNull();
  });
});

/**
 * Thread → workflow (design 2f): the rail's ASSISTANT section offers `Make a
 * workflow…` as a standing entry for the thread's own chat, in addition to
 * the notes store's own notes — and never twice. The click-through opens the
 * assistant panel with the chat as context — the conversation id travels
 * as data in the ask; authorizing the read stays the server's job.
 */
describe("ConversationSidePanel make-a-workflow note (2f)", () => {
  const chat = { id: "c-42", title: "Search revamp spike" };

  it("offers Make a workflow… when the host names the thread's chat", () => {
    panel({ projectId: projectFixture.id, workflowChat: chat });
    const note = screen.getByTestId("assistant-note-workflow");
    expect(note.textContent).toContain("Search revamp spike");
    const action = screen.getByTestId("assistant-note-workflow-action-make_workflow");
    expect(action.textContent).toBe("Make a workflow…");
  });

  it("the plain button opens the assistant panel with the chat as context", () => {
    const seen: Event[] = [];
    const listener = (event: Event) => seen.push(event);
    window.addEventListener(ASSISTANT_OPEN_EVENT, listener);
    try {
      panel({ projectId: projectFixture.id, workflowChat: chat });
      screen.getByTestId("assistant-note-workflow-action-make_workflow").click();
    } finally {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    // 2f review: the ask is one HUMAN sentence — the conversation id rides
    // as structured context, never as visible prose — and the ask opens
    // the full panel, not the floating popover.
    const ask = (seen[0] as CustomEvent<AssistantOpenRequest>).detail;
    expect(ask.text).toBe("Turn the chat \u201CSearch revamp spike\u201D into a workflow");
    expect(ask.text).not.toContain("c-42");
    expect(ask.entity).toEqual({ kind: "conversation", id: "c-42" });
    expect(ask.expanded).toBe(true);
  });

  it("a host-supplied handler replaces the default open", () => {
    const onMakeWorkflow = vi.fn();
    const seen: Event[] = [];
    const listener = (event: Event) => seen.push(event);
    window.addEventListener(ASSISTANT_OPEN_EVENT, listener);
    try {
      panel({ projectId: projectFixture.id, workflowChat: chat, onMakeWorkflow });
      screen.getByTestId("assistant-note-workflow-action-make_workflow").click();
    } finally {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, listener);
    }
    expect(onMakeWorkflow).toHaveBeenCalledWith(chat);
    expect(seen).toHaveLength(0);
  });

  it("the standing Make a workflow… rides below the host's notes, not in place of them", () => {
    // The notes-generate-wire worker used to make a real note replace the
    // standing 2f entry, hiding it whenever the panel had a note. The
    // standing link is now shown in addition to the notes.
    panel({
      projectId: projectFixture.id,
      assistantNote: (
        <AssistantNote text="A real note from the notes store." onDismiss={() => {}} />
      ),
      workflowChat: chat,
    });
    const slot = screen.getByTestId("side-panel-assistant-slot");
    expect(slot.textContent).toContain("A real note from the notes store.");
    const standing = screen.getByTestId("assistant-note-workflow");
    expect(standing.textContent).toContain("Make a workflow\u2026");
    // The standing link sits at the bottom of the ASSISTANT section.
    expect(slot.lastElementChild).toBe(standing);
  });

  it("prints ONE Assistant heading for the whole section (review 2e)", () => {
    // Two notes drew two `ASSISTANT` headings and the first note's `dismiss`
    // sat hard against the second. The section owns the heading; a note inside
    // the group keeps the word for assistive tech, off screen.
    panel({
      projectId: projectFixture.id,
      assistantNote: (
        <AssistantNote text="A real note from the notes store." onDismiss={() => {}} />
      ),
      workflowChat: chat,
    });
    const section = screen.getByTestId("side-panel-assistant");
    expect(section.querySelectorAll("h2")).toHaveLength(1);
    expect(section.querySelector("h2")?.textContent).toBe("Assistant");
    expect(section.getAttribute("aria-labelledby")).toBe("side-panel-assistant-heading");
    for (const title of section.querySelectorAll("[data-testid$=-title]")) {
      expect(title.className).toContain("sr-only");
    }
    // The notes are spaced inside the section, and the slot keeps its own
    // identity (the 2f journey's `last child is the standing link` test).
    expect(screen.getByTestId("side-panel-assistant-slot").className).toContain("space-y-[14px]");
  });

  it("does not duplicate itself when a note already offers make_workflow", () => {
    panel({
      projectId: projectFixture.id,
      assistantNote: (
        <AssistantNote
          text="This chat reads like a workflow."
          actions={[
            { id: MAKE_WORKFLOW_ACTION_ID, label: "Make a workflow\u2026", onSelect: () => {} },
          ]}
        />
      ),
      workflowChat: chat,
    });
    // The note's own action is the one reachable entry — not a second one.
    expect(screen.getByTestId("assistant-note-action-make_workflow")).toBeTruthy();
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
    expect(screen.queryAllByTestId("assistant-note-workflow-action-make_workflow")).toHaveLength(0);
  });

  it("the standing note returns when the note that duplicated it goes away", () => {
    const hostNote = (withAction: boolean) => (
      <AssistantNote
        text="Notes store note."
        actions={
          withAction
            ? [{ id: MAKE_WORKFLOW_ACTION_ID, label: "Make a workflow\u2026", onSelect: () => {} }]
            : []
        }
      />
    );
    const { rerender } = panel({
      projectId: projectFixture.id,
      assistantNote: hostNote(true),
      workflowChat: chat,
    });
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <ConversationSidePanel
            projectId={projectFixture.id}
            assistantNote={hostNote(false)}
            workflowChat={chat}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("assistant-note-workflow")).toBeTruthy();
  });

  it("no chat named, no note — the component never invents one", () => {
    panel({ projectId: projectFixture.id });
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
  });
});

/**
 * The design's `Make a workflow… dismiss` (2e, rcn-chat-rail-390): the
 * standing note is the panel's own — dismissing it is the host's behaviour
 * (per-conversation in the chat page), and the panel only offers the link
 * when that behaviour exists and obeys it when it has happened.
 */
describe("the standing note's dismiss (2e)", () => {
  const chat = { id: "c-42", title: "Search revamp spike" };

  it("offers dismiss beside Make a workflow… when the host can dismiss, and clicking it calls the host", () => {
    const onDismiss = vi.fn();
    panel({
      projectId: projectFixture.id,
      workflowChat: chat,
      onDismissWorkflowNote: onDismiss,
    });
    expect(screen.getByTestId("assistant-note-workflow-action-make_workflow")).toBeTruthy();
    const dismiss = screen.getByTestId("assistant-note-workflow-dismiss");
    expect(dismiss.textContent).toBe("dismiss");
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows no dismiss when the host cannot dismiss one", () => {
    panel({ projectId: projectFixture.id, workflowChat: chat });
    expect(screen.queryByTestId("assistant-note-workflow-dismiss")).toBeNull();
  });

  it("hides the standing note entirely once the host dismissed it", () => {
    panel({
      projectId: projectFixture.id,
      workflowChat: chat,
      workflowNoteDismissed: true,
      onDismissWorkflowNote: () => {},
    });
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
    // Nothing else on the rail names the suggestion either — the section is
    // gone with the note, not an empty ASSISTANT heading.
    expect(screen.queryByTestId("side-panel-assistant")).toBeNull();
    // The panel itself survives on its own data: a named thread always shows
    // its WORKS IN switcher (round-8 item 3 made the section the switcher's,
    // not the repository name's), so "no notes" is no longer "no panel".
    expect(screen.getByTestId("side-panel-works-in")).toBeTruthy();
  });

  it("keeps the host's stored notes beside a dismissed standing note", () => {
    panel({
      projectId: projectFixture.id,
      workflowChat: chat,
      workflowNoteDismissed: true,
      assistantNote: (
        <AssistantNote text="A real note from the notes store." onDismiss={() => {}} />
      ),
    });
    const slot = screen.getByTestId("side-panel-assistant-slot");
    expect(slot.textContent).toContain("A real note from the notes store.");
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
  });
});

// --- WORKS IN switcher (ADR-0067 amendment) ------------------------------

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCsrfToken } from "../../api/client";
import { resetReplicaName } from "../../api/replica";
import { queryKeys } from "../../api/queries";
import { conversationFixture, conversationId, mockFetch, type RouteStub } from "../../test/fakes";
import type { Conversation, Repository } from "../../api/types";

function scopeRepo(id: string, name: string): Repository {
  return {
    id,
    project_id: projectFixture.id,
    name,
    git_url: `https://git.example/${name}.git`,
    default_branch: "main",
    created_at: "2026-10-14T18:00:00Z",
    credential: "none",
  };
}

/** The rail with its one live thread: the reads the switcher needs and the
 * PATCH its pick sends, answered by a throwaway cache. */
function scopePanel(
  routes: RouteStub[],
  extra: Partial<Parameters<typeof ConversationSidePanel>[0]> = {},
) {
  setCsrfToken(null);
  resetReplicaName();
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConversationSidePanel
          projectId={projectFixture.id}
          repoName="storefront"
          workflowChat={{ id: conversationId, title: "Fix the flaky test" }}
          {...extra}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, fetchMock, requests, queryClient };
}

describe("WORKS IN switcher (ADR-0067 amendment)", () => {
  const repoStore = scopeRepo("01987a79-aaaa-7000-8000-abcdef011111", "storefront");
  const repoApi = scopeRepo("01987a79-aaaa-7000-8000-abcdef022222", "acme-api");

  it("lists the project's repositories plus the whole project, ticks the declared binding, and patches on a pick", async () => {
    // The server-side fact the stubs agree on: the binding the thread
    // carries. The GET answers it on every refetch, the PATCH moves it.
    let binding: string | null = repoStore.id;
    const view = scopePanel([
      {
        method: "GET",
        path: `/api/v1/conversations/${conversationId}`,
        body: () => ({ ...conversationFixture, repository_id: binding }),
      },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/repos`,
        body: { items: [repoStore, repoApi] },
      },
      {
        method: "PATCH",
        path: `/api/v1/conversations/${conversationId}`,
        body: () => {
          binding = repoApi.id;
          return { ...conversationFixture, repository_id: binding };
        },
      },
    ]);

    // The switcher replaces the read-only sentence: the move applies from
    // the next turn, which is the rail's whole note about it.
    expect(screen.getByTestId("side-panel-works-in-switch")).toBeTruthy();
    expect(screen.getByTestId("side-panel-works-in-note").textContent).toBe(
      "Applies from the next turn.",
    );

    fireEvent.click(screen.getByTestId("side-panel-works-in-switch"));
    await screen.findByRole("menu");
    // Every project repository plus "Whole project" …
    expect(screen.getByTestId("side-panel-scope-item-whole").textContent).toContain(
      "Whole project",
    );
    await screen.findByTestId("side-panel-scope-item-storefront");
    await screen.findByTestId("side-panel-scope-item-acme-api");
    // … the declared binding ticked, nothing else.
    expect(screen.getByTestId("side-panel-scope-item-storefront").textContent).toContain("✓");
    expect(screen.getByTestId("side-panel-scope-item-acme-api").textContent).not.toContain("✓");
    expect(screen.getByTestId("side-panel-scope-item-whole").textContent).not.toContain("✓");

    fireEvent.click(screen.getByTestId("side-panel-scope-item-acme-api"));

    // The pick is one PATCH, its body the id verbatim.
    let patch: (typeof view.requests)[number] | undefined;
    await vi.waitFor(() => {
      patch = view.requests.find(
        (request) =>
          request.method === "PATCH" && request.url === `/api/v1/conversations/${conversationId}`,
      );
      expect(patch?.body).toBe(JSON.stringify({ repository_id: repoApi.id }));
    });
    // The fresh read lands in the shared cache: the page's own
    // `useConversation` entry, not a second read of its own.
    await vi.waitFor(() => {
      const cached = view.queryClient.getQueryData<Conversation>(
        queryKeys.conversation(conversationId),
      );
      expect(cached?.repository_id).toBe(repoApi.id);
    });
    // The menu closed with the pick.
    expect(screen.queryByTestId("side-panel-scope-menu")).toBeNull();
  });

  it("wears the scope name and caret in ONE select-style trigger (round-8 review item 3)", async () => {
    scopePanel([
      {
        method: "GET",
        path: `/api/v1/conversations/${conversationId}`,
        body: { ...conversationFixture, repository_id: repoStore.id },
      },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/repos`,
        body: { items: [repoStore, repoApi] },
      },
    ]);
    // The trigger IS the scope name now — "storefront ▾" — not a
    // label-less ▾ box beside a separate link.
    const trigger = (await screen.findByTestId("side-panel-works-in-switch")) as HTMLButtonElement;
    expect(trigger.textContent).toContain("storefront");
    expect(trigger.textContent).toContain("▾");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Switch the repository this chat works in");
    // The menu is the section's one door: the standalone repository-page
    // link no longer rides beside the switcher.
    expect(screen.queryByTestId("side-panel-repo-link")).toBeNull();
  });

  it("names the whole project on an unbound thread the reads do not name, without the hint", async () => {
    // The host's resolved name is absent (no binding, no workspace repo), so
    // the trigger's word is the scope itself: "Whole project ▾".
    scopePanel(
      [
        {
          method: "GET",
          path: `/api/v1/conversations/${conversationId}`,
          body: { ...conversationFixture, repository_id: null },
        },
        {
          method: "GET",
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: { items: [repoStore, repoApi] },
        },
      ],
      { repoName: null },
    );
    const trigger = await screen.findByTestId("side-panel-works-in-switch");
    // The switcher falls back to the host's resolved name until the thread's
    // own binding read lands; only the read's null claims "Whole project".
    await vi.waitFor(() => expect(trigger.textContent).toContain("Whole project"));
    // Already whole project: switching there buys nothing, so no hint.
    expect(screen.queryByTestId("side-panel-works-in-switch-hint")).toBeNull();
  });

  it('a moved chat says "Whole project" in the trigger even when the host still resolves a repository (rcn-2e works-in-moved)', async () => {
    // The host's resolved name is the workspace's repository — the thread
    // moved to the whole project, its workspace still checked out one, and
    // the old page handed that name down. The trigger's word is the
    // DECLARED binding's word, so it says "Whole project", never the
    // workspace's checkout.
    scopePanel(
      [
        {
          method: "GET",
          path: `/api/v1/conversations/${conversationId}`,
          body: { ...conversationFixture, repository_id: null },
        },
        {
          method: "GET",
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: { items: [repoStore, repoApi] },
        },
      ],
      { repoName: "storefront" },
    );
    const trigger = await screen.findByTestId("side-panel-works-in-switch");
    await vi.waitFor(() => expect(trigger.textContent).toContain("Whole project"));
    expect(trigger.textContent).not.toContain("storefront");
    // The tick agrees with the word: whole project is the current scope.
    fireEvent.click(trigger);
    await screen.findByRole("menu");
    expect(screen.getByTestId("side-panel-scope-item-whole").textContent).toContain("✓");
  });

  it("a bound chat keeps the repository's name in the trigger while the binding is read", async () => {
    // The declared binding names a repository: the trigger reads that
    // repository's name (the host's resolved word), not the whole project.
    scopePanel(
      [
        {
          method: "GET",
          path: `/api/v1/conversations/${conversationId}`,
          body: { ...conversationFixture, repository_id: repoStore.id },
        },
        {
          method: "GET",
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: { items: [repoStore, repoApi] },
        },
      ],
      { repoName: "storefront" },
    );
    const trigger = await screen.findByTestId("side-panel-works-in-switch");
    await vi.waitFor(() => expect(trigger.textContent).toContain("storefront"));
    expect(trigger.textContent).not.toContain("Whole project");
  });

  it("owes the other-repos hint only to a bound chat in a multi-repo project", async () => {
    // Bound to one of TWO repositories: the hint is due, from the panel's
    // own repos read (no extra fetch — the count is that read's length).
    scopePanel([
      {
        method: "GET",
        path: `/api/v1/conversations/${conversationId}`,
        body: { ...conversationFixture, repository_id: repoStore.id },
      },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/repos`,
        body: { items: [repoStore, repoApi] },
      },
    ]);
    const hint = await screen.findByTestId("side-panel-works-in-switch-hint");
    expect(hint.textContent).toBe(
      "Switch to Whole project to let the agent read the project's other repos.",
    );
    // "Applies from the next turn." stays the section's standing note.
    expect(screen.getByTestId("side-panel-works-in-note").textContent).toBe(
      "Applies from the next turn.",
    );

    cleanup();
    // One repository: there are no other repos to read, so no hint.
    scopePanel([
      {
        method: "GET",
        path: `/api/v1/conversations/${conversationId}`,
        body: { ...conversationFixture, repository_id: repoStore.id },
      },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/repos`,
        body: { items: [repoStore] },
      },
    ]);
    await screen.findByTestId("side-panel-works-in-switch");
    expect(screen.queryByTestId("side-panel-works-in-switch-hint")).toBeNull();
  });

  it("moves an unbound thread to the whole project and back, patching null for it", async () => {
    const seen: string[] = [];
    // One binding, the stubs' shared fact: the GET answers it, the PATCH
    // moves it.
    let binding: string | null = repoStore.id;
    const view = scopePanel([
      {
        method: "GET",
        path: `/api/v1/conversations/${conversationId}`,
        body: () => ({ ...conversationFixture, repository_id: binding }),
      },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/repos`,
        body: { items: [repoStore, repoApi] },
      },
      {
        method: "PATCH",
        path: `/api/v1/conversations/${conversationId}`,
        body: (n: number) => {
          const id = n === 1 ? null : repoStore.id;
          binding = id;
          seen.push(n === 1 ? "null" : repoStore.id);
          return { ...conversationFixture, repository_id: id };
        },
      },
    ]);

    // Whole project first: the binding goes null, the patch says so.
    fireEvent.click(screen.getByTestId("side-panel-works-in-switch"));
    await screen.findByRole("menu");
    fireEvent.click(screen.getByTestId("side-panel-scope-item-whole"));
    await vi.waitFor(() => {
      expect(view.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([
        JSON.stringify({ repository_id: null }),
      ]);
    });
    await vi.waitFor(() => {
      expect(
        view.queryClient.getQueryData<Conversation>(queryKeys.conversation(conversationId))
          ?.repository_id,
      ).toBeNull();
    });

    // … and back into a repository from the refreshed list.
    fireEvent.click(screen.getByTestId("side-panel-works-in-switch"));
    await screen.findByRole("menu");
    await screen.findByTestId("side-panel-scope-item-storefront");
    // The refreshed read re-ticks: the whole project is current now.
    expect(screen.getByTestId("side-panel-scope-item-whole").textContent).toContain("✓");
    fireEvent.click(screen.getByTestId("side-panel-scope-item-storefront"));
    await vi.waitFor(() => {
      expect(view.requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
      expect(seen).toEqual(["null", repoStore.id]);
    });
  });
});
