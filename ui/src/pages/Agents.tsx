/**
 * Agent profiles (`/profiles`, `/profiles/:id`): the organization's launch
 * descriptors (2e list · 3e detail).
 *
 * Honesty rules (gaps/profiles.md §5):
 * - A row is `GET /api/v1/agent-profiles` and nothing else. `permission_mode`
 *   is rendered, never editable (ADR-0009).
 * - The sandbox chip on a row is a derived claim: green only when a live
 *   worker reports verified required-enforcement AND the launcher's
 *   `nono_required` cell is `observed` (lib/profiles.ts). When the launcher
 *   registry read fails, the chip says it knows nothing.
 * - `GET /api/v1/launchers` (C5, ADR-0051) may 404 on an image that predates
 *   it: the detail then renders "launcher status not available yet" — no
 *   error banner for a read-only status, no guessed evidence.
 * - Write controls appear only for the organization's library role
 *   (`me.is_org_admin`) — the server's own predicate.
 *
 * The old single-page testids travel: `agents-page`, `agent-list`,
 * `agent-row-*`, `agents-new-form` and the APM pin form's ids are all still
 * defined (here, in `ProfileList` and `ProfileDetail`).
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "../components/ds/Button";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { useAgentProfiles, useMe, useSystemSandbox } from "../api/queries";
import { useLaunchers } from "../api/launchers";
import { routes } from "../lib/routes";
import ProfileList from "../components/profiles/ProfileList";
import ProfileDetail from "../components/profiles/ProfileDetail";
import NewProfileDialog from "../components/profiles/NewProfileDialog";

export default function AgentsPage() {
  const { id: selectedParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const me = useMe();
  const profiles = useAgentProfiles();
  const launchers = useLaunchers();
  const sandbox = useSystemSandbox();
  const canWrite = me.data?.is_org_admin === true;
  const [apmOpenId, setApmOpenId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const items = profiles.data?.items ?? [];
  // `:id` wins when it names a known profile; otherwise the first row.
  const selected = items.find((profile) => profile.id === selectedParam) ?? items[0] ?? null;
  // `null` (not `undefined`) is the "not available yet" signal: it covers
  // both the 404 the hook swallows and any other registry read failure.
  const launcherCards = launchers.data?.launchers ?? null;

  return (
    <div className="space-y-4" data-testid="agents-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-[19px] font-bold" id="agents-heading">
            Agent profiles
          </h1>
          <p className="text-[12.5px] text-muted">
            A profile is an agent, the account it signs in with, its skill package and the sandbox
            it runs in.
          </p>
        </div>
        {canWrite ? (
          <Button onClick={() => setDialogOpen(true)} data-testid="agents-new-open">
            New profile
          </Button>
        ) : null}
      </header>
      {me.isError ? (
        <ProblemBanner error={me.error} fallback="Your identity could not be read." />
      ) : null}
      {profiles.isPending && !profiles.data ? <Spinner label="Loading agent profiles" /> : null}
      {profiles.isError ? (
        <ProblemBanner
          error={profiles.error}
          fallback="The agent profiles could not be read."
          testid="agents-load-error"
        />
      ) : null}
      {profiles.data ? (
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="w-full shrink-0 md:w-[260px]">
            <ProfileList
              profiles={items}
              selectedId={selected?.id ?? null}
              canWrite={canWrite}
              launchers={launcherCards}
              sandbox={sandbox.data ?? null}
              onOpen={(profile) => navigate(routes.profile(profile.id))}
              onEdit={(profile) => {
                setApmOpenId(profile.id);
                navigate(routes.profile(profile.id));
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            {selected ? (
              <ProfileDetail
                profile={selected}
                canWrite={canWrite}
                launchers={launcherCards}
                sandbox={sandbox.data ?? null}
                apmOpen={apmOpenId === selected.id}
                onApmToggle={() => setApmOpenId(apmOpenId === selected.id ? null : selected.id)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <NewProfileDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(profile) => {
          setDialogOpen(false);
          navigate(routes.profile(profile.id));
        }}
      />
    </div>
  );
}
