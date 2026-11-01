/**
 * YAML tab (design 2d): the selected revision's regenerated canonical text,
 * block style everywhere, line numbers, `Copy · Download`. The revision is
 * picked here (the History tab's rows deep-link into this tab with
 * `?revision=<digest>`); a published revision is immutable, so the panel is
 * read-only by decision — edits go through a draft (the `YamlView` header says
 * as much).
 */
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { YamlView } from "../../components/workflows/YamlView";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { useRevision, useRevisionDocument } from "../../api/pipelines";
import type { UsedInRevision } from "../../components/workflows/UsedIn";

export interface YamlTabProps {
  slug: string;
  /** The pipeline's revision summaries, newest first (server order). */
  revisions: UsedInRevision[];
  /**
   * The `Validate a YAML document` disclosure, owned by the page (it is the
   * authoring surface, so the page decides who sees it). The tab draws it only
   * over a revision it actually read: with the read broken there is no document
   * to validate against, and a disclosure that opens onto a panel of a thing
   * that failed to load is a second failure wearing the first one's clothes
   * (pass-8 review, item 4).
   */
  validate?: ReactNode;
}

export function WorkflowYamlTab({ slug, revisions, validate }: YamlTabProps) {
  // A `?revision=<digest>` from a History row seeds the selection; the newest
  // revision is the default (the server's own newest-first order, never
  // re-sorted here).
  const [searchParams] = useSearchParams();
  const seeded = searchParams.get("revision");
  const [picked, setPicked] = useState<string | null>(null);
  const selectedKey = useMemo(() => {
    const wanted = picked ?? seeded;
    if (wanted && revisions.some((row) => row.id === wanted)) return wanted;
    return revisions[0]?.id ?? null;
  }, [picked, seeded, revisions]);

  const revision = useRevision(selectedKey ?? "");
  const document = useRevisionDocument(selectedKey ?? "");

  if (revisions.length === 0) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="yaml-empty">
        never published — a revision exists when a draft validates and publishes; until then the
        draft document lives in the Studio
      </p>
    );
  }

  const text = document.data ?? revision.data?.document_text;
  return (
    <div className="space-y-[8px]" data-testid="workflow-yaml-tab">
      <div className="flex flex-wrap items-center gap-[8px]">
        <label
          htmlFor="yaml-revision-select"
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          revision
        </label>
        <select
          id="yaml-revision-select"
          value={selectedKey ?? ""}
          onChange={(event) => setPicked(event.target.value)}
          className="rounded-[3px] border border-line-strong bg-surface px-[8px] py-[3px] font-mono text-[11.5px] focus-visible:border-ink focus-visible:outline-none"
          data-testid="yaml-revision-select"
        >
          {revisions.map((row) => (
            <option key={row.id} value={row.id}>
              {`r${row.revision_number} · ${row.version_label}${
                row.status === "published" ? "" : ` · ${row.status}`
              }`}
            </option>
          ))}
        </select>
        {revision.data ? (
          // Plain provenance, not a digest (2026-10-30 copy review, 2d item 3):
          // the line used to read `r1 · 1.0.0 · c75e31850724 · regenerated
          // canonical`, which is three facts about the server's object and one
          // word a person does not use. What the reader needs is that this text
          // was GENERATED from the revision in the select, not hand-typed.
          <span className="text-[11px] text-muted" data-testid="yaml-tab-label">
            {`generated from revision r${revision.data.revision_number} · ${revision.data.version_label}`}
          </span>
        ) : null}
      </div>
      {revision.isError ? (
        // The app's ONE load-failure treatment (pass-8 review, item 4): the
        // shared `Couldn't load …` block with the `Retry` this read supports,
        // not a bare `FAILED` callout quoting a problem document — `FAILED` is
        // a run's status word, and a callout with no way out is the 2026-10-30
        // review's complaint about every screen that had one. The server's own
        // problem document sits collapsed behind the block's `Details`
        // disclosure (error-details-r6).
        <ProblemBanner
          error={revision.error}
          fallback="The selected revision could not be read."
          subject="this revision's document"
          hint="The YAML stays empty until the revision loads."
          retry={{
            onClick: () => void revision.refetch(),
            pending: revision.isFetching,
            testid: "yaml-revision-retry",
          }}
          testid="yaml-revision-error"
        />
      ) : null}
      {revision.isPending && !revision.data ? (
        <Spinner label="Loading the revision document" />
      ) : null}
      {revision.data && text !== undefined ? (
        <YamlView
          text={text}
          filename={`${slug}-r${revision.data.revision_number}.yaml`}
          testId="yaml-view"
        />
      ) : null}
      {/* The disclosure only stands with a revision that loaded (see the prop's
          note); the author's line is otherwise a door onto a failed read. */}
      {revision.isError ? null : validate}
    </div>
  );
}
