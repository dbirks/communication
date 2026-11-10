import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SetupChecklist, { SETUP_STARTERS, setupRowsOf } from "./SetupChecklist";
import type { AssistantSystemStatus } from "../../api/assistant";

afterEach(() => {
  cleanup();
});

/** CONTRACT §1, fully wired server: every model set, a worker up, a token
 * that two repos name, a project, and workflows with one assignment. */
const healthy = (): AssistantSystemStatus => ({
  chat_model: { configured: true, model: "qwen3-8-flash-next" },
  speech_model: { configured: true, model: "qwen3-asr-1-7b" },
  decision_model: { configured: true, model: "system-one" },
  workers: { online: 1, sandbox_mode: "required" },
  execution_mode: "inprocess",
  github_credentials: [{ name: "GITHUB_TOKEN", scope: "org", used_by: 2 }],
  projects: { count: 1 },
  workflows: { count: 3, samples: 2, assigned: 1 },
});

/** The bare server of the design's first run: only a chat model. */
const bare = (): AssistantSystemStatus => ({
  ...healthy(),
  speech_model: { configured: false, model: "" },
  decision_model: { configured: false, model: "" },
  workers: { online: 0, sandbox_mode: "unknown" },
  github_credentials: [],
  projects: { count: 0 },
  workflows: { count: 3, samples: 2, assigned: 0 },
});

const renderChecklist = (status: AssistantSystemStatus, onPrompt = () => {}) =>
  render(<SetupChecklist status={status} onPrompt={onPrompt} />);

const rows = () => screen.getAllByTestId("assistant-setup-row");
const stateOf = (row: HTMLElement) => row.getAttribute("data-state");

