/**
 * The 2e context rail: every section prints only from real data, and the
 * panel with no data at all renders nothing — empty boxes are not sections.
 */
import { cleanup, render, screen } from "@testing-library/react";
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
  return render(
    <MemoryRouter>
      <ConversationSidePanel {...props} />
    </MemoryRouter>,
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
      <MemoryRouter>
        <ConversationSidePanel
          projectId={projectFixture.id}
          assistantNote={hostNote(false)}
          workflowChat={chat}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("assistant-note-workflow")).toBeTruthy();
  });

  it("no chat named, no note — the component never invents one", () => {
    panel({ projectId: projectFixture.id });
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
  });
});
