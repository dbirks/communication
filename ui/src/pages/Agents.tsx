/**
 * Agents (`/agents`): the organization's launch descriptors and the APM pin each
 * one stages (`ADR-0030`).
 *
 * Honesty rules:
 * - A row is `GET /api/v1/agent-profiles` and nothing else. `permission_mode`
 *   is rendered, never editable — the route has no field for it, and `ask` is
 *   the only mode an unverified launcher may hold (ADR-0009).
 * - The APM triple moves as one unit: the form sends all three values or the
 *   cleared triple, and a partial pin is refused by the server as
 *   `apm_pin_incomplete`. The digest pattern below is a *hint*; the server
 *   decides, and its `code` is what renders.
 * - Staging is not isolation (ADR-0030 §6 / `04-agent-runtime.md`): the page
 *   says so, because "attached a skills package" reads like a safety claim.
 * - Write controls appear only for the organization's library role — the same
 *   fail-closed predicate `pages/Library.tsx` uses for the shared pipeline
 *   library (`me.is_org_admin`), which is exactly the server's check.
 */
import { useState } from "react";
import { Panel } from "../components/ds/Panel";
import { Row } from "../components/ds/Row";
import { Button } from "../components/ds/Button";
import { Field, Input, Select } from "../components/ds/Field";
import { Alert } from "../components/ds/Alert";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { ApiError, problemOf } from "../api/client";
import {
  useAgentProfiles,
  useCreateAgentProfile,
  useMe,
  usePatchAgentProfile,
  type AgentProfileAPMPatch,
} from "../api/queries";
import type { AgentProfile } from "../api/types";
import { shortDigest } from "../lib/pipeline/yamlPointer";

/** Hint only — `api/openapi.yaml` checks this too, but the server's 422 wins. */
export const LOCK_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Example from `docs/compatibility/APM.md` "Git-tag sources (spike 2026-10-16)". */
const REF_EXAMPLE = "mattpocock/skills#v1.3.1";

/**
 * The stable `code` of a profile-write refusal. The prose is not the contract
 * (ADR-0030 §4): the body's `code`, or the `type` URI ending in it.
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
function ProblemCode({ error, testid }: { error: unknown; testid: string }) {
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

export default function AgentsPage() {
  const me = useMe();
  const profiles = useAgentProfiles();
  const canWrite = me.data?.is_org_admin === true;
  const [editingId, setEditingId] = useState<string | null>(null);
  const items = profiles.data?.items ?? [];

  return (
    <div className="space-y-4" data-testid="agents-page">
      <header className="space-y-1">
        <h1 className="text-[19px] font-bold" id="agents-heading">
          Agents
        </h1>
        <p className="text-[12.5px] text-muted" data-testid="agents-disclaimer">
          Skill packages are staged into the agent&apos;s workspace; APM staging is not isolation.
        </p>
      </header>
      {me.isError ? (
        <ProblemBanner error={me.error} fallback="Your identity could not be read." />
      ) : null}
      {canWrite ? <NewAgentForm /> : null}
      {profiles.isPending ? <Spinner label="Loading agent profiles" /> : null}
      {profiles.isError ? (
        <ProblemBanner
          error={profiles.error}
          fallback="The agent profiles could not be read."
          testid="agents-load-error"
        />
      ) : null}
      {profiles.data ? (
        <Panel
          title="AGENT PROFILES"
          headingId="agents-rows-heading"
          headingLevel={2}
          meta={
            <span className="font-mono text-[10px] font-normal">
              {canWrite ? "the library role may pin a package" : "read-only for your role"}
            </span>
          }
        >
          {items.length === 0 ? (
            <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="agents-empty">
              no agent profiles in this organization
            </p>
          ) : null}
          <ul className="divide-y divide-line" data-testid="agent-list">
            {items.map((profile) => (
              <li key={profile.id} data-testid={`agent-item-${profile.id}`}>
                <ProfileRow
                  profile={profile}
                  canWrite={canWrite}
                  editing={editingId === profile.id}
                  onEdit={() => setEditingId(profile.id)}
                  onClose={() => setEditingId(null)}
                />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/** One launch descriptor: what it drives, and the pin it stages (if any). */
