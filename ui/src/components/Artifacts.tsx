/**
 * Artifacts: the index rows the API serializes, plus the only two ways to touch
 * bytes — download (`…/content`, which the server answers with `nosniff` and,
 * for HTML, as an attachment) and preview (an `<iframe sandbox>` pointed at the
 * server's absolute `preview_url` on the separate preview origin).
 *
 * Nothing here can render artifact HTML on the app origin: the frame is only
 * ever created from `resolvePreviewUrl()`, which returns null for a relative or
 * same-origin URL, and the token is held in this component's state only — never
 * in the query cache, never in a log line (ADR-0020 D5).
 */
import { useState } from "react";
import { Link } from "react-router";
import { problemOf } from "../api/client";
import { useCreatePreviewToken } from "../api/queries";
import {
  downloadBlockedReason,
  isHtml,
  previewBlockReason,
  PREVIEW_SANDBOX,
  redactionCopy,
  resolvePreviewUrl,
  sensitivityCopy,
} from "../api/artifacts";
import type { Artifact, PreviewToken } from "../api/types";
import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";
import { Panel } from "./ds/Panel";
import { StatusChip } from "./ds/Row";
import { ARTIFACT_STATE, SENSITIVITY_STATE, stateOf } from "./ds/states";
import { Spinner } from "./Feedback";
import { formatAge, formatBytes, formatTime, shortId } from "../lib/format";

/** One artifact row (`⟨T:artifact-row-*⟩`). Metadata only; bytes are never here. */
export function ArtifactRow({ artifact }: { artifact: Artifact }) {
  return (
    <Link
      to={`/artifacts/${artifact.id}`}
      className="flex h-[34px] w-full items-center gap-[9px] rounded-[3px] border border-line bg-surface px-[10px] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      data-testid={`artifact-row-${artifact.name}`}
    >
      <StatusChip
        state={stateOf(ARTIFACT_STATE[artifact.state])}
        label={artifact.state}
        labelProps={{ "data-testid": `artifact-state-${artifact.id}` }}
      />
      <span className="truncate text-[12.5px] font-semibold">{artifact.name}</span>
      <span className="font-mono text-[10.5px] text-muted">{artifact.kind}</span>
      <span className="font-mono text-[10.5px] text-muted">{formatBytes(artifact.size_bytes)}</span>
      <span className="font-mono text-[10.5px]" data-testid={`artifact-sensitivity-${artifact.id}`}>
        {artifact.sensitivity}
      </span>
      <span className="ml-auto font-mono text-[10.5px] text-faint">
        {formatAge(artifact.created_at)} ago
      </span>
    </Link>
  );
}

export interface ArtifactsPanelProps {
  title?: string;
  headingId?: string;
  headingLevel?: 2 | 3;
  artifacts: Artifact[];
  /** Empty-state copy; the reason differs per screen. */
  emptyCopy?: string;
  className?: string;
}

/** A list of artifact rows in a CARD-L panel. */
export function ArtifactsPanel({
  title = "ARTIFACTS",
  headingId = "artifacts-heading",
  headingLevel = 2,
  artifacts,
  emptyCopy = "No artifacts yet — agents publish them when a unit produces evidence.",
  className = "",
}: ArtifactsPanelProps) {
  return (
    <Panel
      id="artifacts"
      title={title}
      headingId={headingId}
      headingLevel={headingLevel}
      meta={artifacts.length ? `${artifacts.length} shown` : undefined}
      className={className}
    >
      <div className="space-y-[4px] p-[10px]">
        {artifacts.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="artifact-list-empty">
            {emptyCopy}
          </p>
        ) : (
          <ul className="space-y-[4px]" data-testid="artifact-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <ArtifactRow artifact={artifact} />
              </li>
            ))}
          </ul>
        )}
        <p className="font-mono text-[10.5px] text-faint">
          sensitivity is filtered server-side: a row you cannot see is not hidden from you, it is
          absent (ADR-0020 §3).
        </p>
      </div>
    </Panel>
  );
}

