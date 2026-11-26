/**
 * The agent chip that picks a profile (redesign R7) — the profile picker
 * shared by every composer (Home prompt boxes, the chat composer, agent
 * steps on the canvas).
 *
 * The chip prints the selected profile's name (600 ink) with the pinned
 * model in muted text when the profile pins one, and a chevron marking it a
 * picker (review SH-3); nothing selected prints "Choose agent". The popover groups the organization's profiles by harness
 * (claude, codex, antigravity, then the rest alphabetically), 34px rows with
 * a ✓ slot on the selected one, a mono caption, and a "Manage agents…"
 * footer link. An admin who sees a harness whose every account row is
 * signed out gets a "! sign-in" beside that group's header — the header
 * becomes the link to the agents page. Choosing calls `onChange` and closes.
 *
 * Real data only: the list comes from `useAgentProfiles`, the sign-in warning
 * from `useAgentAccounts`, and it is never guessed.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { IconChevronDown, IconRobot } from "@tabler/icons-react";
import { useAgentProfiles, useMe } from "../../api/queries";
import { useAgentAccounts } from "../../api/agentAccounts";
import { routes } from "../../lib/routes";
import { Popover } from "../ds/Menu";
import { PromptChip } from "../ds/PromptBox";
import type { AgentProfile } from "../../api/types";

export interface AgentPickerProps {
  /** Selected agent profile id; null = nothing chosen yet. */
  value: string | null;
  onChange: (profileId: string) => void;
  disabled?: boolean;
  /** Why it is disabled (shown as the chip's title). */
  disabledReason?: string;
  /** Which side the popover opens on; default "top" (it sits in composers). */
  side?: "top" | "bottom";
  testid?: string; // default "agent-picker"
}

export function harnessLabel(launcher: string): string {
  const known: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    antigravity: "Antigravity",
  };
  if (known[launcher]) return known[launcher];
  return launcher.charAt(0).toUpperCase() + launcher.slice(1);
}

/** Group order: the named harnesses first (in this order), then the rest
 * alphabetically. Profiles inside a group are alphabetical. */
