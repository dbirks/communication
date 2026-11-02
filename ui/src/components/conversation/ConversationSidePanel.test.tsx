/**
 * The 2e context rail: every section prints only from real data, and the
 * panel with no data at all renders nothing — empty boxes are not sections.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { ConversationSidePanel, turnRangeCopy } from "./ConversationSidePanel";
import { AssistantNote } from "./AssistantNote";
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
