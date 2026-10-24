package api

// ADR-0050 part 2 wiring: the adapters that feed the assistant's
// multi-turn tool loop (internal/assistant.ConversationRunner) the REAL
// services. domain/assistant imports no store package, so every adapter
// lives here (or in cmd/) and translates assistant.Caller back to the
// route's api.Caller; each store call re-authorizes with the caller, so
// the loop can never widen the user's own boundary (ADR-0050 decision 4,
// spec 08 "one control source").
//
// Three pieces:
//
//   - assistantDraftService: the DraftService behind draft.get /
//     draft.apply. A reference is a draft id first; a pipeline id second
//     (its open draft, or — when the user has none open — a NEW draft
//     created as the caller from the latest published revision, through
//     the same CreateDraft the user's own POST /pipelines/{id}/drafts
//     route uses, source_kind "assistant"). Edits and undos travel
//     through the version-checked ReplaceDraft (the PUT /drafts/{id}
//     path), so a stale version loses, never overwrites.
//   - newAssistantActions: the ActionExecutors behind run.start /
//     run.retry / approval.decide, each running ONE store call the
//     matching route runs, as the caller.
//   - assistantTrustLevel: the per-turn assistant.trust_level read from
//     the caller's user_preferences (ADR-0046/C2).

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/dbirks/communication/internal/assistant"
)

// --- the narrow store faces ------------------------------------------------
//
// Each is the slice of one route's store the assistant's tools touch; the
// postgres adapters (APIPipelineStore, APIRunStore, APIAssignmentStore,
// APIApprovalStore, APIProjectStore) implement them through the full
// interfaces, so the loop acts on exactly the same persistence as the
// user's own requests.

// assistantDraftStore is the draft face: reads are the caller's own
// (an invisible draft is ErrPipelineNotFound, never a peek), writes are
// the CAS PUT. ListPipelines is the caller's own pipeline list the
// workflow.draft lookup resolves a slug or display name against.
type assistantDraftStore interface {
	GetDraft(ctx context.Context, c Caller, draftID string) (DraftView, error)
	ReplaceDraft(ctx context.Context, c Caller, draftID, documentYAML, sourceSHA256 string, expectedVersion int) (DraftView, error)
	ListPipelineDrafts(ctx context.Context, c Caller, pipelineID string) ([]DraftSummaryView, error)
	ListPipelineRevisions(ctx context.Context, c Caller, pipelineID string) ([]RevisionSummaryView, error)
	GetRevision(ctx context.Context, c Caller, digestOrID string) (RevisionView, error)
	CreateDraft(ctx context.Context, c Caller, pipelineID string, in DraftCreateInput) (DraftView, error)
	ListPipelines(ctx context.Context, c Caller) ([]PipelineSummaryView, error)
}

// assistantRunActions is the run face: the two lifecycle calls the
// risky run tools run, each as the caller.
type assistantRunActions interface {
	GetRun(ctx context.Context, c Caller, runID string) (RunView, error)
	CreateRun(ctx context.Context, c Caller, in RunCreateInput) (RunView, bool, error)
	RetryRun(ctx context.Context, c Caller, runID string, in RunRetryInput) (RunView, error)
}

// assistantAssignmentLister resolves a project's pin on a pipeline —
// the same resolution the user's own run-start request rides through.
type assistantAssignmentLister interface {
	ListAssignments(ctx context.Context, c Caller, projectID string, f AssignmentListFilter) ([]AssignmentView, error)
}

// assistantApprovalGate is the gate face: the caller's read plus the CAS
// decide with the decision-time authorize callback (the route's own).
type assistantApprovalGate interface {
	GetApproval(ctx context.Context, c Caller, approvalID string) (ApprovalView, error)
	DecideApproval(ctx context.Context, c Caller, approvalID, decision, comments string,
		version int, authorize ApproverAuthorize) (ApprovalView, error)
}

// assistantProjectRoles re-reads the caller's CURRENT role at decision
// time (approvals.go's currentRole seam) — never carried in from earlier.
type assistantProjectRoles interface {
	GetProject(ctx context.Context, c Caller, projectID string) (ProjectView, error)
}

