/**
 * The profile version history panel (artboard 3e header + ADR-0058 part 2 = the
 * UI): the `v<N>` glyph's source of truth, the `Save as v<N+1>` write token's
 * answer, and the HISTORY panel — versions newest first, each with the field
 * level diff of its snapshot against the previous version's, a read-only
 * snapshot view, and a confirm-then-restore write that lands a NEW version
 * (the history is append-only, so a restore is a new version, not a rewrite).
 *
 * Honest by construction:
 * - The list comes from `GET /api/v1/agent-profiles/{profileId}/versions`
 *   (oldest first; rendered newest first here). A read failure renders the
 *   honest "not available yet" line, never an empty history.
 * - The diff names the fields that changed and their old → new values; the
 *   snapshot holds identifiers and references only, never secret values, and
 *   the APM half of a change is reported as "APM pin changed".
 * - The first version of a profile has no predecessor and reads "created".
 * - The restore is a write: it POSTs the restore and refetches the history;
 *   nothing here fabricates a version or a diff.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useAgentProfileVersion,
  useAgentProfileVersions,
  useRestoreAgentProfileVersion,
} from "../../api/useProfileVersions";
import type { AgentProfileVersion } from "../../api/types";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { Panel } from "../ds/Panel";
import { Spinner } from "../Feedback";
import { formatAge, formatTime } from "../../lib/format";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The snapshot fields a version may change, in the order the diff names them. */
const SNAPSHOT_FIELDS = [
  "name",
  "launcher_id",
  "permission_mode",
  "apm_package_ref",
  "apm_target",
  "apm_lock_digest",
] as const;

type Snapshot = AgentProfileVersion["snapshot"];

/** The field-level diff of one version against its predecessor's snapshot.
 * Field names only, old → new for the scalar fields; the APM half is reported
 * as "APM pin changed". The first version (no predecessor) reads "created". */
export function profileVersionDiff(
  previous: Snapshot | null | undefined,
  next: Snapshot | null | undefined,
): string[] {
  if (!previous) return ["created"];
  const changes: string[] = [];
  let apmChanged = false;
  for (const field of SNAPSHOT_FIELDS) {
    const before = previous[field];
    const after = next?.[field];
    if (before === after) continue;
    if (field === "apm_package_ref" || field === "apm_target" || field === "apm_lock_digest") {
      apmChanged = true;
      continue;
    }
    changes.push(`${field}: ${before ?? "—"} → ${after ?? "—"}`);
  }
  if (apmChanged) changes.push("APM pin changed");
  return changes.length > 0 ? changes : ["no change"];
}

/** The frozen snapshot as the version carried it, for the read-only view. */
function snapshotRows(version: AgentProfileVersion): { label: string; value: string }[] {
  const snapshot = version.snapshot ?? {};
  const rows: { label: string; value: string }[] = [
    { label: "name", value: snapshot.name ?? "—" },
    { label: "launcher", value: snapshot.launcher_id ?? "—" },
    { label: "permission", value: snapshot.permission_mode ?? "—" },
  ];
  if (
    snapshot.apm_package_ref != null ||
    snapshot.apm_target != null ||
    snapshot.apm_lock_digest != null
  ) {
    rows.push({ label: "apm_package_ref", value: snapshot.apm_package_ref ?? "—" });
    rows.push({ label: "apm_target", value: snapshot.apm_target ?? "—" });
    rows.push({ label: "apm_lock_digest", value: snapshot.apm_lock_digest ?? "—" });
  }
  return rows;
}

export interface ProfileHistoryProps {
  profileId: string;
  /** The library role may restore; a viewer gets the read-only history. */
  canWrite: boolean;
}

