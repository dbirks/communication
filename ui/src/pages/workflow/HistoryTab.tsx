/**
 * History tab (design 1e): today's REVISIONS and DRAFTS panels, moved here
 * unchanged — immutable published revisions on one side, the mutable drafts
 * on the other, in the server's own newest-first order. The page now opens on
 * the graph; this is the "for when you need them" surface.
 *
 * The one behavior change that follows from the tabs: selecting a revision
 * row no longer drives an inline YAML pane on this page — it deep-links to the
 * YAML tab with `?revision=<digest>`, which is where the document lives now.
 * Draft rows still hand the draft to the Studio route.
 */
import { useState } from "react";
import { Link } from "react-router";
import { Panel } from "../../components/ds/Panel";
import { Row, StatusChip } from "../../components/ds/Row";
import { Button } from "../../components/ds/Button";
import { DRAFT_STATE, REVISION_STATE, stateOf } from "../../components/ds/states";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import type {
  PipelineDraftSummary,
  PipelineRevisionSummary as RevisionSummaryView,
} from "../../lib/pipeline/contract";
import { LIBRARY_AUTHORING_HINT } from "../../lib/pipeline/authoring";
import { shortDigest } from "../../lib/pipeline/yamlPointer";

/** The list collapses to the newest five: test runs leave dozens of
 * same-named rows behind, and a flood of identical rows shows nothing. */
const DRAFT_WINDOW = 5;

export interface WorkflowHistoryTabProps {
  pipelineId: string;
  revisionRows: RevisionSummaryView[];
  revisionsPending: boolean;
  revisionsError: unknown;
  /** Drafts already sorted newest-first by the server's own `updated_at`. */
  sortedDrafts: PipelineDraftSummary[];
  draftsPending: boolean;
  draftsError: unknown;
  canAuthor: boolean;
  createDraftPending: boolean;
  actorName: (userId: string) => string;
  onNewDraft: () => void;
}

export function WorkflowHistoryTab({
  pipelineId,
  revisionRows,
  revisionsPending,
  revisionsError,
  sortedDrafts,
  draftsPending,
  draftsError,
  canAuthor,
  createDraftPending,
  actorName,
  onNewDraft,
}: WorkflowHistoryTabProps) {
  const [draftsExpanded, setDraftsExpanded] = useState(false);
  const visibleDrafts = draftsExpanded ? sortedDrafts : sortedDrafts.slice(0, DRAFT_WINDOW);
  return (
    <div
      className="grid min-w-0 grid-cols-1 items-start gap-[16px] lg:grid-cols-2"
      data-testid="workflow-history"
    >
      <Panel title="REVISIONS" headingId="pipeline-revisions-heading" headingLevel={2}>
        {revisionsPending ? <Spinner label="Loading revisions" /> : null}
        {revisionsError ? (
          <ProblemBanner
            error={revisionsError}
            fallback="This pipeline's revisions could not be read."
          />
        ) : null}
        {revisionRows.length === 0 && !revisionsPending ? (
          <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="revisions-empty">
            never published — a revision exists when a draft validates and publishes
          </p>
        ) : null}
        <ul className="divide-y divide-line" data-testid="revision-list">
          {revisionRows.map((row) => (
            <li key={row.id}>
              <Row className="h-auto flex-wrap border-0 rounded-none px-[10px] py-[8px]">
                <Link
                  to={{
                    pathname: routes.workflowTab(pipelineId, "yaml"),
                    search: `?revision=${encodeURIComponent(row.id)}`,
                  }}
                  className="flex flex-1 flex-wrap items-center gap-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`revision-row-${row.revision_number}`}
                  title="Read this revision's YAML"
                >
                  <StatusChip
                    state={stateOf(REVISION_STATE[row.status])}
                    label={`r${row.revision_number} ${row.version_label}`}
                  />
                  <span className="font-mono text-[10.5px] text-faint">
                    {shortDigest(row.revision_digest)}
                  </span>
                </Link>
              </Row>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel
        title="DRAFTS"
        headingId="pipeline-drafts-heading"
        headingLevel={2}
        meta={
          canAuthor ? (
            <Button
              variant="secondary"
              compact
              onClick={onNewDraft}
              disabled={createDraftPending}
              data-testid="pipeline-new-draft"
              title={
                revisionRows[0]
                  ? "clone the newest published revision"
                  : "no published revision yet — starts from the blank skeleton"
              }
            >
              {createDraftPending ? "Creating…" : "New draft"}
            </Button>
          ) : (
            <span className="font-mono text-[10px] font-normal">{LIBRARY_AUTHORING_HINT}</span>
          )
        }
      >
        {draftsPending ? <Spinner label="Loading drafts" /> : null}
        {draftsError ? (
          <ProblemBanner error={draftsError} fallback="This pipeline's drafts could not be read." />
        ) : null}
        {sortedDrafts.length === 0 && !draftsPending ? (
          <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="drafts-empty">
            no drafts — nothing is being authored on this pipeline right now
          </p>
        ) : null}
        <ul className="divide-y divide-line" data-testid="draft-list">
          {visibleDrafts.map((row) => (
            <li key={row.id}>
              <Row className="h-auto flex-wrap border-0 rounded-none px-[10px] py-[8px]">
                <Link
                  to={routes.draft(pipelineId, row.id)}
                  className="flex flex-1 flex-wrap items-center gap-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`draft-row-${row.id}`}
                >
                  <StatusChip
                    state={stateOf(DRAFT_STATE[row.status])}
                    label={`draft v${row.version}`}
                    labelProps={{ "data-testid": `draft-status-${row.id}` }}
                  />
                  <span className="font-mono text-[10px] text-faint">{row.status}</span>
                  <span
                    className="font-mono text-[10px] text-faint"
                    data-testid={`draft-age-${row.id}`}
                  >
                    {formatAge(row.updated_at)}
                  </span>
                  <span
                    className="font-mono text-[10px] text-faint"
                    data-testid={`draft-edited-by-${row.id}`}
                  >
                    {actorName(row.edited_by)}
                  </span>
                </Link>
              </Row>
            </li>
          ))}
        </ul>
        {sortedDrafts.length > DRAFT_WINDOW ? (
          <button
            type="button"
            onClick={() => setDraftsExpanded((current) => !current)}
            className="block w-full px-[10px] py-[6px] text-left font-mono text-[11px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="draft-list-more"
          >
            {draftsExpanded
              ? `show fewer — ${sortedDrafts.length - DRAFT_WINDOW} hidden`
              : `show ${sortedDrafts.length - DRAFT_WINDOW} more of ${sortedDrafts.length} drafts`}
          </button>
        ) : null}
      </Panel>
    </div>
  );
}
