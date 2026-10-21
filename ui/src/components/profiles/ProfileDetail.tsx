/**
 * The profile detail pane (artboard 3e): what a profile brings and how it is
 * fenced. Every claim here is a read, not a promise:
 *
 * - LAUNCHER: display name, workers online and the four capability cells,
 *   all from `GET /api/v1/launchers` (contract C5). A cell is `observed`
 *   only with a recorded probe date; `not_tested` is the default.
 * - SANDBOX · NONO: `GET /api/v1/system/sandbox` — backend · version ·
 *   enforcement · verified, per live worker. There is no per-check
 *   timestamp, so no "checked 2h ago": verified is registration data.
 * - ACCOUNT: the secrets whose `allowed_agent_profile_ids` allowlist names
 *   this profile, by slug only. The value is never shown (ADR-0018: there
 *   is no API that returns one).
 * - FROM APM PACKAGE: the pinned triple plus the pin form the old single
 *   page had (moved, not rewritten — every testid travels).
 * - USED BY: "usage tracking not available yet" — a "0" would be a claim
 *   no endpoint can support.
 */
import { useState } from "react";
import { useQueryClient, useQueries } from "@tanstack/react-query";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { Field, Input, Select } from "../ds/Field";
import { Alert } from "../ds/Alert";
import { STATES } from "../ds/states";
import { ProblemBanner, Spinner } from "../Feedback";
import { apiFetch, ApiError, problemOf } from "../../api/client";
import {
  useCreateAgentProfile,
  usePatchAgentProfile,
  useProjects,
  useSystemSandbox,
} from "../../api/queries";
import type { AgentProfileAPMPatch } from "../../api/queries";
import { ENFORCEMENT_COPY } from "../../api/sandbox";
import type { AgentProfile, Project, Secret, SecretList } from "../../api/types";
import {
  capabilityCell,
  duplicateName,
  enforcementWord,
  hasVerifiedWorker,
  launcherEntry,
  sandboxChip,
  type Launcher,
  type SystemSandbox,
} from "../../lib/profiles";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import { Chip } from "./ProfileList";

const CAPABILITY_TONE: Record<string, string> = {
  observed: STATES.done.tagFg,
  not_supported: STATES.failed.tagFg,
  not_tested: "text-muted",
};

/**
 * ACCOUNT is a join the API does not make: secrets live per project, so the
 * profile page asks every project the caller can see for its secret metadata
 * and keeps the rows whose `allowed_agent_profile_ids` allowlist names the
 * profile. Values are not part of the response at all — slug + scope only.
 */
function useProfileAccounts(profileId: string) {
  const projects = useProjects();
  const projectItems = projects.data?.items ?? [];
  const secretQueries = useQueries({
    queries: projectItems.map((project) => ({
      queryKey: ["profiles-account-secrets", project.id] as const,
      queryFn: () => apiFetch<SecretList>(`/api/v1/projects/${project.id}/secrets`),
      retry: false,
    })),
  });
  const grants: { project: Project; secret: Secret }[] = [];
  let someReadFailed = false;
  secretQueries.forEach((query, index) => {
    if (query.isError) someReadFailed = true;
    for (const secret of query.data?.secrets ?? []) {
      if (secret.allowed_agent_profile_ids.includes(profileId)) {
        grants.push({ project: projectItems[index], secret });
      }
    }
  });
  return {
    grants,
    pending: projects.isPending || secretQueries.some((query) => query.isPending),
    error: projects.isError || someReadFailed,
    projectCount: projectItems.length,
  };
}

export interface ProfileDetailProps {
  profile: AgentProfile;
  canWrite: boolean;
  /** `null` = the registry read failed; the launcher block claims nothing. */
  launchers: Launcher[] | null;
  sandbox: SystemSandbox | null | undefined;
  apmOpen: boolean;
  onApmToggle: () => void;
}