export default function ProfileHistory({ profileId, canWrite }: ProfileHistoryProps) {
  const versionsQuery = useAgentProfileVersions(profileId);
  const versions: AgentProfileVersion[] = [...(versionsQuery.data?.items ?? [])].sort(
    (a, b) => a.version - b.version,
  );
  const [confirming, setConfirming] = useState<AgentProfileVersion | null>(null);
  const [viewing, setViewing] = useState<AgentProfileVersion | null>(null);

  const pending = versionsQuery.isPending;
  const error = versionsQuery.isError;
  const display = versions
    .map((version, index) => ({
      version,
      change: profileVersionDiff(index > 0 ? versions[index - 1].snapshot : null, version.snapshot),
    }))
    .reverse();
  const newestVersion = versions.length > 0 ? versions[versions.length - 1].version : null;

  return (
    <Panel
      title="HISTORY"
      headingId={`profile-history-${profileId}`}
      headingLevel={3}
      meta={
        <span className="font-normal">
          {versions.length} version{versions.length === 1 ? "" : "s"}
        </span>
      }
    >
      <div data-testid="profile-history">
        {pending ? <Spinner label="Loading versions" /> : null}
        {error ? (
          <p
            className="p-[10px] font-mono text-[11px] text-muted"
            data-testid="profile-history-error"
          >
            versions could not be read — the history behind this profile is not available yet
          </p>
        ) : null}
        {!pending && !error && versions.length === 0 ? (
          <p
            className="p-[10px] font-mono text-[11px] text-muted"
            data-testid="profile-history-empty"
          >
            no versions yet — this profile has only its first version
          </p>
        ) : null}
        {!pending && !error && display.length > 0 ? (
          <ul className="divide-y divide-line" data-testid="profile-history-list">
            {display.map(({ version, change }) => (
              <li
                key={version.version}
                data-testid={`profile-history-row-v${version.version}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-[10px] py-2"
              >
                <span
                  className="font-mono text-[12px] font-semibold"
                  data-testid={`profile-history-version-v${version.version}`}
                >
                  v{version.version}
                </span>
                <span className="font-mono text-[11px] text-muted">{version.created_by}</span>
                <span
                  className="font-mono text-[10.5px] text-muted"
                  title={formatTime(version.created_at)}
                >
                  {formatAge(version.created_at)} · {formatTime(version.created_at)}
                </span>
                <span
                  className="font-mono text-[11px] text-ink-2"
                  data-testid={`profile-history-diff-v${version.version}`}
                >
                  {change.join(" · ")}
                </span>
                <span className="ml-auto flex items-center gap-x-2">
                  <Button
                    variant="ghost"
                    compact
                    onClick={() => setViewing(version)}
                    data-testid={`profile-history-view-v${version.version}`}
                  >
                    View
                  </Button>
                  {canWrite ? (
                    <Button
                      variant="secondary"
                      compact
                      onClick={() => setConfirming(version)}
                      data-testid={`profile-history-restore-v${version.version}`}
                    >
                      Restore v{version.version}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {confirming ? (
        <ProfileHistoryConfirm
          profileId={profileId}
          version={confirming.version}
          nextVersion={newestVersion != null ? newestVersion + 1 : confirming.version + 1}
          isNewest={confirming.version === newestVersion}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {viewing ? (
        <ProfileHistoryDrawer
          profileId={profileId}
          version={viewing.version}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </Panel>
  );
}

interface ProfileHistoryConfirmProps {
  profileId: string;
  version: number;
  nextVersion: number;
  isNewest: boolean;
  onClose: () => void;
}

/** The restore's confirm dialog: the restore is a NEW version, never a rewrite. */
function ProfileHistoryConfirm({
  profileId,
  version,
  nextVersion,
  isNewest,
  onClose,
}: ProfileHistoryConfirmProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const restore = useRestoreAgentProfileVersion();
  const [error, setError] = useState<unknown>(null);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
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
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function confirm() {
    setError(null);
    try {
      await restore.mutateAsync({ profileId, version });
      onClose();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-history-confirm-title"
        data-testid="profile-history-confirm"
        className="w-full max-w-[420px] rounded-[3px] border border-line-strong bg-surface p-4"
      >
        <h2 id="profile-history-confirm-title" className="text-[15px] font-bold">
          Restore version v{version}
        </h2>
        <p className="mt-1 text-[12px] text-muted">
          {isNewest
            ? `This writes version v${nextVersion}, whose snapshot equals this version's — nothing is rewritten.`
            : `This writes version v${nextVersion}, whose snapshot equals version v${version}'s. The history is append-only, so the restored state is readable again as a new version.`}
        </p>
        {error ? (
          <div className="mt-2">
            <Alert
              state="failed"
              label="FAILED"
              role="alert"
              testid="profile-history-restore-error"
            >
              <span>{error instanceof Error ? error.message : String(error)}</span>
            </Alert>
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="secondary"
            compact
            onClick={onClose}
            data-testid="profile-history-confirm-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            compact
            disabled={restore.isPending}
            onClick={() => void confirm()}
            data-testid="profile-history-restore-submit"
          >
            {restore.isPending ? "Restoring…" : "Restore"}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ProfileHistoryDrawerProps {
  profileId: string;
  version: number;
  onClose: () => void;
}

/** The read-only snapshot drawer for one version. */
function ProfileHistoryDrawer({ profileId, version, onClose }: ProfileHistoryDrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const query = useAgentProfileVersion(profileId, version);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
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
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const entry = query.data;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close version snapshot"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
      />
      <aside
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`version v${version} — read-only snapshot`}
        data-testid="profile-history-drawer"
        className="absolute top-0 right-0 flex h-full w-full flex-col overflow-y-auto border-l border-line bg-paper md:w-[440px]"
      >
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="font-mono text-[11px] font-semibold tracking-wide">v{version}</span>
          <span className="font-mono text-[11px] text-faint">read-only snapshot</span>
          <button
            type="button"
            data-testid="profile-history-drawer-close"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto rounded-[3px] px-1 text-[13px] font-semibold leading-[13px]"
          >
            ×
          </button>
        </header>
        <div className="p-3">
          {entry ? (
            <dl className="space-y-2">
              {snapshotRows(entry).map((row) => (
                <div key={row.label} className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="w-[9rem] font-mono text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                    {row.label}
                  </dt>
                  <dd className="min-w-0 flex-1 break-words font-mono text-[11.5px] text-ink">
                    {row.value}
                  </dd>
                </div>
              ))}
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                <dt className="w-[9rem] font-mono text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                  created
                </dt>
                <dd className="min-w-0 flex-1 break-words font-mono text-[11.5px] text-ink">
                  {entry.created_by} · {formatTime(entry.created_at)}
                </dd>
              </div>
              {entry.note ? (
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <dt className="w-[9rem] font-mono text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                    note
                  </dt>
                  <dd className="min-w-0 flex-1 break-words font-mono text-[11.5px] text-ink">
                    {entry.note}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p
              className="font-mono text-[11px] text-muted"
              data-testid="profile-history-drawer-missing"
            >
              version not available yet — the read has not landed
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