// ac converts the runner's caller back to the route's: the same three
// identity fields, no more.
func ac(c assistant.Caller) Caller {
	return Caller{UserID: c.UserID, OrganizationID: c.OrganizationID, IsOrgAdmin: c.IsOrgAdmin}
}

// denied is the stable refusal the runner records (ok:false "forbidden",
// the approval card stays pending): a store says the caller may not see
// or act on the resource, so the loop must not name it or retry it.
func denied(err error) error {
	return fmt.Errorf("%w: %v", assistant.ErrActionDenied, err)
}

// --- the draft service (draft.get / draft.apply / undo) -------------------

// assistantDraftService implements assistant.DraftService. ProjectID comes
// back empty: a draft's pipeline is org-scoped (definitions have no
// project, ADR-0021), so the draft_edit change row is the org-level case.
type assistantDraftService struct {
	store assistantDraftStore
}

// NewAssistantDraftService wires the draft face for the runner's loop.
func NewAssistantDraftService(store assistantDraftStore) assistant.DraftService {
	return &assistantDraftService{store: store}
}

// resolveDraft resolves the loop's reference: an existing draft id first
// (the normal path — the page context names the open draft), a pipeline
// id second — the pipeline's open draft, or, with allowCreate (the edit
// path), a fresh draft from the latest published revision. Every call is
// the caller's own, so a reference the caller cannot see answers the
// not-found sentinel and existence stays hidden.
func (s *assistantDraftService) resolveDraft(ctx context.Context, c Caller, ref string, allowCreate bool) (DraftView, error) {
	if d, err := s.store.GetDraft(ctx, c, ref); err == nil {
		return d, nil
	} else if !errors.Is(err, ErrPipelineNotFound) {
		return DraftView{}, err
	}
	// The reference is a pipeline id after all (a nonsense id answers
	// ErrPipelineNotFound from the next call and stays hidden).
	drafts, err := s.store.ListPipelineDrafts(ctx, c, ref)
	if err != nil {
		return DraftView{}, err
	}
	var open *DraftSummaryView
	for i := range drafts {
		d := drafts[i]
		if d.Status == "published" {
			continue // a published draft is a revision's audit trail, not an open one
		}
		if open == nil || d.UpdatedAt.After(open.UpdatedAt) {
			open = &drafts[i]
		}
	}
	if open != nil {
		return s.store.GetDraft(ctx, c, open.ID)
	}
	if !allowCreate {
		return DraftView{}, ErrPipelineNotFound
	}
	// The user has no open draft: create one from the latest PUBLISHED
	// revision (a deprecated one is not what the user ships) — the same
	// clone bytes the user's own clone-draft request gets (the revision's
	// regenerated DocumentText, its sha256 recorded), as the caller.
	revs, err := s.store.ListPipelineRevisions(ctx, c, ref)
	if err != nil {
		return DraftView{}, err
	}
	var latest *RevisionSummaryView
	for i := range revs {
		if revs[i].Status != "published" {
			continue
		}
		if latest == nil || revs[i].RevisionNumber > latest.RevisionNumber {
			latest = &revs[i]
		}
	}
	if latest == nil {
		return DraftView{}, ErrPipelineNotFound // nothing published yet to draft from
	}
	rev, err := s.store.GetRevision(ctx, c, latest.RevisionDigest)
	if err != nil {
		return DraftView{}, err
	}
	doc := rev.DocumentText
	return s.store.CreateDraft(ctx, c, ref, DraftCreateInput{
		DocumentYAML: doc,
		SourceKind:   "assistant",
		SourceSHA256: m4SHA256([]byte(doc)),
	})
}

// GetDocument implements assistant.DraftService: the read the draft.get
// tool runs, and the read the edit path and the undo seam run before
// their PUT. It creates the draft from the latest published revision
// when the user has none open (the loop's only seam for materialising
// the edit target): creation is the caller's own CreateDraft — visible
// in the user's draft list, source_kind "assistant". The honest edge:
// an UNDO of a long-ago edit whose draft the user since discarded
// re-creates the draft before discovering the inverse op no longer
// applies structurally; the 409 still answers and the fresh draft is
// left exactly as the latest revision, untouched.
func (s *assistantDraftService) GetDocument(ctx context.Context, c assistant.Caller, ref string) (assistant.DraftDoc, error) {
	d, err := s.resolveDraft(ctx, ac(c), ref, true)
	if err != nil {
		return assistant.DraftDoc{}, err
	}
	return draftDoc(d), nil
}

