/**
 * New profile dialog (handoff artboards 4c → 5b, contract C6).
 *
 * What it does, honestly:
 * - AGENT: five cards — the four core launchers (Claude Code, Codex, Pi,
 *   Antigravity) plus "Other ACP agent" (any *other* registered launcher id
 *   from the C5 registry). The readiness line comes only from recorded
 *   evidence (C5 capabilities + a verified worker on `GET
 *   /api/v1/system/sandbox`, via lib/profiles.ts): a green ✓ claim needs
 *   evidence, and an unregistered launcher is a disabled card with the
 *   reason — a profile naming it would only fail at launch (ADR-0019 D6).
 * - ACCOUNT: a select over the caller's project secrets (slug only — the
 *   value is never shown). After the profile is created the dialog PATCHes
 *   the chosen secret's `allowed_agent_profile_ids` to grant it.
 * - NAME: suggested from agent + step, kept unique against the existing
 *   list, always editable.
 * - SKILLS: the optional APM triple (ref + target + digest), all-or-nothing
 *   — the existing PATCH semantics; `Lock it` is disabled because
 *   server-side digest computation does not exist yet (planned ADR).
 * - Defaults bar: only claims that hold for profiles today —
 *   `permission_mode` is always `ask` (ADR-0009) and the sandbox wording
 *   reflects what the live workers actually report (ADR-0035: the egress
 *   allowlist is worker-level, so nothing is claimed about it here).
 *
 * The dialog owns the write path. On success (the POST — and the APM /
 * account follow-ups when given) it hands the created row to the caller
 * through `onCreated` and the CALLER closes it (the Studio inspector
 * selects the profile, `/profiles` navigates to its detail). On any error
 * the dialog stays open with the API's message.
 *
 * The old inline form's testids (`agents-new-form`, `agents-new-name-input`,
 * `agents-new-launcher-select`, `agents-new-submit`, `agents-new-problem`)
 * travel into this dialog so the existing suites keep finding them.
 */
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useAgentProfiles,
  useProjects,
  useSecrets,
  useSystemSandbox,
} from "../../api/queries";
import { apiFetch } from "../../api/client";
import { useLaunchers } from "../../api/launchers";
import { ENFORCEMENT_COPY } from "../../api/sandbox";
import type { AgentProfile, SystemSandbox } from "../../api/types";
import { hasVerifiedWorker, launcherEntry, sandboxChip, type Launcher } from "../../lib/profiles";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { Field, Input, Select } from "../ds/Field";
import { FormError, Spinner } from "../Feedback";

export interface NewProfileDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (profile: { id: string; name: string; launcher_id: string }) => void;
  forStep?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface CoreAgent {
  id: string;
  display: string;
  tile: string;
}

const CORE_AGENTS: CoreAgent[] = [
  { id: "claude", display: "Claude Code", tile: "CC" },
  { id: "codex", display: "Codex", tile: "CX" },
  { id: "pi", display: "Pi", tile: "PI" },
  { id: "antigravity", display: "Antigravity", tile: "AG" },
];

const CORE_IDS = new Set(CORE_AGENTS.map((agent) => agent.id));

/** The built-in registry (`launchers.go`) always carries exactly these. */
const BUILTIN_IDS = new Set(["claude", "codex"]);

const OTHER = "other";

export default function NewProfileDialog(props: NewProfileDialogProps) {
  // Rendered only while open, so mounting is the opener holding focus and the
  // layout effect can capture it before moving focus into the dialog.
  if (!props.open) return null;
  return <DialogBody onClose={props.onClose} onCreated={props.onCreated} forStep={props.forStep} />;
}

// C6 is a default export; a named re-export is provided for callers that
// import by name.
export { NewProfileDialog };

/**
 * One card's readiness line. Evidence-only (gaps/profiles.md §5):
 * `✓` needs a worker reporting verified required-enforcement AND a recorded
 * nono probe; anything less is amber `!` (or muted `·` when the registry
 * read itself failed — then the app claims nothing).
 */