function ProfileRow({
  profile,
  canWrite,
  editing,
  onEdit,
  onClose,
}: {
  profile: AgentProfile;
  canWrite: boolean;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const pinned = profile.apm_package_ref != null;
  return (
    <>
      <Row className="h-auto flex-wrap" data-testid={`agent-row-${profile.id}`}>
        <span
          className="min-w-[10rem] flex-1 text-[13px] font-semibold"
          data-testid={`agent-name-${profile.id}`}
        >
          {profile.name}
        </span>
        <span
          className="font-mono text-[11px] text-muted"
          data-testid={`agent-launcher-${profile.id}`}
        >
          launcher: {profile.launcher_id}
        </span>
        <span
          className="font-mono text-[11px] text-faint"
          data-testid={`agent-permission-${profile.id}`}
          title="not writable: ask is the only mode a launcher without verified sandbox enforcement may hold"
        >
          permission: {profile.permission_mode}
        </span>
        {pinned ? (
          <span className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="text-ink-2" data-testid={`agent-apm-ref-${profile.id}`}>
              {profile.apm_package_ref}
            </span>
            <span className="text-muted" data-testid={`agent-apm-target-${profile.id}`}>
              target: {profile.apm_target}
            </span>
            <span className="text-faint" data-testid={`agent-apm-digest-${profile.id}`}>
              {shortDigest(profile.apm_lock_digest)}
            </span>
          </span>
        ) : (
          <span
            className="font-mono text-[11px] text-faint"
            data-testid={`agent-apm-none-${profile.id}`}
          >
            no skill package
          </span>
        )}
        {canWrite ? (
          <Button
            variant="secondary"
            compact
            onClick={editing ? onClose : onEdit}
            data-testid={`agent-edit-${profile.id}`}
          >
            {editing ? "Close" : pinned ? "Edit" : "Attach skill package"}
          </Button>
        ) : null}
      </Row>
      {editing ? <ApmPinForm profile={profile} onDone={onClose} /> : null}
    </>
  );
}

/**
 * `POST /api/v1/agent-profiles` — the fields the route takes, exactly: `name`
 * and `launcher_id`. No permission mode, no APM fields: a new profile must not
 * be creatable in the unverifiable half-pin state probe A5b describes.
 */
function NewAgentForm() {
  const create = useCreateAgentProfile();
  const [name, setName] = useState("");
  const [launcherId, setLauncherId] = useState("claude");

  async function submit() {
    if (name.trim() === "") return;
    try {
      await create.mutateAsync({ name: name.trim(), launcher_id: launcherId });
      setName("");
    } catch {
      // the problem renders below — a duplicate name is the server's 409
    }
  }

  return (
    <Panel
      title="NEW AGENT"
      headingId="agents-new-heading"
      headingLevel={2}
      meta={<span className="font-mono text-[10px] font-normal">pins are recorded later</span>}
    >
      <form
        className="flex flex-wrap items-end gap-[10px] p-[10px]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        data-testid="agents-new-form"
      >
        <Field
          id="agents-new-name"
          label="name"
          hint="unique in the organization; a duplicate is a 409"
          error={
            create.isError
              ? problemOf(create.error).detail || problemOf(create.error).title
              : undefined
          }
          className="min-w-[16rem] flex-1"
        >
          <Input
            id="agents-new-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="agents-new-name-input"
          />
        </Field>
        <Field
          id="agents-new-launcher"
          label="launcher_id"
          hint="a launcher registry id, argv only"
        >
          <Select
            id="agents-new-launcher"
            value={launcherId}
            onChange={(event) => setLauncherId(event.target.value)}
            className="w-auto"
            data-testid="agents-new-launcher-select"
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </Select>
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || name.trim() === ""}
          data-testid="agents-new-submit"
        >
          {create.isPending ? "Creating…" : "New agent"}
        </Button>
      </form>
      {create.isError ? (
        <div className="px-[10px] pb-[10px]">
          <ProblemCode error={create.error} testid="agents-new-problem" />
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * The APM triple for one profile, edited as one unit. `Save` sends all three
 * values; `Remove package` sends the cleared triple — there is no route to
 * change one column, because a ref without a digest would stage whatever the
 * ref points at today (`ADR-0030` §4, APM.md probe A5b).
 */
function ApmPinForm({ profile, onDone }: { profile: AgentProfile; onDone: () => void }) {
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
function DigestHelp({
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
