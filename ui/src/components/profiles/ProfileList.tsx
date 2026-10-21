/**
 * The 260px profile list of the `/profiles` page (artboard 2e).
 *
 * One row per `GET /api/v1/agent-profiles` row: the name, `launcher: <id>`
 * and the sandbox chip derived in `lib/profiles.ts`. The chip is glyph +
 * text, never colour alone. Every row id from the old single-page layout is
 * kept: this component is a move of `ProfileRow`, not a replacement.
 */
import { STATES } from "../ds/states";
import {
  type SandboxChip,
  sandboxChip,
  type Launcher,
  type SystemSandbox,
} from "../../lib/profiles";
import { Button } from "../ds/Button";
import type { AgentProfile } from "../../api/types";

const CHIP_CLASS: Record<SandboxChip["state"], string> = {
  verified: `${STATES.done.tagBg} ${STATES.done.tagFg}`,
  "not-registered": `${STATES.waiting.tagBg} ${STATES.waiting.tagFg}`,
  "not-verified": `${STATES.waiting.tagBg} ${STATES.waiting.tagFg}`,
  unavailable: "text-muted",
};

/** The chip as rendered on a row: glyph and text always travel together. */
export function Chip({ chip, testid }: { chip: SandboxChip; testid?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-[3px] px-1.5 font-mono text-[10px] leading-[1.5] ${CHIP_CLASS[chip.state]}`}
      title={chip.title}
      data-testid={testid}
      role="status"
    >
      <span aria-hidden="true">{chip.glyph}</span>
      <span> {chip.text}</span>
    </span>
  );
}

export interface ProfileListProps {
  profiles: AgentProfile[];
  selectedId: string | null;
  canWrite: boolean;
  /** `null` = the registry read failed; the chip then claims nothing. */
  launchers: Launcher[] | null;
  sandbox: SystemSandbox | null | undefined;
  onOpen: (profile: AgentProfile) => void;
  onEdit: (profile: AgentProfile) => void;
}

export default function ProfileList({
  profiles,
  selectedId,
  canWrite,
  launchers,
  sandbox,
  onOpen,
  onEdit,
}: ProfileListProps) {
  function pick(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (event.currentTarget.dataset.profileId) {
      const profile = profiles.find((p) => p.id === event.currentTarget.dataset.profileId);
      if (profile) onOpen(profile);
    }
  }
  return (
    <div data-testid="profiles-list" className="rounded-[3px] border border-line-strong bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-[10px] py-1 font-mono text-[10px] font-semibold tracking-[.04em]">
        AGENT PROFILES
        <span className="font-normal text-faint">
          {profiles.length} · {canWrite ? "the library role may write" : "read-only for your role"}
        </span>
      </div>
      {profiles.length === 0 ? (
        <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="agents-empty">
          no agent profiles in this organization
        </p>
      ) : null}
      <ul className="divide-y divide-line" data-testid="agent-list">
        {profiles.map((profile) => {
          const chip = sandboxChip({
            launcherId: profile.launcher_id,
            launchers,
            sandbox,
          });
          const selected = profile.id === selectedId;
          return (
            <li key={profile.id} data-testid={`agent-item-${profile.id}`}>
              <div
                role="button"
                tabIndex={0}
                aria-label={`${profile.name} — open profile`}
                aria-current={selected || undefined}
                data-profile-id={profile.id}
                data-testid={`agent-row-${profile.id}`}
                onClick={() => onOpen(profile)}
                onKeyDown={pick}
                className={`flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 p-2 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  selected ? "bg-fill" : ""
                }`}
              >
                <span
                  className="min-w-[6rem] flex-1 truncate text-[13px] font-semibold"
                  data-testid={`agent-name-${profile.id}`}
                  title={profile.name}
                >
                  {profile.name}
                </span>
                <span
                  className="font-mono text-[11px] text-muted"
                  data-testid={`agent-launcher-${profile.id}`}
                >
                  launcher: {profile.launcher_id}
                </span>
                <Chip chip={chip} testid={`profile-chip-${profile.id}`} />
                {canWrite ? (
                  <Button
                    variant="secondary"
                    compact
                    onClick={(event) => {
                      event.stopPropagation();
                      onEdit(profile);
                    }}
                    data-testid={`agent-edit-${profile.id}`}
                  >
                    Edit
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