function readiness(
  launcherId: string,
  launchers: Launcher[] | null,
  sandbox: SystemSandbox | null | undefined,
): { text: string; tone: "ok" | "warn" | "muted"; registered: boolean } {
  if (launchers == null) {
    return {
      text: "· status not available yet",
      tone: "muted",
      // The built-ins are code, not a registry row: they stay selectable.
      registered: BUILTIN_IDS.has(launcherId),
    };
  }
  const entry = launcherEntry(launchers, launcherId);
  if (entry == null || !entry.registered) {
    return { text: "! not registered", tone: "warn", registered: false };
  }
  const chip = sandboxChip({ launcherId, launchers, sandbox });
  if (chip.state === "verified")
    return { text: "✓ sandbox verified", tone: "ok", registered: true };
  if (chip.state === "unavailable")
    return { text: "· status not available yet", tone: "muted", registered: true };
  return { text: "! not tested yet", tone: "warn", registered: true };
}

/** What the live workers actually report — never a promise. */
function sandboxWord(sandbox: SystemSandbox | null | undefined): string {
  const workers = sandbox?.workers ?? [];
  if (workers.length === 0) return "not reported yet";
  if (hasVerifiedWorker(sandbox)) return "required · verified";
  if (workers.some((worker) => worker.enforcement === "required"))
    return "required · not verified yet";
  return ENFORCEMENT_COPY[workers[0].enforcement]?.word ?? workers[0].enforcement;
}

