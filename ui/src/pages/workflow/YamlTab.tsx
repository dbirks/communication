/**
 * YAML tab (design 2d): the selected revision's regenerated canonical text,
 * block style everywhere, line numbers, `copy · download`. The revision is
 * picked here (the History tab's rows deep-link into this tab with
 * `?revision=<digest>`); a published revision is immutable, so the panel is
 * read-only by decision — edits go through a draft (the `YamlView` header says
 * as much).
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { YamlView } from "../../components/workflows/YamlView";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { useRevision, useRevisionDocument } from "../../api/pipelines";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import type { UsedInRevision } from "../../components/workflows/UsedIn";

export interface YamlTabProps {
  slug: string;
  /** The pipeline's revision summaries, newest first (server order). */
  revisions: UsedInRevision[];
}

export function WorkflowYamlTab({ slug, revisions }: YamlTabProps) {
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
          <span className="font-mono text-[10.5px] text-faint" data-testid="yaml-tab-label">
            {`r${revision.data.revision_number} · ${revision.data.version_label} · ${shortDigest(revision.data.revision_digest)} · regenerated canonical`}
          </span>
        ) : null}
      </div>
      {revision.isError ? (
        <ProblemBanner error={revision.error} fallback="The selected revision could not be read." />
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
    </div>
  );
}
