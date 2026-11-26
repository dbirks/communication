/**
 * The profiles table of Manage → Agents & models (artboard 2e, re-homed as
 * the table of a section): Name / Harness / Model / Skills / Used by.
 *
 * Name links to the profile's sheet; the harness cell prints the launcher
 * label plus the sandbox chip text the old ProfileList shows (the claim,
 * never a guess); the model cell prints the pinned display model or "default";
 * Skills is the count of APM skills the profile resolves, or the attachment
 * count; Used by is "—" because no page read gives a per-profile usage count
 * without a fan-out of requests, and none is added here.
 */
import { Link } from "react-router";
import { harnessLabel } from "../../../components/shell/AgentPicker";
import type { AgentProfile } from "../../../api/types";
import { sandboxChip, type Launcher, type SystemSandbox } from "../../../lib/profiles";
import { Chip } from "../../../components/profiles/ProfileList";
import { routes } from "../../../lib/routes";

export interface ProfilesTableProps {
  profiles: AgentProfile[];
  /** `null` = the registry read failed; the chip then claims nothing. */
  launchers: Launcher[] | null;
  sandbox: SystemSandbox | null | undefined;
}

const HEADER_CELL =
  "px-3 pl-0 pr-3 pb-2 border-b border-line font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted whitespace-nowrap";
const BODY_CELL = "px-3 pl-0 pr-3 py-[11px] border-b border-line-soft text-[13.5px] align-middle";

export default function ProfilesTable({ profiles, launchers, sandbox }: ProfilesTableProps) {
  if (profiles.length === 0) {
    return (
      <div data-testid="profiles-table">
        <p className="text-[12.5px] text-muted" data-testid="agents-empty">
          No agent profiles yet.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="profiles-table">
      <table className="w-full border-collapse" data-testid="agent-list">
        <thead>
          <tr>
            <th scope="col" className={`${HEADER_CELL} text-left`}>
              Name
            </th>
            <th scope="col" className={`${HEADER_CELL} text-left`}>
              Harness
            </th>
            <th scope="col" className={`${HEADER_CELL} text-left`}>
              Model
            </th>
            <th scope="col" className={`${HEADER_CELL} text-left`}>
              Skills
            </th>
            <th scope="col" className={`${HEADER_CELL} text-left`}>
              Used by
            </th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const chip = sandboxChip({
              launcherId: profile.launcher_id,
              launchers,
              sandbox,
            });
            const skillsCount = profile.apm_contents?.skills?.length ?? 0;
            const collectionsCount = profile.apm_collections?.length ?? 0;
            return (
              <tr key={profile.id} className="align-middle" data-testid={`agent-row-${profile.id}`}>
                <td className={BODY_CELL}>
                  <Link
                    to={routes.manage("agents", profile.id)}
                    data-testid={`agent-name-${profile.id}`}
                    className="font-semibold text-ink underline underline-offset-2 hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    {profile.name}
                  </Link>
                </td>
                <td className={BODY_CELL}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{harnessLabel(profile.launcher_id)}</span>
                    <Chip chip={chip} testid={`profile-chip-${profile.id}`} />
                  </span>
                </td>
                <td className={`${BODY_CELL} font-mono text-[12px]`}>
                  {profile.model ? profile.model : <span className="text-muted">default</span>}
                </td>
                <td className={`${BODY_CELL} whitespace-nowrap`}>
                  {skillsCount > 0 ? (
                    `${skillsCount} skill${skillsCount === 1 ? "" : "s"}`
                  ) : collectionsCount > 0 ? (
                    `${collectionsCount} collection${collectionsCount === 1 ? "" : "s"}`
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className={`${BODY_CELL} text-faint`}>—</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