// PipelineDraft implements assistant.DraftLocator: the workflow.draft
// lookup. It resolves the reference against the caller's OWN pipeline
// list — the exact id first, then the slug, then the display name
// (case-insensitive), then a fragment of either (the model often holds a
// fragment, not the full name); a reference the caller cannot see is
// not in the list, so the not-found sentinel keeps existence hidden —
// then reads the pipeline's drafts and revisions with the caller's own
// reads. The open draft is the newest non-published one (a published
// draft is a revision's audit trail, not an open one), and the latest
// revision the newest published one, exactly as resolveDraft's create
// path chooses them.
func (s *assistantDraftService) PipelineDraft(ctx context.Context, c assistant.Caller, ref string) (assistant.PipelineDraftView, error) {
	caller := ac(c)
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return assistant.PipelineDraftView{}, ErrPipelineNotFound
	}
	pipelines, err := s.store.ListPipelines(ctx, caller)
	if err != nil {
		return assistant.PipelineDraftView{}, err
	}
	lower := strings.ToLower(ref)
	var hit *PipelineSummaryView
	for i := range pipelines {
		if pipelines[i].ID == ref {
			hit = &pipelines[i]
			break
		}
	}
	if hit == nil {
		for i := range pipelines {
			if strings.ToLower(pipelines[i].Slug) == lower {
				hit = &pipelines[i]
				break
			}
		}
	}
	if hit == nil {
		for i := range pipelines {
			if strings.ToLower(pipelines[i].DisplayName) == lower {
				hit = &pipelines[i]
				break
			}
		}
	}
	if hit == nil {
		for i := range pipelines {
			if strings.Contains(strings.ToLower(pipelines[i].Slug), lower) ||
				strings.Contains(strings.ToLower(pipelines[i].DisplayName), lower) {
				hit = &pipelines[i]
				break
			}
		}
	}
	if hit == nil {
		return assistant.PipelineDraftView{}, ErrPipelineNotFound
	}
	out := assistant.PipelineDraftView{
		PipelineID:  hit.ID,
		Slug:        hit.Slug,
		DisplayName: hit.DisplayName,
	}
	drafts, err := s.store.ListPipelineDrafts(ctx, caller, hit.ID)
	if err != nil {
		return assistant.PipelineDraftView{}, err
	}
	for i := range drafts {
		d := drafts[i]
		if d.Status == "published" {
			continue
		}
		if out.Draft == nil || d.UpdatedAt.After(out.Draft.UpdatedAt) {
			out.Draft = &assistant.OpenDraft{
				DraftID:   d.ID,
				Version:   d.Version,
				Status:    d.Status,
				UpdatedAt: d.UpdatedAt,
			}
		}
	}
	revs, err := s.store.ListPipelineRevisions(ctx, caller, hit.ID)
	if err != nil {
		return assistant.PipelineDraftView{}, err
	}
	for i := range revs {
		if revs[i].Status != "published" {
			continue
		}
		if out.LatestRev == nil || revs[i].RevisionNumber > out.LatestRev.Number {
			out.LatestRev = &assistant.PublishedRevision{
				Number:       revs[i].RevisionNumber,
				VersionLabel: revs[i].VersionLabel,
			}
		}
	}
	return out, nil
}

