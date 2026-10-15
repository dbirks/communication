/**
 * Project settings → Secrets (J8, `docs/design/wireframes.md` §9).
 *
 * The invariant this screen is built around: **a secret value exists in exactly
 * one place — the write request body.** `api/openapi.yaml` has no route that
 * returns one (not masked, not "last 4", not for an admin), so there is no
 * client state that could hold one: the masked input writes into a `useState`
 * that is cleared as soon as the mutation is dispatched, and the row renders
 * `Secret` metadata only. A test asserts the value appears in the POST body and
 * in nothing that gets rendered afterwards.
 *
 * The second invariant is scope honesty: `allowed_agent_profile_ids` is an
 * allowlist where **empty means denied to every profile** (ADR-0018 D3), so the
 * row says "no profile may receive it" rather than leaving a blank cell that
 * reads as "all".
 */
import { useState, type FormEvent } from "react";
import { problemOf } from "../api/client";
import {
  useAddSecretVersion,
  useCreateSecret,
  useCreateSecretMount,
  useDeleteSecretMount,
  useRevokeSecret,
  useSecretMaterializations,
  useSecretMounts,
  useSecrets,
  useUpdateSecret,
} from "../api/queries";
import {
  ENV_FILE_POLICY_WARNINGS,
  ENV_FILE_TRUST_WARNING,
  LIFECYCLE_COPY,
  validateEnvName,
  validateMountPath,
  validateSecretSlug,
} from "../api/mountPolicy";
import type {
  AgentProfile,
  Project,
  Secret,
  SecretDeliveryMode,
  SecretMount,
  SecretScope,
} from "../api/types";
import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";
import { Field, Input, Select } from "./ds/Field";
import { Panel } from "./ds/Panel";
import { Row, StatusChip } from "./ds/Row";
import { Spinner } from "./Feedback";
import { formatTime, shortId } from "../lib/format";

/** `Secret` → chip state: revoked is a finding, rotation is informational. */
function secretState(secret: Secret): "done" | "waiting" | "failed" {
  if (secret.revoked_at) return "failed";
  if (secret.allowed_agent_profile_ids.length === 0) return "waiting";
  return "done";
}

/** Names for the allowlist, from the profile directory the app already caches. */
function profileNames(ids: string[], profiles: AgentProfile[] | undefined): string {
  if (ids.length === 0) return "no profile may receive it";
  if (!profiles) return `${ids.length} profile(s)`;
  return (
    ids
      .map((id) => profiles.find((profile) => profile.id === id)?.name ?? shortId(id))
      .join(", ") || "no profile may receive it"
  );
}

export interface SecretsPanelProps {
  project: Project;
  profiles: AgentProfile[] | undefined;
  /** Revealed when a secret is selected, to read its materialization audit. */
  onSelect: (secret: Secret) => void;
  selectedId: string | null;
}

