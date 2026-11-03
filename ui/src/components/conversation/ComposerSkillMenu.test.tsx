/**
 * The composer's "/ skill" button and menu (design 2e/1h).
 *
 * The menu lists the skill names of the profile the NEXT turn runs on —
 * `apm_contents.skills`, the lock's names-only summary — and is honest about
 * every state it does not have a list for: loading, a refused read, a null
 * `apm_contents` (not locked yet) and a lock with zero skills. A `truncated`
 * lock adds the muted "and more…" line. Nothing in the menu is a sample.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../../api/types";
import { ComposerSkillMenu, skillMenuItems } from "./ComposerSkillMenu";

afterEach(cleanup);

const baseProfile: AgentProfile = {
  id: "01987a71-2222-7000-8000-abcdef012345",
  name: "Codex",
  launcher_id: "codex",
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
};

function profile(apm_contents: AgentProfile["apm_contents"]): AgentProfile {
  return { ...baseProfile, apm_contents };
}

const state = (apm_contents: AgentProfile["apm_contents"]) => ({
  profile: profile(apm_contents),
  loading: false,
  readFailed: false,
  filter: "",
});

describe("skillMenuItems", () => {
  it("lists the profile's locked skills, in the order the lock recorded them", () => {
    const items = skillMenuItems(
      state({ skills: ["review", "refactor"], truncated: false }),
      () => {},
    );
    expect(items.map((item) => ("separator" in item ? null : item.label))).toEqual([
      "review",
      "refactor",
    ]);
  });

  it("says the skills aren't locked when `apm_contents` is null", () => {
    const items = skillMenuItems(state(null), () => {});
    expect(items).toHaveLength(1);
    const item = items[0];
    expect("separator" in item).toBe(false);
    expect((item as { label: string }).label).toBe("This agent's skills aren't locked yet.");
    expect((item as { disabled?: boolean }).disabled).toBe(true);
  });

  it("says the agent has no skills for a lock that locked nothing", () => {
    const items = skillMenuItems(state({ skills: [], truncated: false }), () => {});
    expect(items).toHaveLength(1);
    const item = items[0];
    expect("separator" in item).toBe(false);
    expect((item as { label: string }).label).toBe("This agent has no skills.");
  });

  it("adds the muted 'and more…' line only when the lock is truncated", () => {
    const truncated = skillMenuItems(state({ skills: ["review"], truncated: true }), () => {});
    // The skill stays first; the capped list ends in the muted line.
    expect(truncated[0]).toMatchObject({ id: "review" });
    expect(truncated[truncated.length - 1]).toMatchObject({ id: "more", disabled: true });
    const full = skillMenuItems(state({ skills: ["review"], truncated: false }), () => {});
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ id: "review" });
  });

  it("filters the list by what the person typed after the /", () => {
    const items = skillMenuItems(
      state({ skills: ["review", "refactor"], truncated: false }),
      () => {},
    );
    expect(items.map((item) => ("separator" in item ? null : item.id))).toEqual([
      "review",
      "refactor",
    ]);
    const filtered = skillMenuItems(
      { ...state({ skills: ["review", "refactor"], truncated: false }), filter: "re" },
      () => {},
    );
    expect(filtered.map((item) => ("separator" in item ? null : item.id))).toEqual([
      "review",
      "refactor",
    ]);
    // Case is the person's typing, not the lock's spelling.
    expect(
      skillMenuItems({ ...state({ skills: ["Review"], truncated: false }), filter: "r" }, () => {})
        .length,
    ).toBe(1);
    // A needle no skill starts with owes the honest line, not a fake item.
    const noMatch = skillMenuItems(
      { ...state({ skills: ["review"], truncated: false }), filter: "z" },
      () => {},
    );
    expect(noMatch).toHaveLength(1);
    expect(noMatch[0]).toMatchObject({ id: "no-match", disabled: true });
  });

  it("separates the honest states: loading and a refused read", () => {
    const loading = skillMenuItems(
      { profile: undefined, loading: true, readFailed: false, filter: "" },
      () => {},
    );
    expect(String((loading[0] as { label: unknown }).label)).toContain("Loading");
    const failed = skillMenuItems(
      { profile: undefined, loading: false, readFailed: true, filter: "" },
      () => {},
    );
    expect(String((failed[0] as { label: unknown }).label)).toContain("could not be read");
  });
});

describe("the button and the ds menu", () => {
  it("the button asks the caller to open, and stays closed until told", () => {
    render(
      <ComposerSkillMenu
        state={state({ skills: ["review"], truncated: false })}
        open={false}
        onOpenChange={() => {}}
        onPick={() => {}}
      />,
    );
    const button = screen.getByTestId("composer-skill-button");
    // The collapsed state still names itself for assistive tech.
    expect(button.getAttribute("aria-label")).toBe("Skills");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(screen.queryByTestId("composer-skill-menu")).toBeNull();
  });

  it("opens the shared menu listing the profile's skills, and reports the pick", () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ComposerSkillMenu
        state={state({ skills: ["review", "refactor"], truncated: false })}
        open
        onOpenChange={onOpenChange}
        onPick={onPick}
      />,
    );
    const menu = screen.getByTestId("composer-skill-menu");
    expect(within(menu).getByTestId("composer-skill-review").textContent).toContain("review");
    expect(within(menu).getByTestId("composer-skill-refactor").textContent).toContain("refactor");
    fireEvent.click(within(menu).getByTestId("composer-skill-review"));
    expect(onPick).toHaveBeenCalledWith("review");
    // Esc asks the caller to close; outside-clicks and arrow keys are the
    // ds Menu's own choreography.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the honest state inside the menu, not a fake item", () => {
    render(
      <ComposerSkillMenu state={state(null)} open onOpenChange={() => {}} onPick={() => {}} />,
    );
    const menu = screen.getByTestId("composer-skill-menu");
    expect(menu.textContent).toContain("This agent's skills aren't locked yet.");
    expect(screen.queryByTestId("composer-skill-review")).toBeNull();
  });
});