export default function ProfileDetail({
  profile,
  canWrite,
  launchers,
  sandbox,
  apmOpen,
  onApmToggle,
}: ProfileDetailProps) {
  const queryClient = useQueryClient();
  const create = useCreateAgentProfile();
  const duplicateBusy = create.isPending;
  const chip = sandboxChip({ launcherId: profile.launcher_id, launchers, sandbox });
  const entry = launcherEntry(launchers, profile.launcher_id);
  const sandboxQuery = useSystemSandbox();
  const accounts = useProfileAccounts(profile.id);
  const [duplicateProblem, setDuplicateProblem] = useState<unknown>(null);

  /**
   * `Duplicate…`: `POST` a copy named `<name> copy` (the route takes name +
   * launcher_id only), then `PATCH` the copy with the APM triple the source
   * pins — a partial triple is `422 apm_pin_incomplete`, so the whole triple
   * travels or it does not travel.
   */
  async function duplicate() {
    setDuplicateProblem(null);
    try {
      const created = await create.mutateAsync({
        name: duplicateName(profile.name),
        launcher_id: profile.launcher_id,
      });
      if (profile.apm_package_ref != null) {
        await apiFetch(`/api/v1/agent-profiles/${created.id}`, {
          method: "PATCH",
          json: {
            apm_package_ref: profile.apm_package_ref,
            apm_target: profile.apm_target,
            apm_lock_digest: profile.apm_lock_digest,
          },
        });
        await queryClient.invalidateQueries({ queryKey: ["agent-profiles"] });
      }
    } catch (error) {
      setDuplicateProblem(error);
    }
  }

  const pinned = profile.apm_package_ref != null;

  return (
    <div className="space-y-4" data-testid={`profile-detail-${profile.id}`}>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold">{profile.name}</h2>
          <span className="font-mono text-[11px] text-muted">launcher: {profile.launcher_id}</span>
          <span
            className="font-mono text-[11px] text-faint"
            data-testid={`agent-permission-${profile.id}`}
            title="not writable: ask is the only mode an unverified launcher may have (ADR-0009)"
          >
            permission: {profile.permission_mode}
          </span>
          <Chip chip={chip} testid={`profile-chip-detail-${profile.id}`} />
        </div>
        <p className="text-[12px] text-muted">
          The agent, the account it signs in with and the sandbox it runs in.
        </p>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              compact
              disabled={duplicateBusy}
              onClick={() => void duplicate()}
              data-testid={`profiles-duplicate-${profile.id}`}
            >
              {duplicateBusy ? "Duplicating…" : "Duplicate…"}
            </Button>
            {duplicateProblem ? (
              <ProblemCode
                error={duplicateProblem}
                testid={`profiles-duplicate-problem-${profile.id}`}
              />
            ) : null}
          </div>
        ) : null}
      </header>

      <Panel
        title="LAUNCHER"
        headingId={`profile-launcher-${profile.id}`}
        headingLevel={3}
        meta={<span className="font-normal">registry evidence only</span>}
      >
        {launchers == null ? (
          <p
            className="p-[10px] font-mono text-[11px] text-muted"
            data-testid="profiles-launcher-unavailable"
          >
            launcher status not available yet — the registry endpoint was not reachable on this
            server
          </p>
        ) : entry == null ? (
          <p className="p-[10px] font-mono text-[11px] text-muted">
            no registry entry for launcher &quot;{profile.launcher_id}&quot; — a profile naming it
            fails closed at launch
          </p>
        ) : (
          <div className="space-y-2 p-[10px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">{entry.display_name}</span>
              <span
                className={`font-mono text-[11px] ${entry.registered ? "text-muted" : "text-st-waiting-tag-fg"}`}
              >
                {entry.registered ? "registered" : "! not registered"}
              </span>
              <span className="font-mono text-[11px] text-muted">
                workers online: {entry.workers_online}
              </span>
            </div>
            <ul className="space-y-1">
              {entry.capabilities.map((capability) => {
                const cell = capabilityCell(capability);
                return (
                  <li
                    key={capability.capability}
                    className="flex flex-wrap gap-2 font-mono text-[11px]"
                    data-testid={`profile-capability-${profile.id}-${capability.capability}`}
                    title={capability.evidence ?? undefined}
                  >
                    <span className="w-[11rem] shrink-0 text-muted">{capability.capability}</span>
                    <span className={CAPABILITY_TONE[capability.result] ?? "text-muted"}>
                      {cell.glyph ? `${cell.glyph} ` : ""}
                      {cell.text}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-[11px] text-muted">
              A cell is &quot;observed&quot; only with a recorded probe; never a pre-filled PASS.
            </p>
          </div>
        )}
      </Panel>

      <Panel
        title="SANDBOX · NONO"
        headingId={`profile-sandbox-${profile.id}`}
        headingLevel={3}
        meta={
          <span className="font-normal">
            {hasVerifiedWorker(sandbox) ? "verified worker online" : "no verified worker"}
          </span>
        }
      >
        <SandboxSection
          sandbox={sandboxQuery.data}
          pending={sandboxQuery.isPending}
          error={sandboxQuery.error}
        />
      </Panel>
      <Panel
        title="ACCOUNT"
        headingId={`profile-account-${profile.id}`}
        headingLevel={3}
        meta={<span className="font-normal">value never shown</span>}
      >
        <AccountSection profileId={profile.id} {...accounts} />
        <p className="border-t border-line px-[10px] pt-2 text-[11px] text-muted">
          A GitHub token here lets the agent push and open PRs (ADR-0045).
        </p>
      </Panel>

      <Panel
        title="FROM APM PACKAGE"
        headingId={`profile-apm-${profile.id}`}
        headingLevel={3}
        meta={
          canWrite ? (
            <Button
              variant="ghost"
              compact
              onClick={onApmToggle}
              data-testid={`agent-apm-edit-${profile.id}`}
            >
              {apmOpen ? "Close" : pinned ? "Edit" : "Attach skill package"}
            </Button>
          ) : undefined
        }
      >
        {pinned ? (
          <div className="space-y-1 p-[10px] font-mono text-[11px]">
            <span className="text-ink-2" data-testid={`agent-apm-ref-${profile.id}`}>
              {profile.apm_package_ref}
            </span>
            <div className="text-muted" data-testid={`agent-apm-target-${profile.id}`}>
              target: {profile.apm_target}
            </div>
            <div className="text-faint" data-testid={`agent-apm-digest-${profile.id}`}>
              {shortDigest(profile.apm_lock_digest)}
            </div>
            <p className="pt-1 font-sans text-[11px] text-muted">
              Contents available after the package is staged — not available yet.
            </p>
          </div>
        ) : (
          <p
            className="p-[10px] font-mono text-[11px] text-faint"
            data-testid={`agent-apm-none-${profile.id}`}
          >
            no skill package
          </p>
        )}
        <p
          className="border-t border-line px-[10px] py-2 text-[11px] text-muted"
          data-testid="agents-disclaimer"
        >
          Skill packages are staged into the agent&apos;s workspace; APM staging is not isolation.
        </p>
        {apmOpen && canWrite ? <ApmPinForm profile={profile} onDone={onApmToggle} /> : null}
      </Panel>

      <Panel title="USED BY" headingId={`profile-usage-${profile.id}`} headingLevel={3}>
        <p
          className="p-[10px] font-mono text-[11px] text-muted"
          data-testid="profiles-usage-unavailable"
        >
          usage tracking not available yet
        </p>
      </Panel>
    </div>
  );
}

/**
 * The secrets granted to this profile, joined client-side (see
 * `useProfileAccounts`). Slugs and scopes only: no API returns a value, and
 * this pane must not invent one.
 */
function AccountSection({
  profileId,
  grants,
  pending,
  error,
  projectCount,
}: {
  profileId: string;
  grants: { project: Project; secret: Secret }[];
  pending: boolean;
  error: boolean;
  projectCount: number;
}) {
  if (pending) return <Spinner label="Checking which secrets name this profile" />;
  if (error) {
    return (
      <p className="p-[10px] font-mono text-[11px] text-muted">
        account secrets could not be read — the project secret lists were not all reachable
      </p>
    );
  }
  if (projectCount === 0) {
    return (
      <p className="p-[10px] font-mono text-[11px] text-muted">
        secrets are project-scoped and you are a member of no projects, so no account is visible
        here
      </p>
    );
  }
  if (grants.length === 0) {
    return (
      <p className="p-[10px] font-mono text-[11px] text-muted">
        no secret in your projects grants this profile (an empty allowlist denies every profile)
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line" data-testid={`profiles-account-${profileId}`}>
      {grants.map(({ project, secret }) => (
        <li
          key={secret.id}
          className="flex flex-wrap items-center gap-2 p-2 font-mono text-[11px]"
          data-testid={`profiles-account-row-${secret.id}`}
        >
          <span className="text-[12px] font-semibold">secret: {secret.slug}</span>
          <span className="text-muted">{secret.scope}-scope</span>
          <span className="text-muted">in {project.name}</span>
          <span className="text-faint">{secret.delivery_mode}</span>
        </li>
      ))}
    </ul>
  );
}

/** The fleet's own words about enforcement, one row per live worker. */
function SandboxSection({
  sandbox,
  pending,
  error,
}: {
  sandbox: SystemSandbox | null | undefined;
  pending: boolean;
  error: unknown;
}) {
  if (pending) return <Spinner label="Loading fleet sandbox status" />;
  if (error) {
    return <ProblemBanner error={error} fallback="The fleet sandbox status could not be read." />;
  }
  if (!sandbox) return null;
  return (
    <div className="space-y-2 p-[10px]">
      <div className="font-mono text-[11px] text-muted">
        pinned nono {sandbox.pinned_backend_version} · policy {shortDigest(sandbox.policy_digest)}
      </div>
      {sandbox.workers.length === 0 ? (
        <p className="font-mono text-[11px] text-muted">
          no live workers report sandbox status yet
        </p>
      ) : (
        sandbox.workers.map((worker) => (
          <div
            key={worker.worker_id}
            className="flex flex-wrap items-center gap-2 font-mono text-[11px]"
            data-testid={`profile-worker-${worker.worker_id}`}
          >
            <span className="w-[6rem] shrink-0 text-muted">{worker.worker_id.slice(0, 8)}</span>
            <span className="text-ink-2">
              {worker.backend}
              {worker.backend_version ? ` ${worker.backend_version}` : ""}
            </span>
            <span className={worker.enforcement === "required" ? "" : "text-st-waiting-tag-fg"}>
              {enforcementWord(worker.enforcement)}
            </span>
            <span className={worker.verified ? "text-st-done-tag-fg" : "text-st-failed-tag-fg"}>
              {worker.verified ? "✓ verified" : "× not verified"}
            </span>
            {worker.enforcement !== "required" ? (
              <span className="text-muted">— {ENFORCEMENT_COPY[worker.enforcement].note}</span>
            ) : null}
          </div>
        ))
      )}
      <p className="text-[11px] text-muted">
        Verified is registration data, not a fresh probe — there is no per-check timestamp to show.
      </p>
    </div>
  );
}

/** Hint only — `api/openapi.yaml` checks this too, but the server's 422 wins. */
export const LOCK_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Example from `docs/compatibility/APM.md` "Git-tag sources (spike 2026-10-16)". */
const REF_EXAMPLE = "mattpocock/skills#v1.3.1";

/**
 * The stable `code` of a profile-write refusal. The prose is not the
 * contract (ADR-0030 §4): the body's `code`, or the `type` URI ending in it.
 */
export function problemCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: unknown } | null;
  if (body && typeof body === "object" && typeof body.code === "string" && body.code !== "") {
    return body.code;
  }
  const tail = error.type.split("/").pop() ?? "";
  return tail && tail !== "about:blank" ? tail : null;
}

/** Inline 422: the problem document's own words plus the code to switch on. */
export function ProblemCode({ error, testid }: { error: unknown; testid: string }) {
  const problem = problemOf(error);
  const code = problemCode(error);
  const text = problem.detail ? `${problem.title}: ${problem.detail}` : problem.title;
  return (
    <Alert state="failed" label="REFUSED" role="alert" testid={testid}>
      <span data-testid={`${testid}-code`} className="mr-1.5 font-mono font-semibold">
        [{code ?? "no-code"}]
      </span>
      {text}
    </Alert>
  );
}

/**
 * The APM triple for one profile, edited as one unit. `Save` sends all three
 * values; `Remove package` sends the cleared triple — there is no route to
 * change one column, because a ref without a digest would stage whatever the
 * ref points at today (`ADR-0030` §4, APM.md probe A5b).
 */
export function ApmPinForm({ profile, onDone }: { profile: AgentProfile; onDone: () => void }) {
  const patch = usePatchAgentProfile(profile.id);
  const [ref, setRef] = useState(profile.apm_package_ref ?? "");
  const [target, setTarget] = useState<"claude" | "codex">(profile.apm_target ?? "claude");
  const [digest, setDigest] = useState(profile.apm_lock_digest ?? "");

  const trimmedRef = ref.trim();
  const trimmedDigest = digest.trim();
  const digestLooksOff = trimmedDigest !== "" && !LOCK_DIGEST_PATTERN.test(trimmedDigest);

  async function save(body: AgentProfileAPMPatch) {
    try {
      await patch.mutateAsync(body);
      onDone();
    } catch {
      // the problem renders below; the server owns validation
    }
  }

  return (
    <form
      className="space-y-3 border-t border-line bg-fill/40 p-[10px]"
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          apm_package_ref: trimmedRef,
          apm_target: target,
          apm_lock_digest: trimmedDigest,
        });
      }}
      data-testid={`agent-apm-form-${profile.id}`}
    >
      <Field
        id={`agents-ref-${profile.id}`}
        label="package ref"
        hint={
          <span className="font-mono text-[11px] text-muted">
            <code>owner/repo#tag</code> — the spike pinned <code>{REF_EXAMPLE}</code>; a subdir
            picks one skill of a multi-skill repo. The <code>#ref</code> is required.
          </span>
        }
        error={
          patch.isError ? problemOf(patch.error).detail || problemOf(patch.error).title : undefined
        }
        className="min-w-[22rem] flex-1"
      >
        <Input
          id={`agents-ref-${profile.id}`}
          value={ref}
          placeholder="owner/repo#tag"
          onChange={(event) => setRef(event.target.value)}
          className="font-mono"
          data-testid={`agents-ref-input-${profile.id}`}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-[10px]">
        <Field id={`agents-target-${profile.id}`} label="target" hint="one lock digest per target">
          <Select
            id={`agents-target-${profile.id}`}
            value={target}
            onChange={(event) => setTarget(event.target.value as "claude" | "codex")}
            className="w-auto"
            data-testid={`agents-target-select-${profile.id}`}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </Select>
        </Field>
        <Field
          id={`agents-digest-${profile.id}`}
          label="lock digest"
          hint={
            digestLooksOff ? (
              <span className="font-mono text-[11px] text-st-failed-tag-fg" role="status">
                looks off — sha256: + 64 hex; the server decides
              </span>
            ) : (
              <span className="font-mono text-[11px] text-muted">
                sha256: + 64 hex from <code>apm lock</code> after a real install
              </span>
            )
          }
          className="min-w-[24rem] flex-[2]"
        >
          <Input
            id={`agents-digest-${profile.id}`}
            value={digest}
            placeholder="sha256:…"
            onChange={(event) => setDigest(event.target.value)}
            className="font-mono"
            data-testid={`agents-digest-input-${profile.id}`}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={patch.isPending}
          data-testid={`agents-apm-save-${profile.id}`}
        >
          {patch.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={patch.isPending}
          onClick={() =>
            void save({ apm_package_ref: null, apm_target: null, apm_lock_digest: null })
          }
          data-testid={`agents-apm-remove-${profile.id}`}
        >
          Remove package
        </Button>
      </div>
      {patch.isError ? (
        <ProblemCode error={patch.error} testid={`agents-apm-problem-${profile.id}`} />
      ) : null}
      <DigestHelp refValue={trimmedRef} targetValue={target} profileId={profile.id} />
    </form>
  );
}

