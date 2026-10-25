/**
 * "GitHub access" on a repository (ADR-0061): the one mutable thing a
 * repository row carries — the `integration_broker` secret the platform
 * resolves for the mirror clone/fetch and for issue reads, or none.
 *
 * The line under the git URL says what the server actually said:
 * `public · no credential` when no credential is set, `credential · <slug>`
 * when one is (the slug comes from the project's own secret list — the wire
 * carries only the id, and an id nobody can read is not an answer). A
 * configured id whose secret is not in the project's list says so rather than
 * inventing a name.
 *
 * `change` opens the picker (Maintainer+, the route's own gate): one Select of
 * the project's `integration_broker` secrets plus `None (public repo)`, and the
 * one `PATCH /projects/{id}/repos/{repoId}` the route offers. This screen does
 * NOT create secrets: with no broker secret to pick it says so and links to the
 * project's Secrets settings, where one is created. The `422
 * invalid_credential_secret` answer stays on screen as the server wrote it.
 *
 * The secret VALUE is never on this surface, so nothing here can render it.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  type FormEvent,
  type Ref,
} from "react";
import { Link } from "react-router";
import { usePatchRepository, useSecrets } from "../../api/queries";
import type { Project, Repository } from "../../api/types";
import { Button } from "../ds/Button";
import { Field, Select } from "../ds/Field";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import { routes } from "../../lib/routes";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface GitHubAccessProps {
  project: Project;
  repository: Repository;
  /** React 19 ref-as-prop handle: the ISSUES panel's
   * "private repo? add GitHub access" line opens the picker from wherever it
   * sits on the page (ADR-0061 § 6 second half). */
  ref?: Ref<GitHubAccessHandle>;
}

/** The imperative surface: open the picker. Only offered on the line that
 * renders it; no other state is reachable from outside. */
export interface GitHubAccessHandle {
  open: () => void;
}

/** The id the ADR-0061 credential carries: the explicit member, read as none
 * when the server (or an older stub) left it out. */
function credentialId(repository: Repository): string | null {
  const id = repository.credential_secret_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Does the row say a credential is configured — the derived member, or the
 * id itself when the member is missing. Exported because the ISSUES panel
 * refuses to blame a 404 on privacy when a credential was in fact sent. */
export function hasCredential(repository: Repository): boolean {
  return repository.credential === "configured" || credentialId(repository) !== null;
}

export function GitHubAccess({ project, repository, ref }: GitHubAccessProps) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const secrets = useSecrets(project.id);
  const canManage = project.my_role === "maintainer";
  const configured = hasCredential(repository);
  const activeId = credentialId(repository);
  const activeSlug = secrets.data?.secrets.find((secret) => secret.id === activeId)?.slug ?? null;

  const stateLine = !configured
    ? "public · no credential"
    : secrets.isPending
      ? "credential · …"
      : activeSlug
        ? `credential · ${activeSlug}`
        : "credential · secret unavailable";

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted"
        data-testid="repo-github-access"
      >
        <span data-testid="repo-github-access-state">{stateLine}</span>
        {canManage ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="repo-github-access-change"
          >
            change
          </button>
        ) : null}
      </div>
      {open ? (
        <GitHubAccessDialog
          project={project}
          repository={repository}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

interface DialogProps {
  project: Project;
  repository: Repository;
  onClose: () => void;
}

function GitHubAccessDialog({ project, repository, onClose }: DialogProps) {
  const secrets = useSecrets(project.id);
  const patch = usePatchRepository(project.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  // Only a broker secret can be a repository credential (ADR-0061: an `env`
  // or `env_file` secret is a `422`), and a revoked one refuses to resolve —
  // neither belongs in the choice list.
  const choices = useMemo(
    () =>
      (secrets.data?.secrets ?? []).filter(
        (secret) => secret.delivery_mode === "integration_broker" && !secret.revoked_at,
      ),
    [secrets.data],
  );
  const current = repository.credential_secret_id ?? null;
  const [picked, setPicked] = useState<string>(current ?? "");

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>("select, button")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
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

  const wanted = picked === "" ? null : picked;
  const unchanged = wanted === current;
  const blocked = patch.isPending || secrets.isPending || unchanged;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    patch.mutate(
      { repositoryId: repository.id, body: { credential_secret_id: wanted } },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-access-title"
        className="w-[420px] max-w-full rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="github-access-dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="github-access-title" className="text-[15px] font-semibold">
              GitHub access
            </h2>
            <span className="block truncate font-mono text-[10.5px] text-muted">
              {`${repository.name} · ${project.name}`}
            </span>
          </div>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
        </div>
        <form className="flex flex-col gap-[12px] px-4 py-4" onSubmit={submit}>
          {secrets.isPending ? <Spinner label="Loading the project's secrets" /> : null}
          {secrets.isError ? (
            <ProblemBanner
              error={secrets.error}
              fallback="The project's secrets could not be read."
              testid="github-access-secrets-error"
            />
          ) : null}
          {!secrets.isPending && !secrets.isError && choices.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="github-access-no-secrets">
              This project has no <code className="font-mono">integration_broker</code> secret yet,
              so there is nothing to attach. Create one in{" "}
              <Link
                to={routes.projectTab(project.id, "settings")}
                className="font-mono text-[11.5px] text-accent-text hover:underline"
                data-testid="github-access-settings-link"
              >
                the project&apos;s Secrets settings
              </Link>
              .
            </p>
          ) : null}
          {choices.length > 0 ? (
            <Field
              id="github-access-select"
              label="GITHUB ACCESS"
              hint="the platform uses this token for the mirror clone/fetch and issue reads; an agent never receives it"
            >
              <Select
                id="github-access-select"
                value={picked}
                onChange={(event) => setPicked(event.target.value)}
                className="font-ui"
                data-testid="github-access-select"
              >
                <option value="">None (public repo)</option>
                {choices.map((secret) => (
                  <option key={secret.id} value={secret.id}>
                    {secret.slug}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {patch.isError ? <FormError error={patch.error} testid="github-access-error" /> : null}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              data-testid="github-access-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={blocked}
              data-testid="github-access-save"
              title={unchanged ? "nothing to change — the repository already says this" : undefined}
            >
              {patch.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