// ReplaceDocument implements assistant.DraftService: the same
// version-checked PUT the user's own PUT /api/v1/drafts/{id} runs —
// identical bytes, identical CAS, the sha256 over exactly the stored
// bytes. A stale version or a lost write right is an error, never a
// silent overwrite; the draft's reference is resolved the same way the
// edit read it, so the PUT lands on the very document the op was
// validated against.
func (s *assistantDraftService) ReplaceDocument(ctx context.Context, c assistant.Caller, ref string, document []byte, expectedVersion int) (int, error) {
	caller := ac(c)
	d, err := s.resolveDraft(ctx, caller, ref, true)
	if err != nil {
		if errors.Is(err, ErrPipelineNotFound) {
			return 0, fmt.Errorf("%w: %v", assistant.ErrDraftGone, err)
		}
		return 0, err
	}
	out, err := s.store.ReplaceDraft(ctx, caller, d.ID, string(document), m4SHA256(document), expectedVersion)
	if err != nil {
		if errors.Is(err, ErrDraftForbidden) {
			return 0, fmt.Errorf("%w: %v", assistant.ErrForbidden, err)
		}
		// A CAS miss (or the draft closing under the edit): the runner
		// reports "draft moved" so the model re-reads instead of forcing.
		return 0, fmt.Errorf("the draft moved since it was read: %v", err)
	}
	return out.Version, nil
}

func draftDoc(d DraftView) assistant.DraftDoc {
	return assistant.DraftDoc{
		Document:  []byte(d.DocumentYAML),
		Version:   d.Version,
		ProjectID: "", // org-scoped pipeline: no project to name
	}
}

// --- the risky actions (run.start / run.retry / approval.decide) ---------

// AssistantActionsDeps carries the store faces one assistant action
// executes through. Every member is OPTIONAL: a nil member keeps that
// tool out of the announced set (an absent service means the model never
// asks for it), and Trigger (the routes' m4 nudge) is only a nudge.
type AssistantActionsDeps struct {
	Runs        assistantRunActions
	Assignments assistantAssignmentLister
	Approvals   assistantApprovalGate
	Projects    assistantProjectRoles
	Trigger     M4Trigger
}