/** The SecretRef list plus the write-only create/rotate/revoke/policy forms. */
export function SecretsPanel({ project, profiles, onSelect, selectedId }: SecretsPanelProps) {
  const secrets = useSecrets(project.id);
  const create = useCreateSecret(project.id);
  const rotate = useAddSecretVersion(project.id);
  const revoke = useRevokeSecret(project.id);
  const update = useUpdateSecret(project.id);
  const canManage = project.my_role === "maintainer";

  const [slug, setSlug] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState<SecretScope>("project");
  const [delivery, setDelivery] = useState<SecretDeliveryMode>("env_file");
  const [allowedProfileIds, setAllowedProfileIds] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [rotateFor, setRotateFor] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");

  const slugVerdict = validateSecretSlug(slug);
  const data = secrets.data?.secrets ?? [];
  const needsAttention = data.filter((secret) => secret.revoked_at).length;
  // The selected row is the one whose materialization audit is open below; the
  // highlight is an ink edge (rule 01: raised selection), never colour alone.
  const isSelected = (secret: Secret) => secret.id === selectedId;

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!slugVerdict.ok || !value) return;
    create.mutate(
      {
        slug: slug.trim(),
        purpose: purpose.trim(),
        scope,
        delivery_mode: delivery,
        allowed_agent_profile_ids: allowedProfileIds,
        value,
      },
      {
        onSuccess: () => {
          // Cleared immediately and unconditionally: the value never comes back,
          // so keeping it in state would be a strictly worse copy of a secret.
          setSlug("");
          setPurpose("");
          setValue("");
          setAllowedProfileIds([]);
        },
      },
    );
  };

  const submitRotate = (secretId: string) => {
    if (!rotateValue) return;
    rotate.mutate(
      { secretId, body: { value: rotateValue } },
      {
        onSuccess: () => {
          setRotateValue("");
          setRotateFor(null);
        },
      },
    );
  };

  return (
    <Panel
      id="secrets"
      title="SECRETS"
      headingId="secrets-heading"
      headingLevel={2}
      state={needsAttention > 0 ? "waiting" : undefined}
      meta={secrets.data ? `${data.length} references` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {secrets.isPending ? <Spinner label="Loading secret references" /> : null}
        {secrets.error ? (
          <Alert state="failed" label="FAILED" role="alert" testid="secret-list-error">
            {problemOf(secrets.error).detail || "Secret references could not be loaded."}
          </Alert>
        ) : null}
        <table className="w-full border-collapse text-[12.5px]" data-testid="secret-list">
          <caption className="sr-only">
            Secret references in this project — metadata only, values are never readable
          </caption>
          <thead>
            <tr className="border-b border-line-strong text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              <th scope="col" className="py-1 pr-4">
                Slug
              </th>
              <th scope="col" className="py-1 pr-4">
                Scope
              </th>
              <th scope="col" className="py-1 pr-4">
                Delivery
              </th>
              <th scope="col" className="py-1 pr-4">
                Version
              </th>
              <th scope="col" className="py-1 pr-4">
                Profiles allowed to receive it
              </th>
              <th scope="col" className="py-1 pr-4">
                Policy
              </th>
              <th scope="col" className="py-1">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((secret) => (
              <tr
                key={secret.id}
                data-testid={`secret-row-${secret.slug}`}
                aria-current={isSelected(secret) ? "true" : undefined}
                className={`border-b border-line-soft align-top last:border-b-0 ${
                  isSelected(secret) ? "bg-accent-wash" : ""
                }`}
              >
                <td className="py-[5px] pr-4 font-semibold">
                  <button
                    type="button"
                    className="text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    data-testid={`secret-select-${secret.slug}`}
                    onClick={() => onSelect(secret)}
                  >
                    {secret.slug}
                  </button>
                  {secret.purpose ? (
                    <span className="block font-ui text-[11.5px] font-normal text-muted">
                      {secret.purpose}
                    </span>
                  ) : null}
                </td>
                <td className="py-[5px] pr-4 font-mono text-[11px]">{secret.scope}</td>
                <td className="py-[5px] pr-4 font-mono text-[11px]">{secret.delivery_mode}</td>
                <td className="py-[5px] pr-4 font-mono text-[11px]">
                  v{secret.current_version}
                  {secret.rotated_at ? (
                    <span className="block text-[10.5px] text-faint">
                      rotated {formatTime(secret.rotated_at)}
                    </span>
                  ) : null}
                </td>
                <td className="py-[5px] pr-4 text-[11.5px]">
                  {profileNames(secret.allowed_agent_profile_ids, profiles)}
                </td>
                <td className="py-[5px] pr-4 font-mono text-[11px]">{secret.audit_policy}</td>
                <td className="py-[5px]">
                  <StatusChip
                    state={secretState(secret)}
                    label={secret.revoked_at ? "revoked" : "active"}
                    labelProps={{ "data-testid": `secret-state-${secret.slug}` }}
                  />
                  {canManage && !secret.revoked_at ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Button
                        variant="secondaryPlain"
                        compact
                        data-testid={`secret-rotate-${secret.slug}`}
                        onClick={() =>
                          setRotateFor((current) => (current === secret.id ? null : secret.id))
                        }
                      >
                        {rotateFor === secret.id ? "Cancel" : "Rotate"}
                      </Button>
                      <Button
                        variant="danger"
                        compact
                        data-testid={`secret-revoke-${secret.slug}`}
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(secret.id)}
                      >
                        Revoke
                      </Button>
                      <Button
                        variant="secondaryPlain"
                        compact
                        data-testid={`secret-audit-${secret.slug}`}
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({
                            secretId: secret.id,
                            body: {
                              purpose: secret.purpose,
                              allowed_agent_profile_ids: secret.allowed_agent_profile_ids,
                              // The one policy toggle this screen offers, flipped
                              // explicitly rather than silently kept.
                              audit_policy:
                                secret.audit_policy === "materialization"
                                  ? "materialization_and_access"
                                  : "materialization",
                            },
                          })
                        }
                      >
                        {secret.audit_policy === "materialization"
                          ? "Audit accesses"
                          : "Audit materializations only"}
                      </Button>
                    </span>
                  ) : null}
                  {rotateFor === secret.id ? (
                    <span className="mt-1 block space-y-1">
                      <label className="sr-only" htmlFor={`secret-new-value-${secret.slug}`}>
                        New value (write-only)
                      </label>
                      <Input
                        id={`secret-new-value-${secret.slug}`}
                        data-testid={`secret-rotate-value-${secret.slug}`}
                        type="password"
                        autoComplete="new-password"
                        placeholder="new value — never shown again"
                        value={rotateValue}
                        onChange={(event) => setRotateValue(event.target.value)}
                      />
                      <Button
                        variant="primary"
                        compact
                        data-testid={`secret-rotate-submit-${secret.slug}`}
                        disabled={rotate.isPending || !rotateValue}
                        onClick={() => submitRotate(secret.id)}
                      >
                        {rotate.isPending ? "Saving…" : "Add version"}
                      </Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {secrets.data && data.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="py-2 text-[12.5px] text-muted"
                  data-testid="secret-list-empty"
                >
                  No secret references yet. A pipeline names a secret by slug and never carries a
                  literal.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {canManage ? (
          <form
            onSubmit={submitCreate}
            aria-labelledby="add-secret-heading"
            className="space-y-3 border-t border-line-soft pt-3"
            data-testid="secret-create-form"
          >
            <h3
              id="add-secret-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Add a secret reference
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                id="secret-slug"
                label="Slug"
                error={slug ? (slugVerdict.message ?? undefined) : undefined}
              >
                <Input
                  id="secret-slug"
                  data-testid="secret-slug"
                  value={slug}
                  invalid={Boolean(slug) && !slugVerdict.ok}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="test-database-url"
                  required
                />
              </Field>
              <Field id="secret-purpose" label="Purpose">
                <Input
                  id="secret-purpose"
                  data-testid="secret-purpose"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="integration test database"
                />
              </Field>
              <Field id="secret-scope" label="Scope">
                <Select
                  id="secret-scope"
                  data-testid="secret-scope"
                  value={scope}
                  onChange={(event) => setScope(event.target.value as SecretScope)}
                >
                  <option value="project">project</option>
                  <option value="org">org</option>
                </Select>
              </Field>
              <Field
                id="secret-delivery"
                label="Delivery"
                hint={
                  <p className="font-mono text-[10.5px] text-faint">
                    integration_broker is refused in M3 (ADR-0018 clause 8)
                  </p>
                }
              >
                <Select
                  id="secret-delivery"
                  data-testid="secret-delivery"
                  value={delivery}
                  onChange={(event) => setDelivery(event.target.value as SecretDeliveryMode)}
                >
                  <option value="env_file">env_file</option>
                  <option value="env">env</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="secret-value"
                label="Value (write-only)"
                hint={
                  <p
                    className="font-mono text-[10.5px] text-faint"
                    data-testid="secret-value-warning"
                  >
                    stored encrypted, never shown again, never in an event, log or response
                  </p>
                }
              >
                {/* `type=password` + `autocomplete=new-password`: masked in the
                    DOM, never auto-reinserted, and cleared on submit below. */}
                <Input
                  id="secret-value"
                  data-testid="secret-value"
                  type="password"
                  autoComplete="new-password"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  required
                />
              </Field>
              <Field
                id="secret-profiles"
                label="Profiles allowed to receive it"
                hint={
                  <p
                    className="font-mono text-[10.5px] text-faint"
                    data-testid="secret-profiles-hint"
                  >
                    none selected = denied to every profile (ADR-0018 D3); cmd-click to choose
                    several
                  </p>
                }
              >
                <Select
                  id="secret-profiles"
                  data-testid="secret-profiles"
                  multiple
                  size={3}
                  value={allowedProfileIds}
                  onChange={(event) =>
                    setAllowedProfileIds(
                      [...event.currentTarget.selectedOptions].map((o) => o.value),
                    )
                  }
                >
                  {(profiles ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid="secret-submit"
              disabled={create.isPending || !slugVerdict.ok || !value}
            >
              {create.isPending ? "Saving…" : "Add secret"}
            </Button>
            {create.error ? (
              <p
                className="font-mono text-[11px] text-st-failed-tag-fg"
                role="alert"
                data-testid="secret-create-error"
              >
                ×{" "}
                {problemOf(create.error).status === 409
                  ? "that slug already exists in this project — rotate it instead of creating a second reference"
                  : problemOf(create.error).detail || "The secret could not be created."}
              </p>
            ) : null}
            {create.isSuccess ? (
              <p
                className="text-[12.5px] text-muted"
                role="status"
                data-testid="secret-created-note"
              >
                Created. The value is gone from this page — it was never read back, and no route can
                show it.
              </p>
            ) : null}
          </form>
        ) : (
          <p className="text-[12.5px] text-muted">
            Only project maintainers can create, rotate or revoke secrets. The list above is
            metadata, which every member may read.
          </p>
        )}
        <p className="font-mono text-[10.5px] text-faint">
          no value, version list or content digest is ever listed here: a digest of a low-entropy
          secret is an offline guessing oracle for everyone who can read the list.
        </p>
      </div>
    </Panel>
  );
}

/** Declarations of *where* a secret is delivered (`05`'s YAML shape). */
export function SecretMountsPanel({
  project,
  secrets,
  repositories,
}: {
  project: Project;
  secrets: Secret[];
  repositories: { id: string; name: string }[];
}) {
  const mounts = useSecretMounts(project.id);
  const create = useCreateSecretMount(project.id);
  const remove = useDeleteSecretMount(project.id);
  const canManage = project.my_role === "maintainer";

  const [secretId, setSecretId] = useState("");
  const [delivery, setDelivery] = useState<SecretDeliveryMode>("env_file");
  const [repositoryId, setRepositoryId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [envName, setEnvName] = useState("");
  const [lifecycle, setLifecycle] = useState<SecretMount["lifecycle"]>("turn");
  const [allowTracked, setAllowTracked] = useState(false);

  const pathVerdict = delivery === "env_file" ? validateMountPath(relativePath) : null;
  const envVerdict = delivery === "env" ? validateEnvName(envName) : null;
  const secret = secrets.find((candidate) => candidate.id === secretId);
  const formOk =
    Boolean(secretId) &&
    (delivery === "env_file"
      ? Boolean(repositoryId) && Boolean(pathVerdict?.ok)
      : Boolean(envVerdict?.ok));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!formOk) return;
    create.mutate(
      {
        secret_id: secretId,
        delivery_mode: delivery,
        ...(delivery === "env_file"
          ? { repository_id: repositoryId, relative_path: relativePath.trim() }
          : { env_name: envName.trim() }),
        lifecycle,
        allow_tracked: allowTracked,
      },
      {
        onSuccess: () => {
          setRelativePath("");
          setEnvName("");
          setAllowTracked(false);
        },
      },
    );
  };

  const slugOf = (mount: SecretMount) => mount.secret_slug ?? shortId(mount.secret_id);
  const targetOf = (mount: SecretMount) =>
    mount.delivery_mode === "env_file"
      ? `${mount.relative_path ?? "(no path)"}`
      : (mount.env_name ?? "(no variable)");

  return (
    <Panel
      id="secret-mounts"
      title="SECRET MOUNTS"
      headingId="secret-mounts-heading"
      headingLevel={2}
      meta={mounts.data ? `${mounts.data.secret_mounts.length} declared` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {mounts.isPending ? <Spinner label="Loading secret mounts" /> : null}
        {mounts.error ? (
          <Alert state="failed" label="FAILED" role="alert" testid="secret-mount-list-error">
            {problemOf(mounts.error).detail || "Secret mount declarations could not be loaded."}
          </Alert>
        ) : null}
        <ul className="space-y-[4px]" data-testid="secret-mount-list">
          {(mounts.data?.secret_mounts ?? []).map((mount) => (
            <li key={mount.id}>
              <Row data-testid={`secret-mount-row-${slugOf(mount)}`}>
                <span className="text-[12.5px] font-semibold">{slugOf(mount)}</span>
                <span className="font-mono text-[10.5px] text-muted">→</span>
                <span
                  className="font-mono text-[11px]"
                  data-testid={`secret-mount-target-${mount.id}`}
                >
                  {targetOf(mount)}
                </span>
                <span className="font-mono text-[10.5px] text-muted">
                  {mount.delivery_mode} · {lifecycleCopyOf(mount)}
                  {/* Single-key extraction from a multi-line value (`05`'s `key`): a
                      mount that names one is not the same declaration as one that
                      writes the whole file, so the row must not look identical. */}
                  {mount.key ? (
                    <span className="ml-1" data-testid={`secret-mount-key-${mount.id}`}>
                      · key {mount.key}
                    </span>
                  ) : null}
                </span>
                {mount.allow_tracked ? (
                  <span className="font-mono text-[10.5px] text-st-waiting-tag-fg">
                    ! tracked target allowed
                  </span>
                ) : null}
                {canManage ? (
                  <Button
                    variant="danger"
                    compact
                    className="ml-auto"
                    data-testid={`secret-mount-delete-${mount.id}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(mount.id)}
                  >
                    Remove
                  </Button>
                ) : null}
              </Row>
            </li>
          ))}
          {mounts.data && mounts.data.secret_mounts.length === 0 ? (
            <li className="text-[12.5px] text-muted" data-testid="secret-mount-list-empty">
              No mounts declared — a stored secret with no mount is a secret nothing can use.
            </li>
          ) : null}
        </ul>

        <ul className="space-y-[2px] rounded-[3px] border border-line bg-fill/60 px-[10px] py-2">
          {ENV_FILE_POLICY_WARNINGS.map((line) => (
            <li
              key={line}
              className="font-mono text-[10.5px] text-ink-2"
              data-testid="mount-policy-line"
            >
              · {line}
            </li>
          ))}
        </ul>
        <Alert state="waiting" label="READ THIS" testid="mount-trust-warning">
          {ENV_FILE_TRUST_WARNING}
        </Alert>

        {canManage ? (
          <form
            onSubmit={onSubmit}
            aria-labelledby="add-mount-heading"
            className="space-y-3 border-t border-line-soft pt-3"
            data-testid="secret-mount-form"
          >
            <h3
              id="add-mount-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Declare a mount
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field id="mount-secret" label="Secret">
                <Select
                  id="mount-secret"
                  data-testid="mount-secret"
                  value={secretId}
                  onChange={(event) => setSecretId(event.target.value)}
                  required
                >
                  <option value="">Select a secret…</option>
                  {secrets
                    .filter((candidate) => !candidate.revoked_at)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.slug} (
                        {candidate.delivery_mode === "env_file" ? "env_file" : "env"})
                      </option>
                    ))}
                </Select>
              </Field>
              <Field id="mount-delivery" label="Delivery">
                <Select
                  id="mount-delivery"
                  data-testid="mount-delivery"
                  value={delivery}
                  onChange={(event) => setDelivery(event.target.value as SecretDeliveryMode)}
                >
                  <option value="env_file">env_file (a `.env` target)</option>
                  <option value="env">env (one variable)</option>
                </Select>
              </Field>
              <Field id="mount-lifecycle" label="Lifecycle" hint={lifecycleHint(lifecycle)}>
                <Select
                  id="mount-lifecycle"
                  data-testid="mount-lifecycle"
                  value={lifecycle}
                  onChange={(event) => setLifecycle(event.target.value as SecretMount["lifecycle"])}
                >
                  <option value="turn">turn</option>
                  <option value="workspace">workspace</option>
                  <option value="node_attempt">node_attempt (needs M4)</option>
                </Select>
              </Field>
              {delivery === "env_file" ? (
                <>
                  <Field id="mount-repo" label="Repository">
                    <Select
                      id="mount-repo"
                      data-testid="mount-repo"
                      value={repositoryId}
                      onChange={(event) => setRepositoryId(event.target.value)}
                      required
                    >
                      <option value="">Select a repository…</option>
                      {repositories.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    id="mount-path"
                    label="`.env` target path"
                    error={relativePath ? (pathVerdict?.message ?? undefined) : undefined}
                    hint={
                      <p
                        className="font-mono text-[10.5px] text-faint"
                        data-testid="mount-path-hint"
                      >
                        relative to the checkout — no leading /, no .., no empty segment
                      </p>
                    }
                  >
                    <Input
                      id="mount-path"
                      data-testid="mount-path"
                      value={relativePath}
                      invalid={Boolean(relativePath) && !pathVerdict?.ok}
                      onChange={(event) => setRelativePath(event.target.value)}
                      placeholder="backend/.env.test.local"
                      required
                    />
                  </Field>
                </>
              ) : (
                <Field
                  id="mount-env-name"
                  label="Variable name"
                  error={envName ? (envVerdict?.message ?? undefined) : undefined}
                >
                  <Input
                    id="mount-env-name"
                    data-testid="mount-env-name"
                    value={envName}
                    invalid={Boolean(envName) && !envVerdict?.ok}
                    onChange={(event) => setEnvName(event.target.value)}
                    placeholder="DATABASE_URL"
                    required
                  />
                </Field>
              )}
            </div>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                data-testid="mount-allow-tracked"
                checked={allowTracked}
                onChange={(event) => setAllowTracked(event.target.checked)}
              />
              Allow a tracked target (the explicit policy exception in `05`; the default refuses)
            </label>
            {secret && secret.allowed_agent_profile_ids.length === 0 ? (
              <p
                className="font-mono text-[11px] text-st-waiting-tag-fg"
                data-testid="mount-scope-warning"
              >
                ! “{secret.slug}” grants no agent profile, so no launch will receive it even after
                this mount exists.
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              data-testid="mount-submit"
              disabled={create.isPending || !formOk}
            >
              {create.isPending ? "Declaring…" : "Declare mount"}
            </Button>
            {create.error ? (
              <p
                className="font-mono text-[11px] text-st-failed-tag-fg"
                role="alert"
                data-testid="mount-create-error"
              >
                × {problemOf(create.error).detail || "The mount could not be declared."}
              </p>
            ) : null}
          </form>
        ) : (
          <p className="text-[12.5px] text-muted">
            Only project maintainers can declare or remove mounts.
          </p>
        )}
      </div>
    </Panel>
  );
}

/** Copy for a mount's lifecycle, quoting the enum rather than paraphrasing it. */
function lifecycleCopyOf(mount: SecretMount): string {
  return LIFECYCLE_COPY[mount.lifecycle] ?? mount.lifecycle;
}

function lifecycleHint(lifecycle: SecretMount["lifecycle"]) {
  return (
    <p className="font-mono text-[10.5px] text-faint" data-testid="mount-lifecycle-hint">
      {LIFECYCLE_COPY[lifecycle] ?? lifecycle}
    </p>
  );
}

/** The audit view for one secret: which unit had it, at what target, when cleaned. */
export function MaterializationsPanel({
  project,
  secret,
}: {
  project: Project;
  secret: Secret | null;
}) {
  const audit = useSecretMaterializations(project.id, secret?.id ?? "");
  if (!secret) {
    return (
      <Panel title="MATERIALIZATIONS" headingId="materializations-heading" headingLevel={2}>
        <p className="p-[10px] text-[12.5px] text-muted" data-testid="materialization-empty">
          Select a secret to read which unit held it, at which target, and when it was cleaned.
        </p>
      </Panel>
    );
  }
  const rows = audit.data?.materializations ?? [];
  const uncleared = rows.filter((row) => !row.cleaned_at).length;

  return (
    <Panel
      id="materializations"
      title={`MATERIALIZATIONS · ${secret.slug}`}
      headingId="materializations-heading"
      headingLevel={2}
      // A value still sitting on disk is exactly the finding the startup sweep
      // exists to close, so the panel needs action, not a gray bar.
      state={uncleared > 0 ? "failed" : undefined}
      meta={audit.data ? `${rows.length} records` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {audit.isPending ? <Spinner label="Loading materializations" /> : null}
        {audit.error ? (
          <Alert state="failed" label="FAILED" role="alert" testid="materialization-error">
            {problemOf(audit.error).detail ||
              "The materialization audit could not be read (a maintainer role is required)."}
          </Alert>
        ) : null}
        {uncleared > 0 ? (
          <Alert state="failed" label="LEFT BEHIND" role="alert" testid="materialization-uncleared">
            {uncleared} materialization{uncleared === 1 ? "" : "s"} still report no cleanup: a value
            is where a unit put it until the sweep removes it.
          </Alert>
        ) : null}
        <ul className="space-y-[4px]" data-testid="materialization-list">
          {rows.map((row) => (
            <li key={row.id}>
              <Row data-testid={`materialization-row-${row.id}`}>
                <StatusChip
                  state={row.cleaned_at ? "done" : "failed"}
                  label={row.cleaned_at ? "cleaned" : "present"}
                />
                <span className="font-mono text-[11px]">v{row.secret_version}</span>
                <span
                  className="font-mono text-[11px]"
                  data-testid={`materialization-target-${row.id}`}
                >
                  {row.target}
                </span>
                <span className="font-mono text-[10.5px] text-muted">
                  workspace {shortId(row.workspace_id)} · turn {shortId(row.turn_id)}
                </span>
                {row.file_mode != null ? (
                  <span className="font-mono text-[10.5px] text-muted">
                    mode 0{row.file_mode.toString(8)} (recorded, not asserted)
                  </span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-faint">
                  {row.cleaned_at
                    ? `cleaned ${formatTime(row.cleaned_at)} by ${row.cleaned_by}`
                    : `materialized ${formatTime(row.materialized_at)}`}
                </span>
              </Row>
            </li>
          ))}
          {audit.data && rows.length === 0 ? (
            <li className="text-[12.5px] text-muted" data-testid="materialization-list-empty">
              Never materialized — no unit has ever received this secret.
            </li>
          ) : null}
        </ul>
      </div>
    </Panel>
  );
}