export function groupProfiles(profiles: AgentProfile[]): {
  harness: string;
  label: string;
  profiles: AgentProfile[];
}[] {
  const order: Record<string, number> = { claude: 0, codex: 1, antigravity: 2 };
  const byHarness = new Map<string, AgentProfile[]>();
  for (const profile of profiles) {
    const list = byHarness.get(profile.launcher_id) ?? [];
    list.push(profile);
    byHarness.set(profile.launcher_id, list);
  }
  const harnesses = Array.from(byHarness.keys()).sort((a, b) => {
    const rank = (h: string) => order[h] ?? 100;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.localeCompare(b);
  });
  return harnesses.map((harness) => ({
    harness,
    label: harnessLabel(harness),
    profiles: [...byHarness.get(harness)!].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export function AgentPicker({
  value,
  onChange,
  disabled = false,
  disabledReason,
  side = "top",
  testid = "agent-picker",
}: AgentPickerProps) {
  const profiles = useAgentProfiles();
  const me = useMe();
  const isAdmin = me.data?.is_org_admin === true;
  // The accounts read answers 403 for a non-admin — it never fires for one.
  const accounts = useAgentAccounts(isAdmin);
  const [open, setOpen] = useState(false);
  const [resolvedSide, setResolvedSide] = useState<"top" | "bottom">(side);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const list = profiles.data?.items ?? [];
  const selected = list.find((profile) => profile.id === value) ?? null;

  // Arrow-key roving across the rows; Enter/Space activate via the native
  // button click. Esc is the surface's own (it focuses the trigger and calls
  // onClose), so it is deliberately not handled here.
  useEffect(() => {
    if (!open) return;
    const optionsIn = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="agent-picker-popover"] [role="option"]:not([disabled])',
        ),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      const options = optionsIn();
      if (event.key === "Enter" || event.key === " ") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.getAttribute("role") !== "option") return;
        // Cancel the native button activation so the choice is made once.
        event.preventDefault();
        const testId = active.dataset.testid ?? "";
        const id = testId.startsWith("agent-option-") ? testId.slice("agent-option-".length) : null;
        const profile = list.find((p) => p.id === id);
        if (profile) choose(profile);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (options.length === 0) return;
      const active = options.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const target =
        event.key === "ArrowDown"
          ? options[(active + 1 + options.length) % options.length]
          : options[(active - 1 + options.length) % options.length];
      target?.focus();
      target?.scrollIntoView?.({ block: "nearest" });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, list]);

  const choose = (profile: AgentProfile) => {
    onChange(profile.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const signedOut = new Set<string>();
  if (isAdmin) {
    const rows = accounts.data?.items ?? [];
    const byLauncher = new Map<string, typeof rows>();
    for (const account of rows) {
      const list = byLauncher.get(account.launcher) ?? [];
      list.push(account);
      byLauncher.set(account.launcher, list);
    }
    // Only a harness with at least one account row can owe a sign-in.
    for (const [launcher, launcherRows] of byLauncher) {
      if (launcherRows.every((row) => row.state === "signed_out")) signedOut.add(launcher);
    }
  }

  const close = () => setOpen(false);
  const toggleOpen = () => {
    setOpen((prev) => {
      if (prev) return false;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect && side === "top") {
        const maxPop = Math.min(360, Math.max(120, window.innerHeight - 96));
        const roomAbove = rect.top - 12;
        const roomBelow = window.innerHeight - rect.bottom - 12;
        setResolvedSide(roomAbove < maxPop && roomBelow > roomAbove ? "bottom" : "top");
      } else {
        setResolvedSide(side);
      }
      return true;
    });
  };

  return (
    <>
      <span className="relative inline-flex max-w-full">
        <PromptChip
          buttonRef={triggerRef}
          icon={<IconRobot size={14} stroke={1.5} aria-hidden="true" />}
          testid={testid}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          title={disabled ? disabledReason : "Choose the agent profile"}
          onClick={toggleOpen}
        >
          <span className="inline-flex min-w-0 items-center gap-[4px]">
            <span className="truncate font-semibold text-ink">
              {selected ? selected.name : "Choose agent"}
            </span>
            {selected?.model ? <span className="text-muted">· {selected.model}</span> : null}
            <IconChevronDown
              size={12}
              stroke={1.5}
              className="shrink-0 text-muted"
              aria-hidden="true"
            />
          </span>
        </PromptChip>
        <Popover
          open={open && !disabled}
          onClose={close}
          triggerRef={triggerRef}
          side={resolvedSide}
          width={280}
          className="flex max-h-[min(360px,calc(100vh-96px))] flex-col rounded-[12px]! shadow-[var(--shadow-pop)]! [&>div:first-of-type]:shrink-0"
          caption="RUNS ON"
          data-testid="agent-picker-popover"
          ariaLabel="Agent"
        >
          {profiles.isPending ? (
            <p className="px-2 py-[10px] text-[12px] text-muted">Loading agents…</p>
          ) : profiles.isError ? (
            <p className="px-2 py-[10px] text-[12px] text-muted">Couldn't load agents.</p>
          ) : list.length === 0 ? (
            <p className="px-2 py-[10px] text-[12px] text-muted">No agent profiles yet.</p>
          ) : (
            <div role="listbox" aria-label="Agent" className="min-h-0 flex-1 overflow-y-auto">
              {groupProfiles(list).map((group) => {
                const needsSignIn = signedOut.has(group.harness);
                const header = (
                  <span className="flex items-center justify-between px-3 pb-[3px] pt-[7px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                    <span>{group.label}</span>
                    {needsSignIn ? (
                      <span className="text-[12px] text-st-waiting-tag-fg">! sign-in</span>
                    ) : null}
                  </span>
                );
                return (
                  <div key={group.harness} data-testid={`agent-group-${group.harness}`}>
                    {needsSignIn ? (
                      <Link
                        to={routes.manage("agents")}
                        className="block focus-visible:outline-2 focus-visible:outline-accent"
                        data-testid={`agent-group-link-${group.harness}`}
                      >
                        {header}
                      </Link>
                    ) : (
                      header
                    )}
                    {group.profiles.map((profile) => {
                      const checked = profile.id === value;
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          role="option"
                          aria-selected={checked}
                          data-testid={`agent-option-${profile.id}`}
                          onClick={() => choose(profile)}
                          className="flex h-[34px] w-full items-center gap-[4px] px-3 text-left focus-visible:bg-accent-wash focus-visible:outline-none hover:bg-accent-wash"
                        >
                          <span
                            aria-hidden="true"
                            className="w-[14px] shrink-0 font-mono text-accent"
                          >
                            {checked ? "✓" : ""}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                            {profile.name}
                          </span>
                          {profile.model ? (
                            <span className="shrink-0 font-mono text-[11px] text-muted">
                              {profile.model}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          <div className="shrink-0 border-t border-line-soft pt-[6px]">
            <Link
              to={routes.manage("agents")}
              className="block px-3 py-[6px] text-[12.5px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="agent-picker-manage"
            >
              Manage agents…
            </Link>
          </div>
        </Popover>
      </span>
    </>
  );
}
