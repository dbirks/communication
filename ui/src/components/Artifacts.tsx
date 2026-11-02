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
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { problemOf } from "../api/client";
import { useCreatePreviewToken } from "../api/queries";
import {
  downloadBlockedReason,
  isHtml,
  isMarkdown,
  isSmallTextArtifact,
  mediaTypeWords,
  previewBlockReason,
  PREVIEW_SANDBOX,
  redactionCopy,
  resolvePreviewUrl,
  sensitivityCopy,
} from "../api/artifacts";
import { useArtifactContent } from "../api/approvals";
import type { Artifact, PreviewToken } from "../api/types";
import { MarkdownBody } from "../lib/markdown";
import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";
import { Panel } from "./ds/Panel";
import { StatusChip } from "./ds/Row";
import { ARTIFACT_STATE, SENSITIVITY_STATE, stateOf } from "./ds/states";
import { Spinner } from "./Feedback";
import { formatAge, formatBytes, formatTime, shortId } from "../lib/format";
import { shortDigest } from "../lib/pipeline/yamlPointer";
import { routes } from "../lib/routes";

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
          absent.
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
    // A small Markdown file is READ here (round-2 review item 4): the artifact
    // page used to tell everyone to download `plan.md` while the app already
    // owns a markdown reader (`lib/markdown.tsx`) — and that reader emits React
    // text nodes, never HTML, so ADR-0020's rule (this origin never executes
    // artifact bytes) is untouched. Anything else stays a download, said in the
    // media's own name rather than its wire string.
    if (isMarkdown(artifact) && isSmallTextArtifact(artifact)) {
      return <MarkdownArtifactBody artifact={artifact} />;
    }
    return (
      <p className="text-[12.5px] text-muted" data-testid="artifact-preview-unavailable">
        Only HTML previews in a frame of its own and small Markdown files are read below. This one
        is {mediaTypeWords(artifact.media_type, artifact.name)} — download it instead.
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
          preview must come from another hostname — that is what removes the session cookie.
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * The in-page read of a small Markdown artifact. The bytes come from
 * `…/content` — the same role-gated read the Download link navigates to — and
 * `lib/markdown.tsx` turns them into React text nodes: headings, lists, code
 * spans and emphasis, and never an HTML element, so the app's origin still
 * cannot run anything the artifact contains (`ADR-0020`).
 *
 * What the bytes say they are is read first and printed second
 * (`artifactBodyDocument`): the pass-1 review's `artifact-plan-md-1280.png` was
 * the model's answer envelope — `{"endpoint":…, "model":…, "text":"\n\n# Plan…"}`
 * — fenced inside a cover note, so the reader saw escaped markdown and API
 * fields where the plan should have been, and the note was written for whoever
 * runs the worker.
 */
function MarkdownArtifactBody({ artifact }: { artifact: Artifact }) {
  const content = useArtifactContent(artifact.id);

  if (content.isPending) return <Spinner label="Reading the document" />;

  if (content.isError || typeof content.data !== "string") {
    return (
      <p className="text-[12.5px] text-muted" data-testid="artifact-preview-unavailable">
        ! The text did not come back over the same role-gated read as the download, so it is not
        shown — download it to read the bytes.
      </p>
    );
  }

  return <ArtifactMarkdownBody artifact={artifact} source={content.data} />;
}

/** What the bytes of a text artifact hold: the document to read, and the payload
 * that produced it when the document is wrapped in one. */
export interface ArtifactBodyDocument {
  /** The markdown to show: the author's own words, unwrapped. */
  markdown: string;
  /** The stored payload behind “Show raw”, or null when the body IS the document. */
  raw: string | null;
  /** The step that published this, read off the worker's byline; null when the
   * artifact carries no such line. */
  publishedBy: string | null;
}

/** The worker's own byline (`worker/artifactpublish.go`'s `renderMarkdownDoc`):
 * `Published by pipeline node \`publish_plan\` (instance \`/publish_plan\`, attempt
 * 1) via \`artifact.publish\`.` The node's name is the only part a reader can use,
 * so the pattern keeps it and drops the instance key, the attempt and the kind. */
const PUBLISHED_BY = /^[ \t]*Published by pipeline node `?([A-Za-z0-9_./-]+)`?[^\n]*$/m;
/** A ``` fence (any info string) whose body may or may not be JSON — the bytes
 * decide, not the author's label. */
const A_FENCE = /^[ \t]*```[^\n]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

/**
 * The envelope's `text`, out of either packaging: the body is the JSON, or the
 * body is a document holding the JSON in a fence.
 */
function unwrapModelText(body: string): { markdown: string; raw: string | null } {
  A_FENCE.lastIndex = 0;
  for (let match = A_FENCE.exec(body); match !== null; match = A_FENCE.exec(body)) {
    const inner = modelChatText(match[1]);
    if (inner === null) continue;
    const markdown = `${body.slice(0, match.index)}${inner}${body.slice(
      match.index + match[0].length,
    )}`;
    return { markdown: collapseBlankLines(markdown), raw: match[1].trim() };
  }
  const whole = modelChatText(body);
  if (whole !== null) return { markdown: collapseBlankLines(whole), raw: body.trim() };
  return { markdown: body, raw: null };
}

/**
 * Read the artifact's text as the document it is.
 *
 * A `model.chat` node answers `{endpoint, model, text}`, and a pipeline that
 * publishes that answer verbatim stores the envelope as an artifact (and
 * `artifact.publish` wraps a `kind=markdown` payload in a title, a byline and a
 * fenced JSON block — `worker/artifactpublish.go`). A `text` field holding a
 * string is then the author's document wearing two layers of packaging, and the
 * reader came for the document:
 *
 * - the envelope's `text` becomes the shown markdown, whether the envelope IS
 *   the body or sits in the body's ```json fence;
 * - the stored payload stays reachable under “Show raw” (never silently dropped
 *   — the endpoint and model are facts about the answer);
 * - the byline becomes the `publishedBy` words the screen owns, rather than a
 *   sentence about instance keys and node kinds.
 *
 * Anything else — a real markdown document, a JSON report with no `text`, a log
 * — is returned as it came in, so this rule cannot eat an artifact it does not
 * recognise.
 */
export function artifactBodyDocument(source: string): ArtifactBodyDocument {
  const text = source ?? "";
  const publishedByMatch = PUBLISHED_BY.exec(text);
  const publishedBy = publishedByMatch ? publishedByMatch[1].trim() : null;
  const withoutByline = publishedByMatch
    ? `${text.slice(0, publishedByMatch.index)}${text.slice(
        publishedByMatch.index + publishedByMatch[0].length,
      )}`
    : text;

  const unwrapped = unwrapModelText(withoutByline);
  let markdown = unwrapped.markdown;
  if (publishedBy !== null && unwrapped.raw !== null) {
    // Both told: the byline AND an envelope in a fence. That pair is only ever
    // written by `artifact.publish`, so the whole document is its wrapper — and
    // the wrapper's own title heading repeats the artifact's name, which the page
    // already prints as its H1 (`plan.md`). The reader's document starts at the
    // author's first line.
    markdown = markdown.replace(/^[ \t]*#{1,6}[ \t]+[^\n]*\n+/, "");
  }
  return {
    markdown,
    raw: unwrapped.raw,
    publishedBy,
  };
}

/**
 * The `text` of a `model.chat` answer envelope, or null when this is not one.
 *
 * The envelope is an object with a string `text` — that is the whole test, and
 * deliberately not the endpoint or the model name: a JSON artifact whose body
 * happens to carry a `text` field is still a document whose words are the
 * `text`, and the rest of it stays one click away under “Show raw”.
 */
function modelChatText(value: string): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed.startsWith("{") || !/"text"\s*:/.test(trimmed)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const candidate = (parsed as Record<string, unknown>).text;
  return typeof candidate === "string" ? candidate : null;
}

/** The unwrapped text arrives with the packaging's blank lines; the reader has
 * the document, not the envelope, so two in a row are one. */
function collapseBlankLines(markdown: string): string {
  return markdown.replace(/^\n+/, "\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The “Show raw” arm. `width:0` + `min-width:100%` is the point: the JSON's lines
 * are long and unbroken, and a box with a definite width contributes nothing to
 * an ancestor's max-content size, so the payload stays inside its own box at 390
 * instead of pushing the page sideways off the screen (`artifact-plan-md-390.png`).
 * The payload then *wraps* inside that box (`whitespace-pre-wrap` +
 * `[overflow-wrap:anywhere]`): a stored "text" value is one line thousands of
 * characters long, and cutting it at the right edge mid-word with no sign of a
 * sideways scrollbar loses the rest of it. Vertical scrolling (`max-h-64` +
 * `overflow-auto`) is kept for long payloads.
 */
function RawPayload({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  const contentId = "artifact-preview-raw-payload";
  return (
    <div data-testid="artifact-raw-block">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex items-center gap-[6px] font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid="artifact-raw-toggle"
      >
        <span aria-hidden>{open ? "\u25be" : "\u25b8"}</span>
        {open ? "hide raw payload" : "show raw payload"}
      </button>
      <pre
        id={contentId}
        hidden={!open}
        role="region"
        tabIndex={0}
        aria-label="stored artifact bytes (raw)"
        style={{ width: 0, minWidth: "100%" }}
        className="mt-[4px] max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[16px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid="artifact-preview-raw"
      >
        {raw}
      </pre>
    </div>
  );
}

/** The document, its byline in the reader's words, and the payload behind a toggle. */
function ArtifactMarkdownBody({ artifact, source }: { artifact: Artifact; source: string }) {
  const doc = useMemo(() => artifactBodyDocument(source), [source]);
  return (
    <div
      className="min-w-0 space-y-[10px] rounded-[3px] border border-line bg-surface p-[10px]"
      data-testid="artifact-preview-markdown"
    >
      {doc.publishedBy ? <PublishedBy artifact={artifact} step={doc.publishedBy} /> : null}
      {/* The document on its own, so “what the reader sees” and “what is stashed
       * behind the toggle” are two different things a test (or a screen reader)
       * can name. */}
      <div className="min-w-0" data-testid="artifact-preview-prose">
        <MarkdownBody text={doc.markdown} />
      </div>
      {doc.raw !== null ? <RawPayload raw={doc.raw} /> : null}
    </div>
  );
}

/**
 * Who made this, in words. The generator's own line names a node instance key
 * and an internal publish kind (`instance /publish_plan, attempt 1 via
 * artifact.publish`), which is the worker's log, not the reader's sentence. What
 * a reader can act on is the step and the run it ran in — and the run is the
 * link, because “which run?” is the next question.
 */
function PublishedBy({ artifact, step }: { artifact: Artifact; step: string }) {
  if (!artifact.run_id) {
    return (
      <p className="text-[12.5px] leading-[18px] text-ink-2" data-testid="artifact-published-by">
        Published by the <code className="font-mono">{step}</code> step of this run.
      </p>
    );
  }
  return (
    <p
      className="text-[12.5px] leading-[18px] text-ink-2"
      data-testid="artifact-published-by"
      title={`published by the ${step} step`}
    >
      Published by the{" "}
      <code className="rounded-[2px] bg-fill px-[3px] font-mono text-[.94em]">{step}</code> step of
      run{" "}
      <Link
        to={routes.run(artifact.run_id)}
        className="text-accent-text underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid="artifact-published-run-link"
      >
        {shortId(artifact.run_id)}
      </Link>
    </p>
  );
}

export interface ArtifactDetailProps {
  artifact: Artifact;
  /** Words for who created it; a worker id is not readable on its own. */
  createdByName: (createdBy: string) => string;
  /**
   * Words for *when* it was created. Defaults to the wall-clock stamp; a screen
   * that lives beside the rest of the app passes the relative form the artifact
   * rows already use (`3m ago`), and the stamp stays in the value's `title`.
   */
  createdLabel?: (artifact: Artifact) => string;
  currentOrigin?: string;
}

/** The artifact detail panel: metadata, download, preview (`/artifacts/:id`). */
export function ArtifactDetail({
  artifact,
  createdByName,
  createdLabel = (row) => formatTime(row.created_at),
  currentOrigin,
}: ArtifactDetailProps) {
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
            {/* Pass-2 review (`artifact-plan-md`): `kind markdown` over `media
                Markdown` said the same fact twice, once in the wire's enum and
                once in the reader's words. The reader's row stays — it carries
                the wire value in its `title`, one hover from an API call. */}
            <div className="flex gap-2">
              <dt className="text-muted">media</dt>
              {/* `text/markdown` is what the server records; Markdown is what the
                  reader calls it (round-2 review item 4). The wire value stays
                  one hover away — it is the string to paste at an API. */}
              <dd title={artifact.media_type} data-testid="artifact-media-type">
                {mediaTypeWords(artifact.media_type, artifact.name)}
              </dd>
            </div>
            <DigestRow sha256={artifact.sha256} />
            <div className="flex gap-2">
              <dt className="text-muted">size</dt>
              <dd data-testid="artifact-size">{formatBytes(artifact.size_bytes)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">sensitivity</dt>
              <dd data-testid="artifact-sensitivity">{sensitivityCopy(artifact.sensitivity)}</dd>
            </div>
            <div className="flex gap-2">
              {/* The copy spells the scanner into its sentence ("scanner
                  changed nothing"), so the key says "redaction": a
                  "scanner" key paired with that value read "scanner
                  scanner changed nothing", a doubled word (pass-1
                  review, this brief). */}
              <dt className="text-muted">redaction</dt>
              <dd data-testid="artifact-redaction">{redactionCopy(artifact.redaction_count)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">created</dt>
              {/* Relative by default on the page that sits next to every other
               * relative time; the exact stamp one hover away. */}
              <dd title={formatTime(artifact.created_at)} data-testid="artifact-created-at">
                {createdLabel(artifact)}
              </dd>
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
                to={routes.thread(artifact.conversation_id)}
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
 * The content digest, in the reader's measure (pass-2 review, `artifact-plan-
 * md`): a bare 64-character hex string in the primary metadata is not a fact a
 * person can compare — it is the wire's column width on the page. The value
 * keeps its honest shape: a 12-char prefix with the ellipsis that says the
 * value is longer (the same spelling `shortDigest` gives run digests app-wide),
 * the full digest in the `title` for a visual compare, and a copy button for
 * the paste — so the whole value is one click away, and only the part a reader
 * can actually read sits in the line. jsdom has no clipboard and non-secure
 * contexts lack it too, so the write is guarded and the button degrades to a
 * no-op (the `ProfileDetail` digest block's rule).
 */
function DigestRow({ sha256 }: { sha256: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(sha256).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted">sha256</dt>
      <dd className="flex min-w-0 items-center gap-[6px]" data-testid="artifact-sha256">
        {/* The full 64 chars are the `title` — the string to compare byte-for
            byte against the library's digests. */}
        <span title={sha256}>
          {shortDigest(sha256)}
          <span aria-hidden="true">…</span>
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Digest copied" : "Copy the full sha256 digest"}
          className="shrink-0 rounded-[2px] border border-line px-[5px] py-[1px] text-[10px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="artifact-sha256-copy"
        >
          {copied ? "copied" : "copy"}
        </button>
      </dd>
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
