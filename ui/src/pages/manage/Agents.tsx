/**
 * Manage → Agents & models (redesign R7): which agents can run, on whose
 * account, and how each one is set up.
 *
 * Structure (docs/design/redesign/CONTRACT.md, "Agents & models"): an
 * accounts strip on top (one row per harness), a tab row (Profiles · Skills
 * · Step templates · Models · Assistant), and the profiles table below it.
 * A profile link or a row opens a 560px right-hand sheet (`/manage/agents/:itemId`)
 * that hosts the existing ProfileDetail body.
 *
 * The table's data, the APM pin form and the login dialog are the old
 * pages' components — nothing here reimplements them; the chrome is new.
 */
import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { useAgentProfiles, useMe, useSystemSandbox } from "../../api/queries";
import { useLaunchers } from "../../api/launchers";
import { useSystemOverview } from "../../api/overview";
import { ModelsPanel } from "../../components/ops/ModelsPanel";
import { routes } from "../../lib/routes";
import AccountsStrip from "./agents/AccountsStrip";
import AgentsTabs, { tabFromSearchParam } from "./agents/AgentsTabs";
import ProfilesTable from "./agents/ProfilesTable";
import ProfileSheet from "./agents/ProfileSheet";
import NewProfileDialog from "../../components/profiles/NewProfileDialog";
import Collections from "./agents/Collections";
import Steps from "./agents/Steps";
import AssistantSettings from "../settings/Assistant";

export default function Agents() {
  const navigate = useNavigate();
  const { itemId } = useParams<{ itemId: string }>();
  const [searchParams] = useSearchParams();
  const tab = tabFromSearchParam(searchParams.get("tab"));

  const me = useMe();
  const profiles = useAgentProfiles();
  const launchers = useLaunchers();
  const sandbox = useSystemSandbox();
  const canWrite = me.data?.is_org_admin === true;

  const [apmOpenId, setApmOpenId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const items = profiles.data?.items ?? [];
  // `:itemId` wins; "not available yet" for the launcher registry is null.
  const launcherCards = launchers.data?.launchers ?? null;
  const selected = itemId ? (items.find((profile) => profile.id === itemId) ?? null) : null;

  const closeSheet = () => {
    // The close keeps the query string (the tab), drops the item id.
    navigate(tab ? `${routes.manage("agents")}?tab=${tab}` : routes.manage("agents"));
  };

  return (
    <div data-testid="manage-agents" className="bg-surface">
      <div className="mx-auto max-w-[1120px] px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-bold leading-[1.25]">Agents &amp; models</h2>
            <p className="mt-1 text-[13.5px] text-muted">
              Which agents can run, on whose account, and how each one is set up.
            </p>
          </div>
          {canWrite ? (
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              data-testid="agents-new-open"
              className="h-[34px] rounded-[8px] bg-accent px-[14px] text-[13px] font-semibold text-white hover:bg-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              New agent
            </button>
          ) : null}
        </header>

        <div className="mt-5">
          <AccountsStrip />
        </div>

        <AgentsTabs current={tab} />

        <div className="pt-5">
          {tab === "profiles" ? (
            <>
              {me.isError ? (
                <ProblemBanner
                  error={me.error}
                  fallback="Your identity could not be read."
                  testid="agents-me-error"
                />
              ) : null}
              {profiles.isPending && !profiles.data ? (
                <Spinner label="Loading agent profiles" />
              ) : null}
              {profiles.isError ? (
                <ProblemBanner
                  error={profiles.error}
                  fallback="The agent profiles could not be read."
                  testid="agents-load-error"
                />
              ) : null}
              {profiles.data ? (
                <ProfilesTable
                  profiles={items}
                  launchers={launcherCards}
                  sandbox={sandbox.data ?? null}
                />
              ) : null}
            </>
          ) : tab === "skills" ? (
            <Collections />
          ) : tab === "steps" ? (
            <Steps />
          ) : tab === "models" ? (
            <ModelsTab isAdmin={canWrite} />
          ) : (
            <AssistantSettings />
          )}
        </div>
      </div>

      {itemId ? (
        <ProfileSheet
          profile={selected}
          loading={profiles.isPending && !profiles.data}
          loadError={profiles.error}
          onRetry={() => void profiles.refetch()}
          canWrite={canWrite}
          launchers={launcherCards}
          sandbox={sandbox.data ?? null}
          apmOpen={selected !== null && apmOpenId === selected.id}
          onApmToggle={() =>
            setApmOpenId(apmOpenId === selected?.id ? null : (selected?.id ?? null))
          }
          onClose={closeSheet}
        />
      ) : null}

      <NewProfileDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(profile) => {
          setDialogOpen(false);
          navigate(`${routes.manage("agents", profile.id)}?tab=profiles`);
        }}
      />
    </div>
  );
}

/** The MODELS tab: the existing ModelsPanel, fed exactly as OperationsBody
 * feeds it. The overview read lives in this wrapper so it only fires on the
 * Models tab. */
function ModelsTab({ isAdmin }: { isAdmin: boolean }) {
  const overview = useSystemOverview();
  return (
    <ModelsPanel
      overview={overview.data ?? null}
      pending={overview.isPending}
      error={overview.error}
      onRetry={() => void overview.refetch()}
      isAdmin={isAdmin}
    />
  );
}
