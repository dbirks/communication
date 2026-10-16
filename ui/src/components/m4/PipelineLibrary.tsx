/**
 * The pipeline library list (`10`'s Pipeline Library).
 *
 * A row is a *pipeline*, and the three facts that matter on it are separate:
 * the newest published revision, what the project's channels point at, and the
 * state of anyone's draft. `01`: an org member may see definitions but never
 * author one, and `pinned_revision_id` is what an assignment actually runs —
 * a "latest" label would hide the difference, so nothing here says "latest".
 *
 * A draft's validation state comes from the server's `status` column
 * (`draft | validating | valid | invalid | published`), never from a client-side
 * guess: `invalid` is a number of findings, and the number is the server's.
 */
import type {
  AssignmentChannelLabel,
  PipelineDraftSummary,
  PipelineRevisionSummary,
  PipelineSummary,
} from "../../lib/pipeline/contract";
import { Panel } from "../ds/Panel";
import { Row, StatusChip } from "../ds/Row";
import { Button } from "../ds/Button";
import { CHANNEL_STATE, DRAFT_STATE, REVISION_STATE, stateOf } from "../ds/states";
import { shortId } from "../../api/names";
import { shortDigest } from "../../lib/pipeline/yamlPointer";

export interface PipelineLibraryRow {
  pipeline: PipelineSummary;
  latest: PipelineRevisionSummary | null;
  revisions: PipelineRevisionSummary[];
  drafts: PipelineDraftSummary[];
  channels: AssignmentChannelLabel[];
}

/**
 * What a *project's assignment* says about a pipeline.
 *
 * M4 has no rollout channels — `AssignmentCreate` carries no channel member
 * (`07` "Version rollout" is M6), so on a project surface the channel cell has
 * nothing true to say about a pipeline that *is* assigned to this project. The
 * assignment is the fact: which revision is pinned, what the concurrency
 * ceiling is, and whether the pin is enabled.
 */
export interface PipelineAssignmentFacts {
  /** r<N> of the pinned revision, or null when the page cannot resolve the
   * digest to a number (then only the digest is shown — never a guess). */
  revisionNumber: number | null;
  /** `sha256:…` of the pinned revision; rendered through `shortDigest`. */
  revisionDigest: string;
  maxConcurrentRuns: number;
  enabled: boolean;
}

export interface PipelineLibraryProps {
  rows: PipelineLibraryRow[];
  /** `onOpen` is the row's primary action (detail route); injected so the
   * building block owns no route of its own. */
  onOpen?: (pipeline: PipelineSummary) => void;
  onNew?: () => void;
  /** Copy for why the list is empty — the reason differs per surface. */
  emptyCopy?: string;
  /** Which surface this list sits on. Channels are a *project* concept
   * (`01`: assignments pin revisions per project); at org level there is no
   * project to have channels, so the cell is omitted rather than claiming
   * "no channel set for this project" about nothing. */
  scope?: "project" | "org";
  /** Present on the project surface: the page joins its own assignments to the
   * pipeline and the cell reports that pin instead of a channel (`01`: an
   * assignment is what a run actually inherits). Omitted = the channel labels
   * are the truth, as the fixtures and the org page still render them. */
  assignmentFor?: (pipelineId: string) => PipelineAssignmentFacts | null;
  /** Words for a draft's `edited_by` user id — the page passes its actor
   * lookup (same rule as `api/names`: a bare uuid is never a label). The
   * fallback is `shortId`, not the raw id. */
  nameOf?: (userId: string) => string;
  /** A pipeline cannot be created, published or edited from here without a
   * permission the server holds; this line is the honest reason, shown once. */
  canCreate?: boolean;
  headingId?: string;
  className?: string;
}

