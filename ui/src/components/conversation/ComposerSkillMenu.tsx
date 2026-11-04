/**
 * The composer's "/ skill" button and its menu (design 2e/1h).
 *
 * The button sits between the agent chip and `Send`. It opens the shared ds
 * `Menu` (pointer arrow, Esc/outside-click, arrow keys) listing the skill
 * names of the agent profile the NEXT turn will run on, taken from that
 * profile's `apm_contents.skills` — the names-only lock summary the worker
 * records (api/openapi.yaml `AgentProfile.apm_contents`), never a sample
 * list. Picking a name is reported to the caller, which inserts `/<name> `
 * at the caret.
 *
 * The menu is honest about what it does not know (no fake items):
 *
 * - the profile list is still loading → a loading line;
 * - the read failed → the failure, in words;
 * - `apm_contents` null (no lock recorded) → "not locked yet";
 * - a lock with zero skills → "no skills";
 * - `truncated` → a muted "and more…" line after the capped list.
 *
 * The visible label is "/ skill" at EVERY width, 390px phones included
 * (round-8 review: a lone "/" on its own row named nothing) — the word is
 * short enough that the chip, the button and Send still share the one row
 * under the textbox without overflow.
 */
import { useRef } from "react";
import type { AgentProfile } from "../../api/types";
import { Menu, type MenuEntry } from "../ds/Menu";

/** Why the skill list the menu owes the person is not the lock's own list. */
export interface ComposerSkillMenuState {
  profile: AgentProfile | undefined;
  /** The organization's profile list is still loading. */
  loading: boolean;
  /** The profile list read refused — "could not be read", not "not locked". */
  readFailed: boolean;
  /** What the person typed after the `/` — the list is filtered by prefix. */
  filter: string;
}

/**
 * The menu's items, in the states a member may see. `onPick` names the
 * skill; the caller completes the token in the composer.
 */
export function skillMenuItems(
  state: ComposerSkillMenuState,
  onPick: (skill: string) => void,
): MenuEntry[] {
  const { profile, loading, readFailed } = state;
  if (loading) {
    return [
      { id: "loading", label: "Loading the agent's skills…", onSelect: () => {}, disabled: true },
    ];
  }
  if (readFailed) {
    return [
      {
        id: "failed",
        label: "The agent's skills could not be read.",
        onSelect: () => {},
        disabled: true,
      },
    ];
  }
  const contents = profile?.apm_contents;
  if (contents === undefined || contents === null) {
    return [
      {
        id: "unlocked",
        label: "This agent's skills aren't locked yet.",
        onSelect: () => {},
        disabled: true,
      },
    ];
  }
  const locked = contents.skills ?? [];
  if (locked.length === 0) {
    return [{ id: "none", label: "This agent has no skills.", onSelect: () => {}, disabled: true }];
  }
  const needle = state.filter.toLowerCase();
  const skills = locked.filter((name) => name.toLowerCase().startsWith(needle));
  if (skills.length === 0) {
    return [{ id: "no-match", label: "No skill matches.", onSelect: () => {}, disabled: true }];
  }
  const items: MenuEntry[] = skills.map((name) => ({
    id: name,
    label: name,
    testId: `composer-skill-${name}`,
    onSelect: () => onPick(name),
  }));
  if (contents.truncated === true) {
    items.push({
      id: "more",
      label: <span className="font-mono text-[11px] text-faint">and more…</span>,
      onSelect: () => {},
      disabled: true,
    });
  }
  return items;
}

export interface ComposerSkillMenuProps {
  state: ComposerSkillMenuState;
  /** The menu is open; the caller owns that state (typing `/` opens it, too). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Insert `/<name> ` at the caret; the menu closes itself. */
  onPick: (skill: string) => void;
  /** Nobody who cannot prompt cannot open the menu either. */
  disabled?: boolean;
}

export function ComposerSkillMenu({
  state,
  open,
  onOpenChange,
  onPick,
  disabled = false,
}: ComposerSkillMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        data-testid="composer-skill-button"
        aria-label="Skills"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="The agent's skills"
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-[28px] items-center gap-[3px] rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[11.5px] text-ink hover:border-ink disabled:cursor-not-allowed disabled:text-muted"
      >
        <span aria-hidden="true">/</span>
        {/* The word never folds: "skill" is short enough that "/ skill" and
            the caret-free label fit the 390px controls row with the chip and
            Send (round-8 review item 2); the accessible name stays "Skills". */}
        <span aria-hidden="true">skill</span>
      </button>
      <Menu
        open={open}
        onClose={() => onOpenChange(false)}
        triggerRef={triggerRef}
        side="top"
        width={260}
        caption="SKILLS"
        ariaLabel="The agent's skills"
        data-testid="composer-skill-menu"
        items={skillMenuItems(state, onPick)}
      />
    </span>
  );
}