export interface ArtifactPreviewProps {
  artifact: Artifact;
  /**
   * This app's own origin. Injectable for tests; defaults to the live document,
   * because the same-origin check is not optional — it is the entire mechanism
   * that keeps a session cookie out of a preview frame.
   */
  currentOrigin?: string;
}

/**
 * The preview frame for HTML artifacts: mint on demand, hold the token in
 * component state, drop it when the frame is closed.
 */
export function ArtifactPreview({ artifact, currentOrigin }: ArtifactPreviewProps) {
  const mint = useCreatePreviewToken();
  const [preview, setPreview] = useState<PreviewToken | null>(null);
  const blocked = previewBlockReason(artifact);
  const html = isHtml(artifact);
  const ownOrigin =
    currentOrigin ?? (typeof window === "undefined" ? undefined : window.location.origin);
  const src = preview ? resolvePreviewUrl(preview, ownOrigin) : null;

  if (blocked) {
    // Checked before the media type: a sensitivity or lifecycle refusal is the
    // stronger fact, and "only HTML previews" would hide it.
    return (
      <p className="text-[12.5px] text-muted" data-testid="artifact-preview-blocked">
        ! {blocked}
      </p>
    );
  }
  if (!html) {
    return (
      <p className="text-[12.5px] text-muted" data-testid="artifact-preview-unavailable">
        Only HTML artifacts preview. This one is {artifact.media_type} — download it instead.
      </p>
    );
  }

  if (src) {
    return (
      <div className="space-y-2" data-testid="artifact-preview-panel">
        <Alert
          state="waiting"
          label="ISOLATED FRAME"
          testid="artifact-preview-warning"
          meta={preview ? `token expires ${formatTime(preview.expires_at)}` : undefined}
          action={
            <Button
              variant="secondary"
              compact
              data-testid="artifact-preview-close"
              onClick={() => {
                // Forget the credential rather than leave it in the DOM.
                setPreview(null);
                mint.reset();
              }}
            >
              Close preview
            </Button>
          }
        >
          Rendered in a sandboxed frame on another origin, with no script allowance. It cannot read
          this app&apos;s cookies or storage, and the content is untrusted agent output.
        </Alert>
        {/* `sandbox=""` grants nothing: no scripts, no same-origin, no forms, no
            top navigation. `allow-scripts` would break case 16 by design. */}
        <iframe
          title={`Preview of ${artifact.name}`}
          data-testid="artifact-preview-frame"
          src={src}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="h-[420px] w-full rounded-[3px] border border-line-strong bg-surface"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[12.5px] text-muted">
        Previewing runs the artifact&apos;s own HTML, so it happens in an isolated frame on the
        preview origin — never here. Minting the token is recorded as an access.
      </p>
      <Button
        variant="primary"
        data-testid="artifact-preview-open"
        disabled={mint.isPending}
        onClick={() => mint.mutate(artifact.id, { onSuccess: setPreview })}
      >
        {mint.isPending ? "Minting…" : "Open preview"}
      </Button>
      {mint.error ? (
        <Alert state="failed" label="FAILED" role="alert" testid="artifact-preview-error">
          {problemOf(mint.error).detail || "No preview token was issued, so nothing was rendered."}
        </Alert>
      ) : null}
      {!mint.error && mint.isSuccess && !src ? (
        <Alert state="failed" label="REFUSED" role="alert" testid="artifact-preview-origin-refused">
          The preview URL the API returned is not a different origin, so it was not embedded. A
          preview must come from another hostname — that is what removes the session cookie
          (ADR-0020 D6).
        </Alert>
      ) : null}
    </div>
  );
}

export interface ArtifactDetailProps {
  artifact: Artifact;
  /** Words for who created it; a worker id is not readable on its own. */
  createdByName: (createdBy: string) => string;
  currentOrigin?: string;
}

/** The artifact detail panel: metadata, download, preview (`/artifacts/:id`). */
export function ArtifactDetail({ artifact, createdByName, currentOrigin }: ArtifactDetailProps) {
  const downloadBlocked = downloadBlockedReason(artifact.sensitivity);
  const state = stateOf(ARTIFACT_STATE[artifact.state]);
  const ready = artifact.state === "ready";

  return (
    <div className="space-y-4">
      <Panel
        title="ARTIFACT"
        headingId="artifact-heading"
        headingLevel={2}
        state={artifact.state === "orphan" ? "failed" : undefined}
        meta={
          <StatusChip
            state={state}
            label={artifact.state}
            labelProps={{ "data-testid": `artifact-state-${artifact.id}` }}
          />
        }
      >
        <div className="space-y-2 p-[10px]">
          <h3 id="artifact-name" className="text-title-l font-bold" data-testid="artifact-title">
            {artifact.name}
          </h3>
          <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-muted">kind</dt>
              <dd>{artifact.kind}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">media</dt>
              <dd>{artifact.media_type}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">sha256</dt>
              <dd className="break-all" data-testid="artifact-sha256">
                {artifact.sha256}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">size</dt>
              <dd data-testid="artifact-size">{formatBytes(artifact.size_bytes)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">sensitivity</dt>
              <dd data-testid="artifact-sensitivity">{sensitivityCopy(artifact.sensitivity)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">scanner</dt>
              <dd data-testid="artifact-redaction">{redactionCopy(artifact.redaction_count)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">created</dt>
              <dd>{formatTime(artifact.created_at)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">by</dt>
              {/* `worker` is a role, not a person; a user id becomes a display name
                  through the actor directory (`createdByName`). */}
              <dd data-testid="artifact-created-by">{createdByName(artifact.created_by)}</dd>
            </div>
            {artifact.expires_at ? (
              <div className="flex gap-2">
                <dt className="text-muted">expires</dt>
                <dd>{formatTime(artifact.expires_at)}</dd>
              </div>
            ) : null}
            {artifact.turn_id ? (
              <div className="flex gap-2">
                <dt className="text-muted">turn</dt>
                <dd data-testid="artifact-turn">{shortId(artifact.turn_id)}</dd>
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {downloadBlocked || !ready ? (
              <span
                className="text-[12.5px] text-muted"
                data-testid="artifact-download-unavailable"
              >
                !{" "}
                {downloadBlocked ??
                  `this artifact is ${artifact.state}, so there is nothing to download`}
              </span>
            ) : (
              // A real navigation, not a fetch: the server sets
              // `Content-Disposition: attachment` for HTML precisely so this
              // cannot execute in the app's origin (case 16).
              <a
                href={`/api/v1/artifacts/${artifact.id}/content`}
                className="ds-btn ds-btn--primary inline-flex h-[30px] items-center rounded-[4px] px-3"
                data-testid="artifact-download"
              >
                Download
              </a>
            )}
            {artifact.conversation_id ? (
              <Link
                to={`/projects/${artifact.project_id}/conversations/${artifact.conversation_id}`}
                className="font-mono text-[11px] text-accent-text hover:text-ink"
                data-testid="artifact-conversation-link"
              >
                from conversation {shortId(artifact.conversation_id)}
              </Link>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel title="PREVIEW" headingId="artifact-preview-heading" headingLevel={2}>
        <div className="p-[10px]">
          <ArtifactPreview artifact={artifact} currentOrigin={currentOrigin} />
        </div>
      </Panel>
      <StatusChipForSensitivity artifact={artifact} />
    </div>
  );
}

/**
 * A standing note about sensitivity on the detail screen. `restricted` rows are
 * listed but never served to everyone, and the screen says it before anyone
 * clicks.
 */
function StatusChipForSensitivity({ artifact }: { artifact: Artifact }) {
  if (artifact.sensitivity === "standard") return null;
  return (
    <Alert
      state={stateOf(SENSITIVITY_STATE[artifact.sensitivity])}
      label={artifact.sensitivity.toUpperCase()}
      testid="artifact-sensitivity-note"
    >
      {sensitivityCopy(artifact.sensitivity)}
    </Alert>
  );
}

/** Loading/error states shared by the artifact screens. */
export function ArtifactListFallback({ error }: { error: unknown }) {
  if (!error) return <Spinner label="Loading artifacts" />;
  return (
    <Alert state="failed" label="FAILED" role="alert" testid="artifact-list-error">
      {problemOf(error).detail || "Artifacts could not be loaded."}
    </Alert>
  );
}