export function PipelineLibrary({
  rows,
  onOpen,
  onNew,
  emptyCopy = "No pipelines in this organization yet. A pipeline exists once a draft validates and publishes; a draft cannot be published from this screen.",
  scope = "project",
  assignmentFor,
  nameOf = shortId,
  canCreate = true,
  headingId = "pipeline-library-heading",
  className = "",
}: PipelineLibraryProps) {
  return (
    <Panel
      title="PIPELINES"
      headingId={headingId}
      headingLevel={2}
      meta={
        <span className="flex items-center gap-[8px]">
          <span className="font-mono text-[10.5px]" data-testid="pipeline-library-count">
            {rows.length} shown
          </span>
          {canCreate ? (
            <Button variant="primary" compact data-testid="pipeline-library-new" onClick={onNew}>
              New pipeline
            </Button>
          ) : (
            // Org member: the button is absent *and* the reason is present, so
            // the missing control reads as a decision rather than a bug.
            <span
              className="font-mono text-[10px] font-normal"
              data-testid="pipeline-library-readonly"
            >
              definitions are visible to you; publishing needs the owner role
            </span>
          )}
        </span>
      }
      className={className}
    >
      {rows.length === 0 ? (
        <p className="p-[10px] text-[12.5px] text-muted" data-testid="pipeline-library-empty">
          {emptyCopy}
        </p>
      ) : (
        <ul className="divide-y divide-line" data-testid="pipeline-library">
          {rows.map(({ pipeline, latest, revisions, drafts, channels }) => {
            const draft = drafts[0];
            const assignment = assignmentFor ? assignmentFor(pipeline.id) : null;
            return (
              <li key={pipeline.id}>
                <Row
                  selected={false}
                  className="h-auto flex-wrap items-start gap-x-[10px] gap-y-[4px] border-0 rounded-none px-[10px] py-[8px]"
                  data-testid={`pipeline-row-${pipeline.slug}`}
                >
                  <button
                    type="button"
                    onClick={() => onOpen?.(pipeline)}
                    className="text-left text-[13.5px] font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    data-testid={`pipeline-name-${pipeline.slug}`}
                  >
                    {pipeline.display_name}
                    {/* A slug equal to the display name says the name twice and
                        runs the accessible name together
                        ("feature-developmentfeature-development"); the slug is
                        only worth its own cell when it differs. */}
                    {pipeline.slug === pipeline.display_name ? null : (
                      <span className="ml-[6px] font-mono text-[10.5px] font-normal text-muted">
                        {pipeline.slug}
                      </span>
                    )}
                  </button>

                  <span className="flex flex-wrap items-center gap-[6px]">
                    {pipeline.archived ? <StatusChip state="info" label="archived" /> : null}
                    {latest ? (
                      <StatusChip
                        state={stateOf(REVISION_STATE[latest.status])}
                        label={
                          latest.status === "published"
                            ? `latest published r${latest.revision_number}`
                            : `latest r${latest.revision_number} ${latest.status}`
                        }
                      />
                    ) : (
                      // Never published: the honest state, not a blank column.
                      <span
                        className="font-mono text-[10.5px] text-muted"
                        data-testid={`pipeline-unpublished-${pipeline.slug}`}
                      >
                        never published — {pipeline.revision_count} revisions
                      </span>
                    )}
                    <span
                      className="font-mono text-[10.5px] text-faint"
                      data-testid={`pipeline-revision-count-${pipeline.slug}`}
                    >
                      {pipeline.revision_count === 1
                        ? "1 revision"
                        : `${pipeline.revision_count} revisions`}
                    </span>
                  </span>

                  {scope === "org" ? null : (
                    <span
                      className="flex flex-wrap items-center gap-[6px]"
                      data-testid={`pipeline-channels-${pipeline.slug}`}
                    >
                      {channels.length === 0 && !assignmentFor ? (
                        // No channel is not "latest" — it is nothing pinned, said plainly.
                        <span
                          className="font-mono text-[10.5px] text-faint"
                          data-testid={`pipeline-no-channel-${pipeline.slug}`}
                        >
                          no channel set for this project
                        </span>
                      ) : (
                        <>
                          {channels.map((channel) => (
                            <StatusChip
                              key={channel.channel}
                              state={stateOf(CHANNEL_STATE[channel.channel])}
                              label={`${channel.channel} ${channel.version_label} ${shortDigest(channel.revision_digest)}`}
                            />
                          ))}
                          {assignmentFor ? (
                            assignment ? (
                              <StatusChip
                                state={stateOf(assignment.enabled ? "done" : "queued")}
                                label={assignmentWord(assignment)}
                                labelProps={{
                                  "data-testid": `pipeline-assignment-${pipeline.slug}`,
                                }}
                              />
                            ) : (
                              // Assigned nowhere: the reason a run cannot start,
                              // sitting beside the control that fixes it.
                              <span
                                className="font-mono text-[10.5px] text-faint"
                                data-testid={`pipeline-no-assignment-${pipeline.slug}`}
                              >
                                not assigned to this project
                              </span>
                            )
                          ) : null}
                        </>
                      )}
                    </span>
                  )}

                  {draft ? (
                    <span
                      className="flex items-center gap-[6px]"
                      data-testid={`pipeline-validation-${pipeline.slug}`}
                    >
                      <StatusChip
                        state={stateOf(DRAFT_STATE[draft.status])}
                        label={validationWord(draft)}
                      />
                      <span className="font-mono text-[10.5px] text-faint">
                        draft v{draft.version} · {nameOf(draft.edited_by)}
                      </span>
                    </span>
                  ) : null}

                  {revisions[0] ? (
                    <span
                      className="font-mono text-[10.5px] text-faint"
                      data-testid={`pipeline-digest-${pipeline.slug}`}
                    >
                      pinned here {shortDigest(revisions[0].revision_digest)} · plan{" "}
                      {shortDigest(revisions[0].plan_digest)}
                    </span>
                  ) : null}
                </Row>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- fragments */

/** The pin in words: what it points at and the ceiling it carries. The digest
 * is shortened like every other digest on screen (`shortDigest`), and the r<N>
 * is dropped rather than invented when the page cannot resolve the digest. */
function assignmentWord(assignment: PipelineAssignmentFacts): string {
  const pin =
    assignment.revisionNumber === null
      ? shortDigest(assignment.revisionDigest)
      : `r${assignment.revisionNumber} ${shortDigest(assignment.revisionDigest)}`;
  return `${assignment.enabled ? "assigned" : "assigned · disabled"} · ${pin} · max ${assignment.maxConcurrentRuns} concurrent`;
}

/** The draft line is a validation state, so the word is the finding count, not
 * the bare column value — `03`'s "which node, what was expected, where". */
function validationWord(draft: PipelineDraftSummary): string {
  if (draft.status === "invalid") return "draft has findings";
  if (draft.status === "valid") return "draft validated";
  if (draft.status === "validating") return "validating";
  if (draft.status === "published") return "published from this draft";
  return "draft";
}