// NewAssistantActions builds the runner's write-tool executors. Each one
// runs the SAME store call the matching route runs, as the caller (the
// caller's role and visibility are re-checked inside the store), and
// returns the acknowledgement plus the change row the transcript logs.
// A denial (the caller cannot see or act) is assistant.ErrActionDenied —
// the runner records the call forbidden and the approval card stays
// pending so the user can answer again after the right is restored.
func NewAssistantActions(d AssistantActionsDeps) map[string]assistant.ActionExecutor {
	out := map[string]assistant.ActionExecutor{}
	if d.Runs != nil {
		out["run.start"] = func(ctx context.Context, c assistant.Caller, _ string, args map[string]string) (string, *assistant.ChangeRecord, error) {
			projectID, pipelineID := args["project_id"], args["pipeline_id"]
			if projectID == "" || pipelineID == "" {
				return "", nil, errors.New("project_id and pipeline_id are required")
			}
			caller := ac(c)
			// The project's pin on this pipeline: exactly the resolution
			// the user's own POST /projects/{id}/runs request rides through
			// (an assignment's pinned revision). A pipeline the project has
			// not pinned is not startable from here, and the loop is told
			// "unavailable", never which pipelines exist.
			var pinned string
			if d.Assignments != nil {
				items, err := d.Assignments.ListAssignments(ctx, caller, projectID, AssignmentListFilter{})
				if err != nil {
					return "", nil, denied(err)
				}
				for i := range items {
					if items[i].PipelineID == pipelineID && items[i].PinnedRevisionID != "" {
						pinned = items[i].PinnedRevisionID
						break
					}
				}
			}
			if pinned == "" {
				return "", nil, errors.New("that pipeline has no pinned revision in this project")
			}
			// No idempotency key: the loop's confirm runs the action exactly
			// once (the store row, not a key, is the execution guard), and a
			// replayed POST would be a NEW run the user asked for.
			run, _, err := d.Runs.CreateRun(ctx, caller, RunCreateInput{
				ProjectID:          projectID,
				PipelineRevisionID: pinned,
				TriggeredBy:        c.UserID,
				RequestSHA:         m4SHA256([]byte("assistant:run.start:" + projectID + ":" + pinned)),
			})
			if err != nil {
				return "", nil, denied(err)
			}
			if d.Trigger != nil {
				d.Trigger(ctx, run.ID)
			}
			return "Started the run.", &assistant.ChangeRecord{
				Kind:      "run_start",
				ProjectID: &projectID,
				TargetRef: "run:" + run.ID,
				Summary:   "Started a new pipeline run",
			}, nil
		}
		out["run.retry"] = func(ctx context.Context, c assistant.Caller, _ string, args map[string]string) (string, *assistant.ChangeRecord, error) {
			projectID, runID, nodeID := args["project_id"], args["run_id"], args["node_id"]
			if runID == "" || nodeID == "" {
				return "", nil, errors.New("run_id and node_id are required")
			}
			caller := ac(c)
			// The caller's own read first: a run the caller cannot see is a
			// refusal, and the retry never learns its existence otherwise.
			if _, err := d.Runs.GetRun(ctx, caller, runID); err != nil {
				return "", nil, denied(err)
			}
			_, err := d.Runs.RetryRun(ctx, caller, runID, RunRetryInput{
				NodeInstanceKeys: []string{nodeID},
				Reason:           "assistant retry",
				RequestedBy:      c.UserID,
			})
			if err != nil {
				return "", nil, denied(err)
			}
			if d.Trigger != nil {
				d.Trigger(ctx, runID)
			}
			return "Retried the failed node.", &assistant.ChangeRecord{
				Kind:      "run_retry",
				ProjectID: &projectID,
				TargetRef: "run:" + runID + "/" + nodeID,
				Summary:   "Retried the failed node",
			}, nil
		}
	}
	if d.Approvals != nil {
		out["approval.decide"] = func(ctx context.Context, c assistant.Caller, _ string, args map[string]string) (string, *assistant.ChangeRecord, error) {
			approvalID, decision := args["approval_id"], args["decision"]
			if approvalID == "" || decision == "" {
				return "", nil, errors.New("approval_id and decision are required")
			}
			wire := decision
			switch decision {
			case "approve":
				wire = "approved"
			case "reject":
				wire = "rejected"
			default:
				return "", nil, fmt.Errorf("decision must be approve or reject")
			}
			caller := ac(c)
			gate, err := d.Approvals.GetApproval(ctx, caller, approvalID)
			if err != nil {
				return "", nil, denied(err)
			}
			// The route's own authorize: the role is re-read at decision
			// time inside the store's transaction, and the designated-
			// approver rule (apMayDecide) is unchanged.
			authorize := func(g ApprovalView, decider string) (bool, string) {
				if d.Projects == nil {
					return false, ApprovalDeniedLostAccess
				}
				p, err := d.Projects.GetProject(ctx, caller, g.ProjectID)
				if err != nil {
					return false, ApprovalDeniedLostAccess
				}
				return apMayDecide(g, decider, p.MyRole)
			}
			outGate, err := d.Approvals.DecideApproval(ctx, caller, approvalID, wire, "", gate.Version, authorize)
			if err != nil {
				return "", nil, denied(err)
			}
			if d.Trigger != nil {
				d.Trigger(ctx, outGate.RunID)
			}
			return "Recorded the decision.", &assistant.ChangeRecord{
				Kind:      "approval_decision",
				ProjectID: &outGate.ProjectID,
				TargetRef: "approval:" + approvalID,
				Summary:   "Decided a pipeline approval gate " + decision,
			}, nil
		}
	}
	return out
}

// --- the trust level (ADR-0046/C2, ADR-0050 decision 4) -------------------

// assistantTrustLevel builds the per-turn trust read: the caller's
// stored assistant.trust_level (ADR-0046), consulted by the tool loop
// only — it authorizes nothing, and a store failure answers the ADR's
// default (ask_risky) rather than a looser level.
func AssistantTrustLevel(store PreferencesStore) func(ctx context.Context, c assistant.Caller) (string, bool) {
	return func(ctx context.Context, c assistant.Caller) (string, bool) {
		doc, err := store.GetUserPreferences(ctx, c.UserID)
		if err != nil {
			return "", false // the route normalizes the empty level to ask_risky
		}
		return doc.Assistant.TrustLevel, doc.UpdatedAt != nil
	}
}