/**
 * "How do I get this?" — the two commands proven in docs/compatibility/APM.md
 * ("Observed generated layout per target" + F2 finding) that compute a
 * package's lock digest inside the worker image. `<ref>` and `<target>` are
 * filled from the form's current values so the block is copy-paste runnable
 * as soon as both fields are set. The copy button uses
 * `navigator.clipboard.writeText` only; jsdom and non-secure-context browsers
 * lack the API, so it is guarded and the button degrades to no-op.
 *
 * A plain warning accompanies the block: the digest is not a label the server
 * can resolve at launch time — it pins the exact content, and a moved tag
 * (a force-push that keeps the name) fails closed, refusing the staging.
 */
export function DigestHelp({
  refValue,
  targetValue,
  profileId,
}: {
  refValue: string;
  targetValue: "claude" | "codex";
  profileId: string;
}) {
  const [copied, setCopied] = useState(false);
  const displayRef = refValue || "owner/repo#tag";
  const displayTarget = targetValue;

  const commandBlock = [
    `printf 'name: x\\nversion: 0.1.0\\ndescription: x\\ndependencies:\\n  apm:\\n    - ${displayRef}\\n' > apm.yml`,
    `docker run --rm -v "$PWD":/w -w /w --entrypoint sh ghcr.io/dbirks/communication-worker:main -c 'PATH=/opt/apm:$PATH apm install --target ${displayTarget} && sha256sum apm.lock.yaml'`,
  ].join("\n");

  function copy() {
    // Guard: jsdom has no clipboard; non-secure-context browsers also lack it.
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(commandBlock).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  }

  return (
    <details className="px-[10px] pb-[6px]" data-testid={`agents-digest-help-${profileId}`}>
      <summary
        className="cursor-pointer font-mono text-[10.5px] text-muted"
        data-testid={`agents-digest-help-toggle-${profileId}`}
      >
        How do I get this?
      </summary>
      <p className="pt-1 text-[11.5px] text-muted">
        The digest pins the exact skills a lockfile describes; a moved tag fails closed and staging
        refuses — it does not silently restage new content.
      </p>
      <div
        className="mt-1 flex items-start gap-1"
        data-testid={`agents-digest-help-block-${profileId}`}
      >
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-[3px] border border-line bg-fill px-2 py-1 font-mono text-[10.5px] whitespace-pre text-ink">
          {commandBlock}
        </pre>
        <Button
          type="button"
          variant="ghost"
          compact
          disabled={!navigator.clipboard}
          onClick={copy}
          data-testid={`agents-digest-help-copy-${profileId}`}
          title={navigator.clipboard ? "Copy commands" : "Clipboard not available in this context"}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </details>
  );
}