describe("SetupChecklist", () => {
  it("opens with the honest headline and the disclosure of the read behind it", () => {
    renderChecklist(healthy());
    expect(screen.getByTestId("assistant-setup")).toBeTruthy();
    expect(screen.getByText("Checked this server.")).toBeTruthy();
    expect(screen.getByTestId("assistant-setup").textContent).toContain("used system.status");
  });

  it("every row is ok on a fully wired server, with its facts in the meta column", () => {
    renderChecklist(healthy());
    const seen = rows();
    expect(seen.map(stateOf)).toEqual(seen.map(() => "ok"));
    expect(seen.map((row) => row.textContent)).toEqual([
      "Chat modelqwen3-8-flash-next",
      "Speech modelqwen3-asr-1-7b",
      "Decision modelsystem-one",
      "1 worker onlinenono required",
      "GitHub credentialGITHUB_TOKEN · 2 reposCheck",
      "1 project",
      "3 workflows · 1 assigned",
    ]);
    // The state rides the glyph's own word, never the colour alone.
    expect(seen[0].querySelector("[role=img]")?.getAttribute("aria-label")).toBe("ok");
    // Only the credential's optional Check stands: nothing warns, and nothing
    // is left for the person to set up.
    expect(screen.getAllByTestId("assistant-setup-action").map((b) => b.textContent)).toEqual([
      "Check",
    ]);
  });

  it("a bare server says so row by row: warn for what blocks the assistant, todo for what the person can add", () => {
    renderChecklist(bare());
    const seen = rows();
    expect(seen.map((row) => [row.textContent, stateOf(row)])).toEqual([
      ["Chat modelqwen3-8-flash-next", "ok"],
      ["No speech modelSet up", "todo"],
      ["No decision modelfixed table decidesSet up", "warn"],
      ["No workers online", "warn"],
      ["No GitHub credentialSet up", "warn"],
      ["No projects yetAdd one", "todo"],
      ["3 workflows, none assignedShow", "todo"],
    ]);
  });

  it("zero workers and one worker pluralize, and an unused credential reads unused", () => {
    expect(
      setupRowsOf({ ...healthy(), workers: { online: 2, sandbox_mode: "optional" } })[3],
    ).toEqual({ state: "ok", label: "2 workers online", meta: "nono optional" });
    expect(
      setupRowsOf({ ...healthy(), github_credentials: [] }).find((row) =>
        row.label.includes("credential"),
      ),
    ).toEqual({
      state: "warn",
      label: "No GitHub credential",
      action: { label: "Set up", prompt: "how do I set up the github credential?" },
    });
    expect(
      setupRowsOf({
        ...healthy(),
        github_credentials: [{ name: "GH", scope: "project", used_by: 0 }],
      })[4].meta,
    ).toBe("GH · unused");
  });

  it("one row per credential the caller can see (names only, never values)", () => {
    renderChecklist({
      ...healthy(),
      github_credentials: [
        { name: "GITHUB_TOKEN", scope: "org", used_by: 0 },
        { name: "DEPLOY_ROBOT", scope: "project", used_by: 1 },
      ],
    });
    const creds = rows().filter((row) => row.textContent?.includes("GitHub credential"));
    expect(creds.map((row) => row.textContent)).toEqual([
      "GitHub credentialGITHUB_TOKEN · unusedCheck",
      "GitHub credentialDEPLOY_ROBOT · 1 repoCheck",
    ]);
    expect(screen.getByTestId("assistant-setup").textContent).not.toContain("ghp_");
  });

  it("each action link sends its exact prompt through the callback", () => {
    const onPrompt = vi.fn();
    renderChecklist(bare(), onPrompt);
    const actions = screen.getAllByTestId("assistant-setup-action");
    expect(actions.map((button) => button.textContent)).toEqual([
      "Set up",
      "Set up",
      "Set up",
      "Add one",
      "Show",
    ]);
    fireEvent.click(actions[0]);
    expect(onPrompt).toHaveBeenLastCalledWith("how do I set up the speech model?");
    fireEvent.click(actions[1]);
    expect(onPrompt).toHaveBeenLastCalledWith("how do I set up the decision model?");
    fireEvent.click(actions[2]);
    expect(onPrompt).toHaveBeenLastCalledWith("how do I set up the github credential?");
    fireEvent.click(actions[3]);
    expect(onPrompt).toHaveBeenLastCalledWith("help me add my first project");
    fireEvent.click(actions[4]);
    expect(onPrompt).toHaveBeenLastCalledWith("what workflows do I have?");
    expect(onPrompt).toHaveBeenCalledTimes(5);
  });

  it("the Check link on a credential asks the token question verbatim", () => {
    const onPrompt = vi.fn();
    renderChecklist(healthy(), onPrompt);
    fireEvent.click(screen.getByTestId("assistant-setup-action"));
    expect(onPrompt).toHaveBeenCalledWith("do you have access to any github tokens?");
  });

  it("three starter rows under the checklist, each sending its own question", () => {
    const onPrompt = vi.fn();
    renderChecklist(healthy(), onPrompt);
    const starters = screen.getAllByTestId("assistant-starter");
    expect(starters.map((button) => button.textContent)).toEqual([...SETUP_STARTERS]);
    starters.forEach((button) => fireEvent.click(button));
    expect(onPrompt.mock.calls.map((call) => call[0])).toEqual([...SETUP_STARTERS]);
  });

  /**
   * Review fix 1: a long credential name must squeeze the MONO META, never
   * the label, and the action link stays inside the card's padding (the
   * 1280/390 screenshots showed the label truncating to "Gi…" and "Check ›"
   * overflowing the card edge).
   */
  it("a 60-char credential name shrinks the meta, never the label, and keeps the action in the card", () => {
    const longName = "assistant-github-mwah83sb-rotation-scan-eu-west-1-replica-07";
    expect(longName.length).toBeGreaterThanOrEqual(60);
    renderChecklist({
      ...healthy(),
      github_credentials: [{ name: longName, scope: "org", used_by: 1 }],
    });
    const row = rows().find((candidate) => candidate.textContent?.includes("GitHub credential"));
    if (!row) throw new Error("the credential row is gone");
    // The label stands whole: full text, no truncation of its own.
    const label = row.querySelector('[data-testid="assistant-setup-label"]') as HTMLElement;
    expect(label.textContent).toBe("GitHub credential");
    expect(label.className).not.toContain("truncate");
    // The mono meta is what shrinks/ellipsizes.
    const meta = row.querySelector('[data-testid="assistant-setup-meta"]') as HTMLElement;
    expect(meta.textContent).toContain(longName);
    expect(meta.className).toContain("min-w-0");
    expect(meta.className).toContain("truncate");
    // The action is the card's own descendant (inside its padding), never an
    // overflow past the card edge, and it never shrinks itself.
    const card = screen.getByTestId("assistant-setup-card");
    const action = screen.getByTestId("assistant-setup-action");
    expect(card.contains(action)).toBe(true);
    expect(action.className).toContain("shrink-0");
  });

  /**
   * Review fix 2 (design L176–195): the state icons are small ROUNDED-SQUARE
   * 16px tiles with a tinted fill — ok done, warn waiting, todo the quiet
   * fill ground — not round circles.
   */
  it("status icons are 16px rounded-square tinted tiles, not circles", () => {
    renderChecklist(bare());
    const icons = rows().map((row) => [
      row.getAttribute("data-state"),
      row.querySelector('[role="img"]') as HTMLElement,
    ]) as Array<[string, HTMLElement]>;
    expect(icons.length).toBeGreaterThan(3);
    for (const [state, icon] of icons) {
      expect(icon.className).toContain("rounded-[3px]");
      expect(icon.className).not.toContain("rounded-full");
      expect(icon.className).toContain("h-[16px]");
      expect(icon.className).toContain("w-[16px]");
      expect(icon.className).toContain(
        state === "ok" ? "bg-st-done-tag" : state === "warn" ? "bg-st-waiting-tag" : "bg-fill",
      );
      // The glyph fills the tile in the state's own foreground.
      expect(
        state === "ok"
          ? "text-st-done-tag-fg"
          : state === "warn"
            ? "text-st-waiting-tag-fg"
            : "text-faint",
      ).toBeTruthy();
      expect(icon.className).toContain(
        state === "ok"
          ? "text-st-done-tag-fg"
          : state === "warn"
            ? "text-st-waiting-tag-fg"
            : "text-faint",
      );
    }
  });
});
