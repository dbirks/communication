/**
 * VersionsPanel — anchored top-right version history popover (or phone bottom
 * sheet) showing the open draft with its semantic change summary, the live
 * revision with run count, and older immutable revisions with restore/view.
 */
import { useMemo } from "react";
import { IconX } from "@tabler/icons-react";
import { parse } from "yaml";
import type { PipelineRevisionSummary } from "../../lib/pipeline/contract";
import { semanticDiff } from "../../lib/pipeline/semanticDiff";
import { formatAge } from "../../lib/format";

export interface VersionsPanelProps {
  revisions: PipelineRevisionSummary[];
  baseDocument: unknown | null;
  draftText: string;
  hasDraft: boolean;
  viewingDigest: string | null;
  canAuthor: boolean;
  runCountsByDigest?: Map<string, number>;
  actorName: (userId: string) => string;
  onSelectDraft: () => void;
  onSelectRevision: (digest: string) => void;
  onRestoreRevision: (revision: PipelineRevisionSummary) => void;
  onClose: () => void;
  sheet?: boolean;
  restoring?: boolean;
}

export function summarizeDraftChanges(baseDocument: unknown | null, draftText: string): string[] {
  if (baseDocument == null) {
    return ["first revision — nothing live to compare"];
  }
  let parsed: unknown;
  try {
    parsed = parse(draftText);
  } catch {
    return ["YAML has syntax errors"];
  }
  const diff = semanticDiff(baseDocument, parsed);
  if (diff.empty) return ["no changes from live"];
  if (diff.layoutOnly) return ["only layout moved"];
  const lines: string[] = [];
  for (const node of diff.nodes) {
    if (node.change === "added") lines.push(`+ ${node.id}`);
    else if (node.change === "removed") lines.push(`- ${node.id}`);
    else if (node.change === "moved") lines.push(`→ moved ${node.id}`);
    else
      lines.push(
        `~ ${node.id} (${node.fields.length} ${node.fields.length === 1 ? "field" : "fields"})`,
      );
  }
  for (const edge of diff.edges) {
    lines.push(`${edge.change === "added" ? "+" : "-"} ${edge.from} → ${edge.to}`);
  }
  for (const change of diff.pipeline) {
    lines.push(`~ ${change.path}`);
  }
  return lines.slice(0, 6);
}

export function VersionsPanel({
  revisions,
  baseDocument,
  draftText,
  hasDraft,
  viewingDigest,
  canAuthor,
  runCountsByDigest,
  actorName,
  onSelectDraft,
  onSelectRevision,
  onRestoreRevision,
  onClose,
  sheet = false,
  restoring = false,
}: VersionsPanelProps) {
  const changeLines = useMemo(
    () => (hasDraft ? summarizeDraftChanges(baseDocument, draftText) : []),
    [hasDraft, baseDocument, draftText],
  );
  const liveRevision = revisions.find((r) => r.status === "published") ?? null;

  const containerClass = sheet
    ? "w-full rounded-t-[18px] rounded-b-none border-t border-line bg-surface shadow-[var(--shadow-modal)] max-h-[75dvh] overflow-y-auto"
    : "w-[304px] rounded-[12px] border border-line bg-surface shadow-[var(--shadow-pop)] max-h-[calc(100dvh-140px)] overflow-y-auto";

  return (
    <section
      data-testid="versions-panel"
      aria-label="Versions"
      className={`flex flex-col ${containerClass}`}
    >
      <div className="flex items-center border-b border-line-soft px-[16px] py-[14px]">
        <h2 className="text-[14px] font-bold text-ink">Versions</h2>
        <button
          type="button"
          aria-label="Close versions"
          data-testid="versions-panel-close"
          onClick={onClose}
          className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <IconX size={16} stroke={1.5} aria-hidden />
        </button>
      </div>

      <div className="relative flex flex-col gap-[16px] px-[16px] pb-[18px] pt-[14px]">
        {(hasDraft ? 1 : 0) + revisions.length > 1 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[24px] left-[20.5px] top-[24px] w-px bg-line"
          />
        ) : null}

        {hasDraft ? (
          <div className="relative flex gap-[12px]" data-testid="versions-row-draft">
            <span
              aria-hidden="true"
              className="relative z-1 mt-[4px] h-[10px] w-[10px] shrink-0 rounded-full bg-st-waiting-strong"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
              <button
                type="button"
                onClick={onSelectDraft}
                data-testid="versions-select-draft"
                className={`text-left text-[13.5px] font-bold focus-visible:outline-2 focus-visible:outline-accent ${
                  viewingDigest === null ? "text-accent-edge" : "text-ink hover:text-accent-text"
                }`}
              >
                Your draft <span className="font-normal text-muted">· now</span>
              </button>
              {changeLines.map((line, i) => (
                <span key={i} className="truncate font-mono text-[11.5px] text-ink-2" title={line}>
                  {line}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {revisions.length === 0 && !hasDraft ? (
          <p className="text-[12.5px] text-muted" data-testid="versions-empty">
            No published revisions yet.
          </p>
        ) : null}

        {revisions.map((rev) => {
          const isLive = liveRevision?.revision_digest === rev.revision_digest;
          const isViewing = viewingDigest === rev.revision_digest;
          const runCount = runCountsByDigest?.get(rev.revision_digest);
          const metaParts = [actorName(rev.published_by), formatAge(rev.published_at)];
          if (typeof runCount === "number") {
            metaParts.push(`ran ${runCount} ${runCount === 1 ? "time" : "times"}`);
          }
          return (
            <div
              key={rev.revision_digest}
              className="relative flex gap-[12px]"
              data-testid={`versions-row-v${rev.revision_number}`}
            >
              <span
                aria-hidden="true"
                className={`relative z-1 mt-[4px] h-[10px] w-[10px] shrink-0 rounded-full ${
                  isLive ? "bg-st-done-strong" : "border-[1.5px] border-line-strong bg-surface"
                }`}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex items-center gap-[6px]">
                  <button
                    type="button"
                    onClick={() => onSelectRevision(rev.revision_digest)}
                    data-testid={`versions-select-v${rev.revision_number}`}
                    className={`text-left text-[13.5px] font-bold focus-visible:outline-2 focus-visible:outline-accent ${
                      isViewing ? "text-accent-edge" : "text-ink hover:text-accent-text"
                    }`}
                  >
                    v{rev.revision_number}
                  </button>
                  {isLive ? (
                    <span className="rounded-[2px] bg-st-done-tag px-[5px] py-[1px] font-mono text-[10px] font-semibold text-st-done-tag-fg">
                      LIVE
                    </span>
                  ) : null}
                </div>
                <span className="text-[12.5px] text-muted">{metaParts.join(" · ")}</span>
                {canAuthor ? (
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={() => onRestoreRevision(rev)}
                    data-testid={`versions-restore-v${rev.revision_number}`}
                    className="mt-[2px] w-fit text-left text-[12px] font-semibold text-accent-text hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Restore as draft
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
