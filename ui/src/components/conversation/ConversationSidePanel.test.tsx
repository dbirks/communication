/**
 * The 2e context rail: every section prints only from real data, and the
 * panel with no data at all renders nothing — empty boxes are not sections.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ConversationSidePanel, turnRangeCopy } from "./ConversationSidePanel";
import { AssistantNote } from "./AssistantNote";
import { ASSISTANT_OPEN_EVENT } from "../assistant/AssistantPopover";
import { claudeProfile, codexProfile, projectFixture } from "../../test/fakes";
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
  });

  it("shows no action row when the note offers none", () => {
    render(<AssistantNote text="Just a note." />);
    expect(screen.queryByTestId("assistant-note-dismiss")).toBeNull();
  });
});

/**
 * Thread → workflow (design 2f): the rail's ASSISTANT slot offers `Make a
 * workflow…` for the thread's own chat. The click-through opens the
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
    const ask = (seen[0] as CustomEvent<string>).detail;
    expect(ask).toContain("c-42");
    expect(ask).toContain("Search revamp spike");
    expect(ask).toContain("Read the chat transcript first");
    expect(ask).toContain("Never publish");
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

  it("one note per slot: the host's own assistant note keeps its surface", () => {
    panel({
      projectId: projectFixture.id,
      assistantNote: <AssistantNote text="A real note from the notes store." />,
      workflowChat: chat,
    });
    const slot = screen.getByTestId("side-panel-assistant-slot");
    expect(slot.textContent).toContain("A real note from the notes store.");
    expect(slot.textContent).not.toContain("Make a workflow");
  });

  it("no chat named, no note — the component never invents one", () => {
    panel({ projectId: projectFixture.id });
    expect(screen.queryByTestId("assistant-note-workflow")).toBeNull();
  });
});