/** `<Agent> · <forStep>`, or `<Agent> · <n>` when there is no step. */
export function suggestProfileName(
  agentDisplay: string,
  forStep: string | undefined,
  taken: ReadonlySet<string>,
): string {
  if (forStep) {
    let candidate = `${agentDisplay} · ${forStep}`;
    let n = 2;
    while (taken.has(candidate)) candidate = `${agentDisplay} · ${forStep} · ${n++}`;
    return candidate;
  }
  for (let n = 2; n <= 99; n++) {
    const candidate = `${agentDisplay} · ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${agentDisplay} · copy`;
}

function DialogBody({
  onClose,
  onCreated,
  forStep,
}: {
  onClose: () => void;
  onCreated: (profile: { id: string; name: string; launcher_id: string }) => void;
  forStep?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const queryClient = useQueryClient();

  const profiles = useAgentProfiles();
  const launchers = useLaunchers();
  const sandbox = useSystemSandbox();
  const projects = useProjects();
  const launcherCards = launchers.data?.launchers ?? null;

  const [agentId, setAgentId] = useState("claude");
  const [otherId, setOtherId] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [projectChoice, setProjectChoice] = useState("");
  const [secretId, setSecretId] = useState("");
  const [apmRef, setApmRef] = useState("");
  const [apmTarget, setApmTarget] = useState("");
  const [apmDigest, setApmDigest] = useState("");
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [following, setFollowing] = useState(false);

  const projectItems = projects.data?.items ?? [];
  const projectId = projectChoice || (projectItems.length > 0 ? projectItems[0].id : "");
  const secrets = useSecrets(projectId);

  // Other ACP agent = any registered C5 launcher the four cards don't name.
  const otherOptions = useMemo(
    () => (launcherCards ?? []).filter((entry) => entry.registered && !CORE_IDS.has(entry.id)),
    [launcherCards],
  );
  const effectiveOther = otherOptions.some((entry) => entry.id === otherId)
    ? otherId
    : (otherOptions[0]?.id ?? "");

  const selectedLauncherId = agentId === OTHER ? effectiveOther : agentId;
  const selectedAgent = CORE_AGENTS.find((agent) => agent.id === agentId) ?? CORE_AGENTS[0];

  const takenNames = useMemo(
    () => new Set((profiles.data?.items ?? []).map((profile) => profile.name)),
    [profiles.data],
  );
  const suggestedName = suggestProfileName(selectedAgent.display, forStep, takenNames);
  const nameValue = nameTouched ? name : suggestedName;

  const apmFields = [apmRef.trim(), apmTarget, apmDigest.trim()];
  const apmFilled = apmFields.filter((value) => value !== "").length;
  const apmPartial = apmFilled > 0 && apmFilled < 3;

  // Focus trap + escape, the accessible-modal contract (see
  // NewConversationDialog for the same pattern).
  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const secret = (secrets.data?.secrets ?? []).find((entry) => entry.id === secretId) ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const launcherId = selectedLauncherId;
    const trimmedName = nameValue.trim();
    if (trimmedName === "" || launcherId === "") return;
    setSubmitError(null);
    // C6: the dialog owns the write path — POST the profile, then, when the
    // optional fields are complete, PATCH the APM triple (all-or-nothing) and
    // grant the chosen secret. Direct calls: the created id is only known
    // after the POST, which the fixed-arg mutation hooks cannot follow.
    let created: AgentProfile;
    try {
      created = await apiFetch<AgentProfile>("/api/v1/agent-profiles", {
        method: "POST",
        json: { name: trimmedName, launcher_id: launcherId },
      });
    } catch (error) {
      // The create itself failed (409 duplicate name etc.) — it renders
      // inline below; the dialog stays open.
      setSubmitError(error);
      return;
    }
    setFollowing(true);
    try {
      if (apmFilled === 3) {
        await apiFetch<AgentProfile>(`/api/v1/agent-profiles/${created.id}`, {
          method: "PATCH",
          json: {
            apm_package_ref: apmRef.trim(),
            apm_target: apmTarget as "claude" | "codex",
            apm_lock_digest: apmDigest.trim(),
          },
        });
      }
      if (secret && projectId !== "") {
        const ids = new Set(secret.allowed_agent_profile_ids ?? []);
        ids.add(created.id);
        await apiFetch(`/api/v1/projects/${projectId}/secrets/${secret.id}`, {
          method: "PUT",
          json: {
            purpose: secret.purpose,
            allowed_agent_profile_ids: [...ids],
            audit_policy: secret.audit_policy,
          },
        });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentProfiles });
      if (projectId !== "") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.secrets(projectId) });
      }
      // Success: hand the created row to the caller (contract C6); the
      // caller closes the dialog — the Studio inspector selects the profile,
      // `/profiles` navigates to its detail. No confirmation state: that
      // extra "Done" click broke the Studio flow.
      onCreated({ id: created.id, name: created.name, launcher_id: created.launcher_id });
    } catch (error) {
      // The profile exists; the pin or the account grant is what failed.
      // Keep the dialog open with the API's message so the problem stays
      // visible.
      setSubmitError(error);
    } finally {
      setFollowing(false);
    }
  }

  const busy = following;
  const canSubmit = !busy && nameValue.trim() !== "" && selectedLauncherId !== "" && !apmPartial;

  const toneClass = {
    ok: "text-st-done-tag-fg",
    warn: "text-st-waiting-tag-fg",
    muted: "text-muted",
  } as const;

  const card = (agent: CoreAgent) => {
    const info = readiness(agent.id, launcherCards, sandbox.data ?? null);
    const selected = agentId === agent.id;
    return (
      <label
        key={agent.id}
        data-testid={`new-profile-card-${agent.id}`}
        title={info.text}
        data-reason={
          !info.registered
            ? "no launcher entry for this id — creating a profile for it would fail at launch"
            : undefined
        }
        className={`flex items-start gap-[8px] rounded-[3px] border p-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
          info.registered ? "cursor-pointer" : "cursor-not-allowed opacity-70"
        } ${selected ? "border-ink" : "border-line-strong"}`}
      >
        <input
          type="radio"
          name="new-profile-agent"
          value={agent.id}
          checked={selected}
          disabled={!info.registered}
          onChange={() => setAgentId(agent.id)}
          className="mt-[7px] h-3.5 w-3.5 shrink-0"
        />
        <span
          aria-hidden="true"
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[3px] border border-line-strong bg-fill font-mono text-[11px] font-bold"
        >
          {agent.tile}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-ink">{agent.display}</span>
          <span className="block font-mono text-[10.5px] text-muted">launcher: {agent.id}</span>
          <span className={`block font-mono text-[11px] ${toneClass[info.tone]}`}>{info.text}</span>
        </span>
      </label>
    );
  };

  const otherInfo =
    launcherCards == null
      ? { text: "· status not available yet", tone: "muted" as const, registered: false }
      : effectiveOther !== ""
        ? readiness(effectiveOther, launcherCards, sandbox.data ?? null)
        : { text: "! no other launcher registered", tone: "warn" as const, registered: false };
  const otherSelected = agentId === OTHER;

  const sectionLabel = (children: string, testid: string) => (
    <span
      data-testid={testid}
      className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
    >
      {children}
    </span>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-profile-dialog-title"
        data-testid="new-profile-dialog"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[720px] overflow-y-auto rounded-[3px] border border-line-strong bg-surface p-4 shadow-[0_8px_24px_rgba(30,29,26,0.18)]"
      >
        <header className="space-y-0.5">
          <h2 id="new-profile-dialog-title" className="text-[15px] font-bold text-ink">
            New agent profile
          </h2>
          {forStep ? (
            <p data-testid="new-profile-step" className="text-[12.5px] text-muted">
              for step <span className="font-mono">{forStep}</span>
            </p>
          ) : null}
        </header>

        <form
          onSubmit={(event) => void submit(event)}
          data-testid="agents-new-form"
          className="mt-3 space-y-4"
        >
          {/* AGENT — five cards, readiness from recorded evidence only. */}
          <section className="space-y-1.5">
            {sectionLabel("Agent", "new-profile-agent-label")}
            <div role="radiogroup" aria-label="Agent" className="grid gap-2 sm:grid-cols-2">
              {CORE_AGENTS.map(card)}
              <label
                data-testid="new-profile-card-other"
                className={`flex items-start gap-[8px] rounded-[3px] border p-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent sm:col-span-2 ${
                  otherInfo.registered ? "cursor-pointer" : "cursor-not-allowed opacity-70"
                } ${otherSelected ? "border-ink" : "border-line-strong"}`}
              >
                <input
                  type="radio"
                  name="new-profile-agent"
                  value={OTHER}
                  checked={otherSelected}
                  disabled={!otherInfo.registered}
                  onChange={() => setAgentId(OTHER)}
                  className="mt-[7px] h-3.5 w-3.5 shrink-0"
                />
                <span
                  aria-hidden="true"
                  className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[3px] border border-line-strong bg-fill font-mono text-[15px] font-bold"
                >
                  +
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-ink">Other ACP agent</span>
                  <span className="block font-mono text-[10.5px] text-muted">
                    any registered launcher
                  </span>
                  <span className={`block font-mono text-[11px] ${toneClass[otherInfo.tone]}`}>
                    {otherInfo.text}
                  </span>
                </span>
                <Select
                  id="agents-new-launcher"
                  aria-label="Other launcher"
                  value={effectiveOther}
                  onChange={(event) => setOtherId(event.target.value)}
                  disabled={!otherInfo.registered}
                  className="w-auto self-center font-mono text-[11.5px]"
                  data-testid="agents-new-launcher-select"
                >
                  {otherOptions.length === 0 ? (
                    <option value="">none</option>
                  ) : (
                    otherOptions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id}
                      </option>
                    ))
                  )}
                </Select>
              </label>
            </div>
          </section>

          {/* ACCOUNT — a project secret by slug; the value is never shown. */}
          <section className="space-y-1.5">
            {sectionLabel("Account", "new-profile-account-label")}
            {projects.isPending ? <Spinner label="Loading your projects" /> : null}
            {projects.isError ? (
              <p className="font-mono text-[11px] text-st-waiting-tag-fg">
                ! your projects could not be read — no account can be chosen yet
              </p>
            ) : projectItems.length === 0 ? (
              <p className="text-[12px] text-muted">
                No account — you are a member of no project yet.
              </p>
            ) : (
              <div className="space-y-1.5">
                {projectItems.length > 1 ? (
                  <Select
                    id="new-profile-project"
                    aria-label="Project"
                    value={projectId}
                    onChange={(event) => {
                      setProjectChoice(event.target.value);
                      setSecretId("");
                    }}
                    className="w-auto font-mono text-[12px]"
                    data-testid="new-profile-project-select"
                  >
                    {projectItems.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {secrets.isPending && projectId !== "" ? (
                  <Spinner label="Loading project secrets" />
                ) : secrets.isError ? (
                  <p className="font-mono text-[11px] text-st-waiting-tag-fg">
                    ! the project's secrets could not be read
                  </p>
                ) : (
                  <Select
                    id="new-profile-secret"
                    aria-label="Account secret"
                    value={secretId}
                    onChange={(event) => setSecretId(event.target.value)}
                    className="w-auto font-mono text-[12px]"
                    data-testid="new-profile-secret-select"
                  >
                    <option value="">No account</option>
                    {(secrets.data?.secrets ?? [])
                      .filter((entry) => entry.revoked_at == null)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.slug}
                        </option>
                      ))}
                  </Select>
                )}
                <p className="text-[11.5px] text-muted">
                  value never shown · granting adds the secret's allowlist entry after create
                </p>
                <p className="text-[11.5px] text-muted">
                  A GitHub token here lets the agent push and open PRs (ADR-0045).
                </p>
              </div>
            )}
          </section>

          {/* NAME */}
          <section className="space-y-1.5">
            <Field
              id="agents-new-name"
              label="Name"
              hint={`suggested from agent${forStep ? " + step" : ""}; unique in the organization`}
              className="max-w-[24rem]"
            >
              <Input
                id="agents-new-name"
                value={nameValue}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
                data-testid="agents-new-name-input"
              />
            </Field>
          </section>

          {/* SKILLS · OPTIONAL APM PACKAGE */}
          <section className="space-y-1.5">
            {sectionLabel("Skills · optional APM package", "new-profile-apm-label")}
            <div className="flex flex-wrap items-end gap-2">
              <Field id="new-profile-apm-ref" label="ref" className="w-[16rem] flex-1">
                <Input
                  id="new-profile-apm-ref"
                  value={apmRef}
                  onChange={(event) => setApmRef(event.target.value)}
                  placeholder="mattpocock/skills#v1.3.1"
                  className="font-mono text-[12px]"
                  data-testid="new-profile-apm-ref"
                />
              </Field>
              <Field id="new-profile-apm-target" label="target" className="w-[8rem]">
                <Select
                  id="new-profile-apm-target"
                  value={apmTarget}
                  onChange={(event) => setApmTarget(event.target.value)}
                  className="font-mono text-[12px]"
                  data-testid="new-profile-apm-target"
                >
                  <option value="">—</option>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </Select>
              </Field>
              <Field id="new-profile-apm-digest" label="lock digest" className="w-[18rem] flex-1">
                <Input
                  id="new-profile-apm-digest"
                  value={apmDigest}
                  onChange={(event) => setApmDigest(event.target.value)}
                  placeholder="sha256:…"
                  className="font-mono text-[12px]"
                  data-testid="new-profile-apm-digest"
                />
              </Field>
              <Button
                type="button"
                variant="secondary"
                disabled
                title="Computing the lock digest server-side is not available yet"
                data-testid="new-profile-lock"
              >
                Lock it
              </Button>
            </div>
            <p className="font-mono text-[11px] text-muted">
              · computing the lock digest server-side is not available yet — paste it by hand
            </p>
            {apmPartial ? (
              <p className="font-mono text-[11px] text-st-waiting-tag-fg" role="alert">
                ! ref, target and digest travel together — fill all three or leave all empty
              </p>
            ) : null}
          </section>

          {/* Defaults — only claims that hold for profiles today. */}
          <Alert state="done" barTone="pale" testid="new-profile-defaults">
            <span className="font-mono text-[12px]">
              permission ask · sandbox: {sandboxWord(sandbox.data ?? null)}
            </span>
          </Alert>

          {submitError ? <FormError error={submitError} testid="agents-new-problem" /> : null}

          <footer className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              data-testid="new-profile-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              data-testid="agents-new-submit"
            >
              {busy ? "Creating…" : forStep ? `Create and use in ${forStep}` : "Create profile"}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
