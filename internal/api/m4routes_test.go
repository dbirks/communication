package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// Handler-level tests for the M4 HTTP surface (docs/m4-contract.md § 2,
// api/openapi.yaml v0.4.0-m4, all 37 operations). What is under test is
// the handler contract — the full route table, the authz matrix including
// 404-not-403 on every new project/org-scoped route, CSRF on every
// mutation, the CAS/idempotency/decision-time rules, the § 6 caps the API
// owns, and the problem+json codes — against fakes. The SQL predicates
// behind these interfaces are proven against a real PostgreSQL in
// internal/store/postgres (m4_pipelines_test.go / m4_runs_test.go); a
// mocked green test never substitutes for that, and this file never claims
// it does.

// ------------------------------------------------------------------ fakes

const (
	m4UUID  = "01987a80-1111-7000-8000-abcdef012345"
	m4UUID2 = "01987a81-2222-7000-8000-abcdef012345"
)

var m4FullDigest = "sha256:" + strings.Repeat("a", 64)

// m4Projects is the ProjectStore the run/approval handlers gate through.
type m4Projects struct {
	role   string // the MyRole GetProject answers ("" = not visible)
	getErr error
	denied []string
}

func (p *m4Projects) ListProjects(context.Context, Caller) ([]ProjectView, error) {
	return nil, nil
}
func (p *m4Projects) CreateProject(context.Context, Caller, string, string, string) (ProjectView, error) {
	return ProjectView{}, nil
}
func (p *m4Projects) GetProject(context.Context, Caller, string) (ProjectView, error) {
	if p.getErr != nil {
		return ProjectView{}, p.getErr
	}
	if p.role == "" {
		return ProjectView{}, ErrProjectNotFound
	}
	return ProjectView{ID: "p-1", MyRole: p.role}, nil
}
func (p *m4Projects) ListRepositories(context.Context, Caller, string) ([]RepositoryView, error) {
	return nil, nil
}
func (p *m4Projects) AddRepository(context.Context, Caller, string, string, string, string) (RepositoryView, error) {
	return RepositoryView{}, nil
}
func (p *m4Projects) ListMembers(context.Context, Caller, string) ([]MemberView, error) {
	return nil, nil
}
func (p *m4Projects) PutMember(context.Context, Caller, string, string, string) (MemberView, error) {
	return MemberView{}, nil
}
func (p *m4Projects) RecordDenied(_ context.Context, _ Caller, projectID, action string) error {
	p.denied = append(p.denied, action+"@"+projectID)
	return nil
}

// m4Pipelines backs routes 1–16.
type m4Pipelines struct {
	pipeline   PipelineView
	draft      DraftView
	revision   RevisionView
	revisions  []RevisionSummaryView
	drafts     []DraftSummaryView
	listRows   []PipelineSummaryView
	resolveRes *RevisionView // what GetRevision answers (nil = not found)
	resolveErr error

	updateOut    PipelineView
	replaceOut   DraftView
	replaceErr   error
	recordedVal  DraftValidationRecord
	publishedIn  DraftPublishInput
	publishedOut RevisionView
	publishErr   error
	deprecateOut RevisionView
	deprecateErr error

	denied []string
	calls  []string
}

func (f *m4Pipelines) ListPipelines(context.Context, Caller) ([]PipelineSummaryView, error) {
	f.calls = append(f.calls, "list")
	out := make([]PipelineSummaryView, len(f.listRows)) // shuffled order; the handler sorts
	copy(out, f.listRows)
	return out, nil
}
func (f *m4Pipelines) CreatePipeline(_ context.Context, _ Caller, slug, display, description string) (PipelineView, error) {
	f.calls = append(f.calls, "create")
	return PipelineView{ID: m4UUID, Slug: slug, DisplayName: display, Description: description}, nil
}
func (f *m4Pipelines) GetPipeline(context.Context, Caller, string) (PipelineView, error) {
	if f.pipeline.ID == "" {
		return PipelineView{}, ErrPipelineNotFound
	}
	return f.pipeline, nil
}
func (f *m4Pipelines) UpdatePipeline(_ context.Context, _ Caller, _ string, in PipelineUpdateInput) (PipelineView, error) {
	out := f.updateOut
	if out.ID == "" {
		return PipelineView{}, ErrPipelineNotFound
	}
	if in.Archived != nil {
		out.Archived = *in.Archived
	}
	return out, nil
}
func (f *m4Pipelines) ListPipelineRevisions(context.Context, Caller, string) ([]RevisionSummaryView, error) {
	return f.revisions, nil
}
func (f *m4Pipelines) ListPipelineDrafts(context.Context, Caller, string) ([]DraftSummaryView, error) {
	return f.drafts, nil
}
func (f *m4Pipelines) CreateDraft(_ context.Context, _ Caller, pipelineID string, in DraftCreateInput) (DraftView, error) {
	f.calls = append(f.calls, "create-draft:"+in.SourceKind)
	return DraftView{ID: m4UUID2, PipelineID: pipelineID, Status: "draft",
		DocumentYAML: in.DocumentYAML, SourceKind: in.SourceKind, SourceSHA256: in.SourceSHA256,
		DigestScope: "v1alpha1-canonical-1", Version: 1}, nil
}
func (f *m4Pipelines) GetDraft(context.Context, Caller, string) (DraftView, error) {
	if f.draft.ID == "" {
		return DraftView{}, ErrPipelineNotFound
	}
	return f.draft, nil
}
func (f *m4Pipelines) ReplaceDraft(_ context.Context, _ Caller, draftID, doc, sha string, version int) (DraftView, error) {
	f.calls = append(f.calls, fmt.Sprintf("replace:%d", version))
	if f.draft.ID == "" {
		return DraftView{}, ErrPipelineNotFound
	}
	if f.replaceErr != nil {
		return DraftView{}, f.replaceErr
	}
	out := f.replaceOut
	out.ID, out.DocumentYAML, out.SourceSHA256 = draftID, doc, sha
	return out, nil
}
func (f *m4Pipelines) DeleteDraft(context.Context, Caller, string) error {
	if f.draft.Status == "published" {
		return &DraftConflictError{Kind: DraftConflictPublished, Detail: "already published"}
	}
	return nil
}
func (f *m4Pipelines) RecordValidation(_ context.Context, _ Caller, _ string, in DraftValidationRecord) (DraftView, error) {
	f.recordedVal = in
	return f.draft, nil
}
func (f *m4Pipelines) PublishDraft(_ context.Context, _ Caller, _ string, in DraftPublishInput) (RevisionView, error) {
	f.publishedIn = in
	if f.publishErr != nil {
		return RevisionView{}, f.publishErr
	}
	out := f.publishedOut
	out.Status = "published"
	return out, nil
}
func (f *m4Pipelines) GetRevision(_ context.Context, _ Caller, seg string) (RevisionView, error) {
	f.calls = append(f.calls, "resolve:"+seg)
	if f.resolveErr != nil {
		return RevisionView{}, f.resolveErr
	}
	if f.resolveRes != nil { // forced answer (the already-published probe)
		return *f.resolveRes, nil
	}
	// The resolver is a lookup, not a stand-in: only the row's own id or
	// digest resolves, everything else answers not-found like the SQL does.
	if f.revision.ID != "" && (seg == f.revision.ID || seg == f.revision.RevisionDigest) {
		return f.revision, nil
	}
	return RevisionView{}, ErrPipelineNotFound
}
func (f *m4Pipelines) DeprecateRevision(context.Context, Caller, string) (RevisionView, error) {
	if f.deprecateErr != nil {
		return RevisionView{}, f.deprecateErr
	}
	out := f.deprecateOut
	if out.ID == "" {
		return RevisionView{}, ErrPipelineNotFound
	}
	out.Status = "deprecated"
	return out, nil
}
func (f *m4Pipelines) RecordDenied(_ context.Context, _ Caller, id, action string) error {
	f.denied = append(f.denied, action+"@"+id)
	return nil
}

// m4Defs is the scripted PipelineDefinitionService.
type m4Defs struct {
	outcome   ValidationOutcome
	export    string
	exportErr error
	calls     int
}

func (f *m4Defs) Validate(context.Context, Caller, string) (ValidationOutcome, error) {
	f.calls++
	return f.outcome, nil
}
func (f *m4Defs) Export(json.RawMessage) (string, error) {
	if f.exportErr != nil {
		return "", f.exportErr
	}
	return f.export, nil
}
func (f *m4Defs) EnvDigest() string { return "sha256:" + strings.Repeat("e", 64) }

// m4Runs backs routes 21–33 (plus the run half of 17–20's reads).
type m4Runs struct {
	run       RunView
	runs      []RunSummaryView
	nodes     []NodeExecutionView
	node      NodeExecutionDetailView
	tree      RunTreeView
	checks    []RunCheckpointView
	attempt   AttemptView
	createOut RunView
	created   bool
	idem      map[string][2]string
	createErr error
	lifeErr   error // conflict for pause/resume/cancel
	retryErr  error
	getErr    error

	denied []string
	calls  []string
}

func (f *m4Runs) CreateRun(_ context.Context, c Caller, in RunCreateInput) (RunView, bool, error) {
	f.calls = append(f.calls, "create:"+in.Key)
	if f.createErr != nil {
		return RunView{}, false, f.createErr
	}
	out := f.createOut
	if out.ID == "" {
		out = f.run
	}
	if out.ID == "" {
		out.ID = m4UUID
	}
	// 12 case 1 semantics, mirrored from the store: same key + same SHA
	// replays the stored run (Created=false); same key, different SHA is
	// the mismatch 409, never an update of the mapping.
	if in.Key != "" {
		if f.idem == nil {
			f.idem = map[string][2]string{}
		}
		if prev, ok := f.idem[in.Key]; ok {
			if prev[1] != in.RequestSHA {
				return RunView{}, false, &RunConflictError{Kind: RunConflictIdempotencyMismatch,
					Detail: "idempotency key was already used with a different request body"}
			}
			stored := out
			stored.ID = prev[0]
			return stored, false, nil
		}
		f.idem[in.Key] = [2]string{out.ID, in.RequestSHA}
	}
	return out, f.created, nil
}
func (f *m4Runs) GetRun(context.Context, Caller, string) (RunView, error) {
	if f.getErr != nil {
		return RunView{}, f.getErr
	}
	if f.run.ID == "" {
		return RunView{}, ErrRunNotFound
	}
	return f.run, nil
}
func (f *m4Runs) ListProjectRuns(_ context.Context, _ Caller, projectID string) ([]RunSummaryView, error) {
	if projectID != "p-1" {
		return nil, ErrProjectNotFound
	}
	return f.runs, nil
}
func (f *m4Runs) ListRunNodes(_ context.Context, _ Caller, runID string) ([]NodeExecutionView, error) {
	if f.run.ID == "" || f.run.ID != runID {
		return nil, ErrRunNotFound
	}
	return f.nodes, nil
}
func (f *m4Runs) GetRunNode(_ context.Context, _ Caller, runID, nodeID string) (NodeExecutionDetailView, error) {
	if f.node.ID == "" || f.node.RunID != runID {
		return NodeExecutionDetailView{}, ErrRunNotFound
	}
	out := f.node
	if nodeID != out.ID {
		return NodeExecutionDetailView{}, ErrRunNotFound
	}
	return out, nil
}
func (f *m4Runs) GetRunTree(context.Context, Caller, string) (RunTreeView, error) {
	if f.tree.Run.ID == "" {
		return RunTreeView{}, ErrRunNotFound
	}
	return f.tree, nil
}
func (f *m4Runs) ListRunCheckpoints(_ context.Context, _ Caller, runID string) ([]RunCheckpointView, error) {
	if f.run.ID == "" || f.run.ID != runID {
		return nil, ErrRunNotFound
	}
	return f.checks, nil
}
func (f *m4Runs) PauseRun(context.Context, Caller, string) (RunView, error) {
	f.calls = append(f.calls, "pause")
	return f.run, f.lifeErr
}
func (f *m4Runs) ResumeRun(context.Context, Caller, string) (RunView, error) {
	f.calls = append(f.calls, "resume")
	return f.run, f.lifeErr
}
func (f *m4Runs) CancelRun(context.Context, Caller, string) (RunView, error) {
	f.calls = append(f.calls, "cancel")
	return f.run, f.lifeErr
}
func (f *m4Runs) RetryRun(_ context.Context, _ Caller, _ string, in RunRetryInput) (RunView, error) {
	f.calls = append(f.calls, fmt.Sprintf("retry:%d", len(in.NodeInstanceKeys)))
	return f.run, f.retryErr
}
func (f *m4Runs) GetAttempt(context.Context, Caller, string) (AttemptView, error) {
	if f.attempt.ID == "" {
		return AttemptView{}, ErrRunNotFound
	}
	return f.attempt, nil
}
func (f *m4Runs) RecordDenied(_ context.Context, _ Caller, id, action string) error {
	f.denied = append(f.denied, action+"@"+id)
	return nil
}

// m4Assignments backs routes 17–20.
type m4Assignments struct {
	item       AssignmentView
	list       []AssignmentView
	createErr  error
	updateErr  error
	updateOut  AssignmentView
	deleteErr  error
	lastCreate AssignmentCreateInput
	lastPatch  AssignmentPatchInput
	denied     []string
}

func (f *m4Assignments) ListAssignments(context.Context, Caller, string) ([]AssignmentView, error) {
	return f.list, nil
}
func (f *m4Assignments) CreateAssignment(_ context.Context, _ Caller, projectID string, in AssignmentCreateInput) (AssignmentView, error) {
	f.lastCreate = in
	if f.createErr != nil {
		return AssignmentView{}, f.createErr
	}
	return AssignmentView{ID: m4UUID, ProjectID: projectID, PipelineID: in.PipelineID,
		PinnedRevisionID: in.PinnedRevisionID, MaxConcurrentRuns: in.MaxConcurrentRuns, Enabled: true, Version: 1}, nil
}
func (f *m4Assignments) GetAssignment(context.Context, Caller, string) (AssignmentView, error) {
	if f.item.ID == "" {
		return AssignmentView{}, ErrAssignmentNotFound
	}
	return f.item, nil
}
func (f *m4Assignments) UpdateAssignment(_ context.Context, _ Caller, id string, in AssignmentPatchInput) (AssignmentView, error) {
	f.lastPatch = in
	if f.updateErr != nil {
		return AssignmentView{}, f.updateErr
	}
	out := f.updateOut
	if out.ID == "" {
		out = f.item
	}
	out.ID = id
	out.Version++
	return out, nil
}
func (f *m4Assignments) DeleteAssignment(context.Context, Caller, string) error { return f.deleteErr }
func (f *m4Assignments) RecordDenied(_ context.Context, _ Caller, id, action string) error {
	f.denied = append(f.denied, action+"@"+id)
	return nil
}

// m4Approvals backs routes 34–36 and DECIDES like the real store: the
// authorize callback is evaluated at decision time (against the current
// fake role the handler reads from m4Projects), CAS is compared, and a
// refusal leaves the gate pending — so the 12 case 9 arms are tested
// against behaviour, not a scripted status code.
type m4Approvals struct {
	ap        ApprovalView
	forbidCAS bool
	denied    []string
	decidedAs string
}

func (f *m4Approvals) ListProjectApprovals(context.Context, Caller, string) ([]ApprovalView, error) {
	if f.ap.ID == "" {
		return nil, nil
	}
	return []ApprovalView{f.ap}, nil
}
func (f *m4Approvals) GetApproval(context.Context, Caller, string) (ApprovalView, error) {
	if f.ap.ID == "" {
		return ApprovalView{}, ErrApprovalNotFound
	}
	return f.ap, nil
}
func (f *m4Approvals) DecideApproval(_ context.Context, c Caller, id, decision, comments string,
	version int, authorize ApproverAuthorize) (ApprovalView, error) {
	if f.ap.ID == "" {
		return ApprovalView{}, ErrApprovalNotFound
	}
	ap := f.ap
	if ok, reason := authorize(ap, c.UserID); !ok {
		return ApprovalView{}, &ApprovalConflictError{Kind: reason, ApprovalID: id,
			State: ap.State, Version: ap.Version}
	}
	if f.forbidCAS || ap.State != "pending" || version != ap.Version {
		return ApprovalView{}, &ApprovalConflictError{
			Kind: ApprovalDeniedAlreadyDecided, ApprovalID: id,
			State: ap.State, Decision: derefStrView(ap.Decision),
			DecidedBy: derefStrView(ap.DecidedBy), Version: ap.Version}
	}
	f.decidedAs = c.UserID
	out := ap
	out.State = "decided"
	out.Decision = &decision
	if comments != "" {
		out.Comments = &comments
	}
	out.DecidedBy = &c.UserID
	now := time.Now().UTC()
	out.DecidedAt = &now
	out.Version = ap.Version + 1
	return out, nil
}
func (f *m4Approvals) RecordDenied(_ context.Context, _ Caller, id, action string) error {
	f.denied = append(f.denied, action+"@"+id)
	return nil
}

func derefStrView(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// m4Stream is the run SSE journal read: a fixed list filtered by cursor.
type m4Stream struct {
	events  []events.Envelope
	watchCh chan struct{}
	calls   int
}

func (s *m4Stream) RunEventsAfter(_ context.Context, _ Caller, _ string, afterSeq int64, limit int) ([]events.Envelope, error) {
	s.calls++
	var out []events.Envelope
	for _, e := range s.events {
		if e.GlobalSeq > afterSeq {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}
func (s *m4Stream) Watch(context.Context) (<-chan struct{}, func(), error) {
	return s.watchCh, func() {}, nil
}

func evt(seq int64, typ string) events.Envelope {
	return events.Envelope{EventID: fmt.Sprintf("e%d", seq), GlobalSeq: seq, Type: typ,
		SchemaVersion: 1, OccurredAt: time.Unix(int64(seq), 0).UTC(),
		OrganizationID: "o-1", ProjectID: "p-1", RunID: m4UUID,
		Actor:   events.Actor{Kind: "system"},
		Payload: map[string]any{"project_id": "p-1"}}
}

// m4Sched backs route 37.
type m4Sched struct {
	view SchedulerStatusView
	err  error
}

func (f *m4Sched) SchedulerStatus(context.Context) (SchedulerStatusView, error) {
	return f.view, f.err
}

// ------------------------------------------------------------------ server

type m4Fixture struct {
	s         *Server
	prin      *Principal
	projects  *m4Projects
	pipes     *m4Pipelines
	defs      *m4Defs
	runs      *m4Runs
	asgns     *m4Assignments
	approvs   *m4Approvals
	stream    *m4Stream
	sched     *m4Sched
	triggered []string
}

func m4Server(t *testing.T) *m4Fixture {
	t.Helper()
	fx := &m4Fixture{
		projects: &m4Projects{role: "maintainer"},
		pipes:    &m4Pipelines{},
		defs:     &m4Defs{export: "apiVersion: communication.dev/v1alpha1\n"},
		runs:     &m4Runs{},
		asgns:    &m4Assignments{},
		approvs:  &m4Approvals{},
		stream:   &m4Stream{watchCh: make(chan struct{})},
	}
	fx.prin = testPrincipal()
	fx.prin.IsOrgAdmin = true // library role by default; authz tests dial it back
	// The authenticator reads fx.prin live, so a test can dial roles down
	// per request without rebuilding the server.
	s := newTestServer(t, nil, fakeReadiness{expected: 5}, AuthenticatorFunc(
		func(*http.Request) (*Principal, error) { return fx.prin, nil }))
	RegisterPipelines(s, fx.pipes, fx.defs)
	RegisterRuns(s, fx.runs, fx.asgns, fx.projects, fx.stream,
		func(_ context.Context, runID string) { fx.triggered = append(fx.triggered, runID) })
	RegisterApprovals(s, fx.approvs, fx.projects,
		func(_ context.Context, runID string) { fx.triggered = append(fx.triggered, "approval:"+runID) })
	fx.sched = &m4Sched{view: SchedulerStatusView{}}
	RegisterScheduler(s, fx.sched)
	fx.s = s
	return fx
}

func m4Req(method, target string, body string, authed bool) *http.Request {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = request(method, target, nil)
	}
	if authed {
		r.Header.Set(HeaderCSRFToken, "csrf-token-value")
	}
	return r
}

func (f *m4Fixture) get(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, f.s.handler, request(http.MethodGet, target, nil))
}

func (f *m4Fixture) call(t *testing.T, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, f.s.handler, m4Req(method, target, body, true))
}

// ------------------------------------------------------------------ fixtures

func m4PopulatedServer(t *testing.T) *m4Fixture {
	t.Helper()
	fx := m4Server(t)
	fx.pipes.pipeline = PipelineView{ID: m4UUID, Slug: "feature-development",
		LatestRevisionNumber: 6, Revisions: []RevisionSummaryView{{RevisionNumber: 6,
			VersionLabel: "6.0.0", RevisionDigest: m4FullDigest, PlanDigest: m4FullDigest,
			DigestScope: "v1alpha1-canonical-1", PublishedBy: "u-1", Status: "published"}}}
	fx.pipes.listRows = []PipelineSummaryView{{ID: "z", Slug: "zeta"},
		{ID: "a", Slug: "alpha"}, {ID: "m", Slug: "mid"}}
	fx.pipes.updateOut = fx.pipes.pipeline
	fx.pipes.draft = DraftView{ID: m4UUID2, PipelineID: m4UUID, Status: "draft",
		DocumentYAML: "kind: Pipeline\n", SourceKind: "manual", SourceSHA256: strings.Repeat("0", 64),
		DigestScope: "v1alpha1-canonical-1", Version: 1}
	fx.pipes.replaceOut = fx.pipes.draft
	fx.pipes.drafts = []DraftSummaryView{{ID: m4UUID2, Status: "draft", Version: 1, EditedBy: "u-1"}}
	fx.pipes.revisions = fx.pipes.pipeline.Revisions
	fx.pipes.revision = RevisionView{ID: m4UUID, PipelineID: m4UUID, RevisionNumber: 6,
		VersionLabel: "6.0.0", APIVersion: "communication.dev/v1alpha1",
		CanonicalDocument: json.RawMessage(`{"kind":"Pipeline"}`), DocumentText: "kind: Pipeline\n",
		RevisionDigest: m4FullDigest, DigestScope: "v1alpha1-canonical-1",
		CompiledPlan: json.RawMessage(`{"scopes":[]}`), PlanDigest: m4FullDigest,
		SchemaDigest: m4FullDigest, CelEnvDigest: m4FullDigest,
		Status: "published", PublishedBy: "u-1"}
	fx.pipes.publishedOut = fx.pipes.revision
	fx.pipes.deprecateOut = fx.pipes.revision
	fx.pipes.draft.Status = "valid"
	digestA := m4FullDigest // the draft's digest: valid, unpublished
	fx.pipes.draft.RevisionDigest = &digestA
	fx.pipes.revision.RevisionDigest = "sha256:" + strings.Repeat("b", 64) // a DIFFERENT published document

	fx.runs.run = RunView{
		RunSummaryView: RunSummaryView{ID: m4UUID, ProjectID: "p-1", PipelineID: m4UUID,
			PipelineRevisionID: m4UUID, RevisionDigest: m4FullDigest, PlanDigest: m4FullDigest,
			Status: "queued", CreatedAt: time.Now().UTC()},
		DigestScope: "v1alpha1-canonical-1", Placement: RunPlacementView{Scheduled: false,
			Reason: m4StrPtr("volume_affinity_unsatisfied")},
		MyRole: "maintainer"}
	fx.runs.created = true
	fx.runs.createOut = fx.runs.run
	fx.runs.runs = []RunSummaryView{fx.runs.run.RunSummaryView}
	fx.runs.nodes = []NodeExecutionView{{ID: m4UUID2, RunID: m4UUID, NodeID: "plan",
		Kind: "agent.acp", NodeInstanceKey: "/plan", ScopeKey: "/", ExecutionLocation: "worker",
		Status: "succeeded", AttemptCount: 1, AttemptLimit: 3, DependsOn: json.RawMessage(`[]`),
		ArtifactRefs: json.RawMessage(`[]`)}}
	fx.runs.node = NodeExecutionDetailView{NodeExecutionView: fx.runs.nodes[0],
		CelEnvelope: CelEnvelopeView{Status: "succeeded",
			Outputs: json.RawMessage(`{"plan":"p"}`), ArtifactRefs: json.RawMessage(`[]`)}}
	fx.runs.tree = RunTreeView{Run: fx.runs.run.RunSummaryView}
	fx.runs.checks = []RunCheckpointView{{RunID: m4UUID, NodeExecutionID: m4UUID2,
		AttemptID: m4UUID, NodeInstanceKey: "/plan", InputsDigest: m4FullDigest,
		OutputsDigest: m4FullDigest, RepoStates: json.RawMessage(`[]`),
		ArtifactRefs: json.RawMessage(`[]`), WorkspaceID: m4UUID, VolumeID: m4FullDigest,
		WorkerID: m4UUID, PlanDigest: m4FullDigest}}
	fx.runs.attempt = AttemptView{ID: m4UUID, NodeExecutionID: m4UUID2, RunID: m4UUID,
		AttemptNumber: 1, Status: "succeeded", ScheduledAt: time.Now().UTC(),
		OutputErrors: json.RawMessage(`[]`), ArtifactRefs: json.RawMessage(`[]`),
		Outputs: json.RawMessage(`{}`), MyRole: "maintainer"}

	fx.asgns.item = AssignmentView{ID: m4UUID, ProjectID: "p-1", PipelineID: m4UUID,
		PinnedRevisionID: m4UUID, PinnedRevisionDigest: m4FullDigest, MaxConcurrentRuns: 1,
		BudgetOverrides: json.RawMessage(`{}`), EffectiveBudgets: json.RawMessage(`{}`),
		Enabled: true, Version: 1, MyRole: "maintainer"}
	fx.asgns.list = []AssignmentView{fx.asgns.item}

	fx.approvs.ap = ApprovalView{ID: m4UUID, ProjectID: "p-1", RunID: m4UUID,
		NodeExecutionID: m4UUID2, Kind: "pipeline_gate", Summary: "Plan for ${{ inputs.goal }}",
		ArtifactRefs: json.RawMessage(`[]`), ApproverRoles: []string{"maintainer"},
		DeadlineAt: time.Now().UTC().Add(time.Hour), OnTimeout: "fail",
		State: "pending", Version: 1, MyRole: "maintainer"}
	fx.streamEvents()
	return fx
}

func (f *m4Fixture) streamEvents() {
	f.stream.events = []events.Envelope{evt(1, "run.created"), evt(2, "node.scope.started"),
		evt(3, "run.completed")}
}

func m4StrPtr(s string) *string { return &s }

// ------------------------------------------------------------- route table

// m4Operations is the frozen § 2.1 route table: 37 operations
// (16 definition/draft/revision/schema, 4 assignment, 13 run/attempt/node
// including the run stream, 3 approval, 1 ops). It is asserted against
// both the openapi document and the registered patterns in TestM4Route-
// TableMatchesOpenAPI — three-way, so a route can drift from neither.
var m4Operations = [][2]string{
	{"GET", "/api/v1/pipelines"},
	{"POST", "/api/v1/pipelines"},
	{"GET", "/api/v1/pipelines/{pipelineId}"},
	{"PATCH", "/api/v1/pipelines/{pipelineId}"},
	{"GET", "/api/v1/pipelines/{pipelineId}/revisions"},
	{"GET", "/api/v1/pipelines/{pipelineId}/drafts"},
	{"POST", "/api/v1/pipelines/{pipelineId}/drafts"},
	{"GET", "/api/v1/drafts/{draftId}"},
	{"PUT", "/api/v1/drafts/{draftId}"},
	{"DELETE", "/api/v1/drafts/{draftId}"},
	{"POST", "/api/v1/drafts/{draftId}/validate"},
	{"POST", "/api/v1/drafts/{draftId}/publish"},
	{"GET", "/api/v1/revisions/{digestOrId}"},
	{"GET", "/api/v1/revisions/{revisionId}/document"},
	{"POST", "/api/v1/revisions/{revisionId}/deprecate"},
	{"GET", "/api/v1/schemas/pipeline-v1alpha1"},
	{"GET", "/api/v1/projects/{projectId}/assignments"},
	{"POST", "/api/v1/projects/{projectId}/assignments"},
	{"PATCH", "/api/v1/assignments/{assignmentId}"},
	{"DELETE", "/api/v1/assignments/{assignmentId}"},
	{"GET", "/api/v1/projects/{projectId}/runs"},
	{"POST", "/api/v1/projects/{projectId}/runs"},
	{"GET", "/api/v1/runs/{runId}"},
	{"GET", "/api/v1/runs/{runId}/nodes"},
	{"GET", "/api/v1/runs/{runId}/nodes/{nodeExecutionId}"},
	{"GET", "/api/v1/runs/{runId}/tree"},
	{"GET", "/api/v1/runs/{runId}/checkpoints"},
	{"POST", "/api/v1/runs/{runId}/pause"},
	{"POST", "/api/v1/runs/{runId}/resume"},
	{"POST", "/api/v1/runs/{runId}/cancel"},
	{"POST", "/api/v1/runs/{runId}/retry"},
	{"GET", "/api/v1/runs/{runId}/events"},
	{"GET", "/api/v1/attempts/{attemptId}"},
	{"GET", "/api/v1/projects/{projectId}/approvals"},
	{"GET", "/api/v1/approvals/{approvalId}"},
	{"POST", "/api/v1/approvals/{approvalId}/decide"},
	{"GET", "/api/v1/system/scheduler"},
}

// TestM4RouteTableServesAll37 hits every operation against the populated
// fakes: a missing registration 404s against the SPA-fallback table and
// this test names it; a mis-wired path segment (e.g. {runId} read as
// {nodeExecutionId}) fails the status expectation.
func TestM4RouteTableServesAll37(t *testing.T) {
	fx := m4PopulatedServer(t)
	u := "http://localhost:8080"
	body := map[string]string{
		"POST /api/v1/pipelines":                        `{"slug":"pl"}`,
		"PATCH /api/v1/pipelines/{pipelineId}":          `{"archived":true}`,
		"POST /api/v1/pipelines/{pipelineId}/drafts":    `{"document_yaml":"kind: Pipeline\napiVersion: communication.dev/v1alpha1\nmetadata:\n  name: x\nspec:\n  nodes: []"}`,
		"PUT /api/v1/drafts/{draftId}":                  `{"document_yaml":"kind: Pipeline\n","version":1}`,
		"POST /api/v1/drafts/{draftId}/publish":         `{"version":1}`,
		"POST /api/v1/projects/{projectId}/assignments": `{"pipeline_id":"` + m4UUID + `","pinned_revision_id":"` + m4UUID + `"}`,
		"PATCH /api/v1/assignments/{assignmentId}":      `{"enabled":false}`,
		"POST /api/v1/projects/{projectId}/runs":        `{"pipeline_revision_id":"` + m4UUID + `"}`,
		"POST /api/v1/approvals/{approvalId}/decide":    `{"decision":"approved","version":1}`,
	}
	wantStatus := map[string]int{
		"POST /api/v1/pipelines":                        201,
		"POST /api/v1/pipelines/{pipelineId}/drafts":    201,
		"DELETE /api/v1/drafts/{draftId}":               204,
		"POST /api/v1/drafts/{draftId}/publish":         201,
		"POST /api/v1/projects/{projectId}/assignments": 201,
		"DELETE /api/v1/assignments/{assignmentId}":     204,
		"POST /api/v1/projects/{projectId}/runs":        201,
		"POST /api/v1/runs/{runId}/cancel":              202,
		"GET /api/v1/runs/{runId}/events":               200, // SSE
	}
	for _, op := range m4Operations {
		method, tmpl := op[0], op[1]
		if method == "GET" {
			// The SSE route is exercised (with a cancelled context) by
			// TestM4RunEventStream; blocking the table for a never-ending
			// stream is not a table problem.
			if tmpl == "/api/v1/runs/{runId}/events" {
				continue
			}
		}
		target := u + m4Fill(tmpl)
		key := method + " " + tmpl
		want := wantStatus[key]
		if want == 0 {
			want = 200
		}
		var rec *httptest.ResponseRecorder
		if body[key] != "" || method == "DELETE" || method == "POST" || method == "PATCH" || method == "PUT" {
			rec = fx.call(t, method, target, body[key])
		} else {
			rec = fx.get(t, target)
		}
		if rec.Code != want {
			t.Errorf("%s -> %d (want %d): %s", key, rec.Code, want, firstLine(rec.Body.String()))
		}
	}
}

// m4Fill substitutes concrete ids for the wildcard segments.
func m4Fill(tmpl string) string {
	r := strings.NewReplacer(
		"{pipelineId}", m4UUID, "{draftId}", m4UUID2, "{digestOrId}", m4UUID,
		"{revisionId}", m4UUID, "{projectId}", "p-1", "{assignmentId}", m4UUID,
		"{runId}", m4UUID, "{nodeExecutionId}", m4UUID2, "{attemptId}", m4UUID,
		"{approvalId}", m4UUID)
	return r.Replace(tmpl)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// TestM4MutationsRequireCSRF proves HandleAuthed installed the CSRF gate
// on every one of the 21 mutating operations (and only on non-GETs): a
// POST/PUT/PATCH/DELETE without X-CSRF-Token is 403 before any store call.
func TestM4MutationsRequireCSRF(t *testing.T) {
	fx := m4PopulatedServer(t)
	mutations := 0
	for _, op := range m4Operations {
		if op[0] == "GET" {
			continue
		}
		mutations++
		target := "http://localhost:8080" + m4Fill(op[1])
		r := m4Req(op[0], target, `{"slug":"pl","version":1,"decision":"approved",
			"enabled":false,"document_yaml":"kind: Pipeline\n","archived":true,
			"pipeline_id":"`+m4UUID+`","pinned_revision_id":"`+m4UUID+`"}`, false)
		rec := do(t, fx.s.handler, r)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "CSRF") {
			t.Errorf("%s %s without CSRF -> %d %s, want 403 CSRF", op[0], op[1], rec.Code, rec.Body)
		}
	}
	// Frozen count: 17 mutating operations in the 37-route table (create,
	// publish/validate actions, 4 run lifecycle, deprecate, decide, the
	// draft put/delete, and the pipeline/assignment mutations).
	if mutations != 17 {
		t.Errorf("mutating operations = %d, want 17", mutations)
	}
}

// TestM4AnonymousIs401 pins the session floor on the new surface.
func TestM4AnonymousIs401(t *testing.T) {
	s := newTestServer(t, nil, fakeReadiness{expected: 5},
		principalAuth(nil, ErrUnauthenticated))
	RegisterPipelines(s, &m4Pipelines{}, &m4Defs{})
	RegisterScheduler(s, &m4Sched{})
	for _, target := range []string{"/api/v1/pipelines", "/api/v1/system/scheduler"} {
		rec := do(t, s.handler, request(http.MethodGet, "http://localhost:8080"+target, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401", target, rec.Code)
		}
	}
}

// TestM4CrossTenantIs404Not403 walks every resource-scoped route with
// empty fakes (the tenant predicate answered "not found") and asserts the
// uniform 404 body plus the audit denial — the 12 case 15 rule extended
// to M4's whole new surface (W9's probe-resistance arm).
func TestM4CrossTenantIs404Not403(t *testing.T) {
	fx := m4Server(t) // everything empty: no pipelines, drafts, revisions, runs, gates
	probe := func(method, target, body string) {
		t.Helper()
		var rec *httptest.ResponseRecorder
		if method == "GET" && body == "" {
			rec = fx.get(t, target)
		} else {
			rec = fx.call(t, method, target, body)
		}
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d (%s), want 404", method, target, rec.Code, rec.Body)
			return
		}
		if ct := rec.Header().Get("Content-Type"); ct != ProblemJSON {
			t.Errorf("%s %s problem content-type = %q", method, target, ct)
		}
	}
	probe("GET", "/api/v1/pipelines/"+m4UUID, "")
	probe("PATCH", "/api/v1/pipelines/"+m4UUID, `{"archived":true}`)
	probe("GET", "/api/v1/drafts/"+m4UUID2, "")
	probe("PUT", "/api/v1/drafts/"+m4UUID2, `{"document_yaml":"kind: Pipeline\n","version":1}`)
	probe("POST", "/api/v1/drafts/"+m4UUID2+"/validate", "")
	probe("POST", "/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
	probe("GET", "/api/v1/revisions/"+m4UUID, "")
	probe("GET", "/api/v1/revisions/"+m4UUID+"/document", "")
	probe("POST", "/api/v1/revisions/"+m4UUID+"/deprecate", "")
	probe("GET", "/api/v1/runs/"+m4UUID, "")
	probe("GET", "/api/v1/runs/"+m4UUID+"/nodes", "")
	probe("GET", "/api/v1/runs/"+m4UUID+"/tree", "")
	probe("GET", "/api/v1/runs/"+m4UUID+"/checkpoints", "")
	probe("POST", "/api/v1/runs/"+m4UUID+"/pause", "")
	probe("POST", "/api/v1/runs/"+m4UUID+"/retry", "")
	probe("GET", "/api/v1/attempts/"+m4UUID, "")
	probe("GET", "/api/v1/approvals/"+m4UUID, "")
	probe("POST", "/api/v1/approvals/"+m4UUID+"/decide", `{"decision":"approved","version":1}`)
	probe("PATCH", "/api/v1/assignments/"+m4UUID, `{"enabled":false}`)
	probe("DELETE", "/api/v1/assignments/"+m4UUID, "")

	if len(fx.pipes.denied) == 0 || len(fx.runs.denied) == 0 ||
		len(fx.approvs.denied) == 0 || len(fx.asgns.denied) == 0 {
		t.Errorf("denials not audited: pipes=%v runs=%v approvals=%v assignments=%v",
			fx.pipes.denied, fx.runs.denied, fx.approvs.denied, fx.asgns.denied)
	}
}

// TestM4RoleMatrix pins the 403 arms (visible resource, insufficient role)
// and the library-role reading: an org NON-admin may not create/publish;
// a project viewer may not create runs or pause them; an org admin is NOT
// an approver unless designated (`01`'s "only designated approvers").
func TestM4RoleMatrix(t *testing.T) {
	t.Run("non-admin cannot touch the shared library", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.prin.IsOrgAdmin = false
		for _, tc := range []struct{ method, path, body string }{
			{"POST", "/api/v1/pipelines", `{"slug":"pl"}`},
			{"PATCH", "/api/v1/pipelines/" + m4UUID, `{"archived":true}`},
			{"POST", "/api/v1/drafts/" + m4UUID2 + "/publish", `{"version":1}`},
			{"POST", "/api/v1/revisions/" + m4UUID + "/deprecate", ``},
		} {
			rec := fx.call(t, tc.method, "http://localhost:8080"+tc.path, tc.body)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s %s = %d, want 403 (library role): %s",
					tc.method, tc.path, rec.Code, rec.Body)
			}
		}
		// Reads stay open to org members (the library list is not secret).
		if rec := fx.get(t, "http://localhost:8080/api/v1/pipelines"); rec.Code != http.StatusOK {
			t.Errorf("member pipeline list = %d, want 200", rec.Code)
		}
	})

	t.Run("viewer cannot create runs or move one", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.prin.IsOrgAdmin = false // org admins pass every project gate by design
		fx.projects.role = "viewer"
		fx.runs.run.MyRole = "viewer"
		fx.runs.createOut.MyRole = "viewer"
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
			`{"pipeline_revision_id":"`+m4UUID+`"}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("viewer POST /runs = %d, want 403: %s", rec.Code, rec.Body)
		}
		if len(fx.projects.denied) == 0 {
			t.Error("viewer run-create denial was not audited")
		}
		rec = fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/pause", "")
		if rec.Code != http.StatusForbidden {
			t.Errorf("viewer pause = %d, want 403", rec.Code)
		}
		// ... and CAN read the run (403-vs-404 stays existence-clean).
		if rec := fx.get(t, "http://localhost:8080/api/v1/runs/"+m4UUID); rec.Code != http.StatusOK {
			t.Errorf("viewer GET run = %d, want 200", rec.Code)
		}
	})

	t.Run("contributor cannot assign pipelines", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.prin.IsOrgAdmin = false
		fx.projects.role = "contributor"
		fx.asgns.item.MyRole = "contributor"
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/assignments",
			`{"pipeline_id":"`+m4UUID+`","pinned_revision_id":"`+m4UUID+`"}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("contributor POST assignment = %d, want 403", rec.Code)
		}
		rec = fx.call(t, "PATCH", "http://localhost:8080/api/v1/assignments/"+m4UUID, `{"enabled":false}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("contributor PATCH assignment = %d, want 403", rec.Code)
		}
	})

	t.Run("org admin is not an approver unless designated", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.approvs.ap.ApproverRoles = []string{"maintainer"}
		fx.approvs.ap.ApproverUserIDs = []string{}
		fx.projects.role = "contributor" // admin sees the project but is a contributor in it
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
			`{"decision":"approved","version":1}`)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("undeclared decider = %d, want 403: %s", rec.Code, rec.Body)
		}
		if p := decodeProblem(t, rec); !strings.Contains(p.Type, "approval-denied") {
			t.Errorf("problem type = %q, want approval-denied", p.Type)
		}
		if fx.approvs.decidedAs != "" {
			t.Error("the refusal must not decide anything")
		}
	})

	// C9c through the handler: the store now answers a same-organization
	// former member with the approval.denied refusal (postgres
	// APIApprovalStore.DecideApproval loads the gate under the tenant scope so
	// the refusal can name it and journal it), and the mapping is 403 — never
	// the 404 that hides whether the gate exists at all.
	t.Run("a former member's decide is 403, not 404", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.prin.IsOrgAdmin = false
		fx.projects.role = "" // removed from the project between gate-open and decide
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
			`{"decision":"approved","version":1}`)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("removed approver decide = %d, want 403: %s", rec.Code, rec.Body)
		}
		if p := decodeProblem(t, rec); !strings.Contains(p.Type, "approval-denied") {
			t.Errorf("problem type = %q, want approval-denied", p.Type)
		}
		if fx.approvs.decidedAs != "" {
			t.Error("the C9c refusal must not decide anything")
		}
		if len(fx.approvs.denied) == 0 {
			t.Error("the C9c refusal was not audited")
		}
	})

	// ... while a caller who cannot even claim the organization still gets the
	// uniform not-found (the store's tenant read answers ErrApprovalNotFound).
	t.Run("a stranger's decide stays 404", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.prin.IsOrgAdmin = false
		fx.approvs.ap = ApprovalView{} // invisible under the organization predicate
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
			`{"decision":"approved","version":1}`)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("cross-org decide = %d, want 404: %s", rec.Code, rec.Body)
		}
	})
}

// ------------------------------------------------------- create-run + pins

// TestM4CreateRunIdempotentDoublePost is 12 case 1 through the handler:
// same key + same body re-answers 200 with the SAME run_id and never
// advances a second run or fires a second advancer nudge; the same key
// with a different body is the 409 idempotency_key_mismatch and updates
// nothing (docs/m4-contract.md § 7 C1a, § 7's C1 rule "double-POST returns
// the same run").
func TestM4CreateRunIdempotentDoublePost(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.runs.run.ID = "run-1"
	fx.runs.createOut = fx.runs.run
	fx.runs.created = true
	const body = `{"pipeline_revision_id":"` + m4UUID + `","inputs":{"goal":"fix add()"}}`

	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("first POST = %d: %s", rec.Code, rec.Body)
	}
	var first RunCreateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode 201: %v (%s)", err, rec.Body)
	}
	if first.Status != "queued" || first.RunID == "" {
		t.Fatalf("201 body = %s", rec.Body)
	}
	if loc := rec.Header().Get("Location"); loc != "/api/v1/runs/run-1" {
		t.Errorf("Location = %q", loc)
	}

	// Header key replay.
	rec = do(t, fx.s.handler, func() *http.Request {
		r := m4Req("POST", "http://localhost:8080/api/v1/projects/p-1/runs", body, true)
		r.Header.Set("Idempotency-Key", "click-1")
		return r
	}())
	if rec.Code != http.StatusCreated {
		t.Fatalf("keyed POST = %d: %s", rec.Code, rec.Body)
	}

	rec = do(t, fx.s.handler, func() *http.Request {
		r := m4Req("POST", "http://localhost:8080/api/v1/projects/p-1/runs", body, true)
		r.Header.Set("Idempotency-Key", "click-1")
		return r
	}())
	if rec.Code != http.StatusOK {
		t.Fatalf("replay = %d (want 200): %s", rec.Code, rec.Body)
	}
	var replay RunCreateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &replay); err != nil {
		t.Fatalf("decode replay: %v", err)
	}
	if replay.RunID != "run-1" {
		t.Errorf("replay run_id = %q, want the stored run-1", replay.RunID)
	}

	// Same key, different body: 409 idempotency_key_mismatch, nothing new.
	rec = do(t, fx.s.handler, func() *http.Request {
		r := m4Req("POST", "http://localhost:8080/api/v1/projects/p-1/runs", body+" ", true)
		r.Header.Set("Idempotency-Key", "click-1")
		return r
	}())
	if rec.Code != http.StatusConflict {
		t.Fatalf("mismatch POST = %d: %s", rec.Code, rec.Body)
	}
	if p := decodeProblem(t, rec); !strings.Contains(p.Type, "idempotency-key-mismatch") {
		t.Errorf("mismatch problem type = %q", p.Type)
	}

	// The header wins over the body member, so a body-only key is honoured
	// when no header is present, and ignored when one is.
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/runs",
		`{"pipeline_revision_id":"`+m4UUID+`","idempotency":"body-only"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("body-key POST = %d", rec.Code)
	}
	if got := fx.runs.calls[len(fx.runs.calls)-1]; got != "create:body-only" {
		t.Errorf("store saw key %q, want the body member", got)
	}
	// A malformed key is the client's mistake: 422 before the store.
	rec = do(t, fx.s.handler, func() *http.Request {
		r := m4Req("POST", "http://localhost:8080/api/v1/projects/p-1/runs", body, true)
		r.Header.Set("Idempotency-Key", "not a key!")
		return r
	}())
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("malformed key = %d, want 422", rec.Code)
	}
	// Exactly one nudge per CREATED run; the replay and the mismatch
	// fire none (three creations happened above: bare, keyed, body-keyed).
	if len(fx.triggered) != 3 {
		t.Errorf("advancer nudges = %v, want one per creation only", fx.triggered)
	}
}

// TestM4RunBodyDigestsAndPlacement asserts digest pinning is visible in
// the run body and the lease machinery is not: placement is the boolean
// view, and worker ids/fencing tokens/lease deadlines appear nowhere (§ 2's
// serialization ban, re-run against every new route in TestM4NoInternals).
func TestM4RunBodyDigestsAndPlacement(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.get(t, "http://localhost:8080/api/v1/runs/"+m4UUID)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET run = %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["revision_digest"] != m4FullDigest || body["plan_digest"] != m4FullDigest {
		t.Errorf("pinned digests missing from the run body: %s", rec.Body)
	}
	placement, ok := body["placement"].(map[string]any)
	if !ok || placement["scheduled"] != false || placement["reason"] != "volume_affinity_unsatisfied" {
		t.Errorf("placement = %v, want the honest queued/waiting-for-worker view", body["placement"])
	}
	for _, banned := range []string{"worker_id", "worker_affinity", "worker_volume_id",
		"fencing_token", "lease_expires_at", "plan_snapshot", "policies_snapshot"} {
		if strings.Contains(rec.Body.String(), banned) {
			t.Errorf("run body carries %q", banned)
		}
	}
}

// TestM4AttemptBodyNeverLeases route 32's "Never" list, as data.
func TestM4AttemptBodyNeverLeases(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.get(t, "http://localhost:8080/api/v1/attempts/"+m4UUID)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET attempt = %d: %s", rec.Code, rec.Body)
	}
	for _, banned := range []string{"worker_id", "fencing_token", "lease_expires_at"} {
		if strings.Contains(rec.Body.String(), banned) {
			t.Errorf("attempt body carries %q (ADR-0016 § 8)", banned)
		}
	}
	if !strings.Contains(rec.Body.String(), `"output_errors":[]`) {
		t.Errorf("output_errors must be [] never null: %s", rec.Body)
	}
}

// ---------------------------------------------------------- draft lifecycle

func TestM4DraftPutCAS(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.pipes.draft.Status = "draft"
	fx.pipes.replaceErr = &DraftConflictError{Kind: DraftConflictStaleVersion,
		DraftID: m4UUID2, CurrentVersion: 8, Detail: "draft version is 8, not 5."}
	rec := fx.call(t, "PUT", "http://localhost:8080/api/v1/drafts/"+m4UUID2,
		`{"document_yaml":"kind: Pipeline\n","version":5}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale PUT = %d: %s", rec.Code, rec.Body)
	}
	var problem struct {
		Type           string `json:"type"`
		Detail         string `json:"detail"`
		DraftID        string `json:"draft_id"`
		CurrentVersion int    `json:"current_version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(problem.Type, "/stale-draft-version") || problem.CurrentVersion != 8 ||
		problem.DraftID != m4UUID2 {
		t.Errorf("conflict body = %+v", problem)
	}
	if ct := rec.Header().Get("Content-Type"); ct != ProblemJSON {
		t.Errorf("content type = %q", ct)
	}
}

func TestM4ValidateStoresBodyAndCapsErrors(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.pipes.draft.Status = "draft"
	many := make([]ValidateError, 0, 250)
	for i := 0; i < 250; i++ {
		many = append(many, ValidateError{Code: "schema_shape", Source: "schema",
			Message: fmt.Sprintf("unit %d", i)})
	}
	fx.defs.outcome = ValidationOutcome{Body: ValidateResponse{
		Valid: false, DigestScope: "v1alpha1-canonical-1", Errors: many, Notes: []string{}}}
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("validate = %d: %s", rec.Code, rec.Body)
	}
	var body ValidateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Valid || len(body.Errors) != m4MaxValidateErrors {
		t.Errorf("capped errors = %d, want %d", len(body.Errors), m4MaxValidateErrors)
	}
	if !strings.Contains(strings.Join(body.Notes, ","), "errors_truncated") {
		t.Errorf("notes = %v, want errors_truncated", body.Notes)
	}
	if fx.pipes.recordedVal.Status != "invalid" {
		t.Errorf("stored status = %q", fx.pipes.recordedVal.Status)
	}

	// A valid pass stores both digests and the plan, and echoes them.
	fx.defs.outcome = ValidationOutcome{Body: ValidateResponse{Valid: true,
		RevisionDigest: &m4FullDigest, PlanDigest: &m4FullDigest,
		DigestScope: "v1alpha1-canonical-1"},
		CanonicalDocument: json.RawMessage(`{"kind":"Pipeline"}`),
		RevisionDigest:    m4FullDigest,
		CompiledPlan:      json.RawMessage(`{"scopes":[]}`),
		PlanDigest:        m4FullDigest, DigestScope: "v1alpha1-canonical-1"}
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("valid validate = %d", rec.Code)
	}
	if fx.pipes.recordedVal.Status != "valid" || fx.pipes.recordedVal.RevisionDigest != m4FullDigest ||
		fx.pipes.recordedVal.PlanDigest != m4FullDigest {
		t.Errorf("stored validation = %+v", fx.pipes.recordedVal)
	}
}

func TestM4DeletePublishedDraftRefuses(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.pipes.draft.Status = "published"
	rec := fx.call(t, "DELETE", "http://localhost:8080/api/v1/drafts/"+m4UUID2, "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete published draft = %d: %s", rec.Code, rec.Body)
	}
}

func TestM4PublishGates(t *testing.T) {
	t.Run("not valid is draft_not_valid 409", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.pipes.draft.Status = "invalid"
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "draft-not-valid") {
			t.Fatalf("= %d: %s", rec.Code, rec.Body)
		}
	})
	t.Run("secret literal is the redacted 422 block", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.pipes.draft.Status = "invalid"
		loc := "/spec/nodes/2/config/env/DATABASE_URL"
		fx.pipes.draft.Validation = json.RawMessage(`{"valid":false,"digest_scope":"v1alpha1-canonical-1",` +
			`"errors":[{"code":"secret_literal_detected","source":"compiler","message":"secret-shaped value",` +
			`"instance_location":"` + loc + `","schema_location":null}],"notes":[]}`)
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(rec.Body.String(), "secret-literal-detected") {
			t.Fatalf("= %d: %s", rec.Code, rec.Body)
		}
		// ADR-0021 Security: the location and the shape are safe; the value
		// would be a second secret store, in the error log of every proxy.
		if strings.Contains(rec.Body.String(), "postgres://") ||
			strings.Contains(strings.ToLower(rec.Body.String()), "password") {
			t.Errorf("secret literal response quotes a value: %s", rec.Body)
		}
	})
	t.Run("digest already published names the existing revision", func(t *testing.T) {
		fx := m4PopulatedServer(t) // draft is valid with RevisionDigest set
		existing := RevisionView{ID: "rev-existing", RevisionDigest: m4FullDigest, Status: "published"}
		fx.pipes.resolveRes = &existing
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
		if rec.Code != http.StatusConflict {
			t.Fatalf("= %d: %s", rec.Code, rec.Body)
		}
		var problem struct {
			Type               string `json:"type"`
			ExistingRevisionID string `json:"existing_revision_id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(problem.Type, "/revision-already-published") ||
			problem.ExistingRevisionID != "rev-existing" {
			t.Errorf("conflict body = %+v", problem)
		}
	})
	t.Run("CAS miss carries the winner's version", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.pipes.draft.Version = 9
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":4}`)
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"current_version":9`) {
			t.Fatalf("= %d: %s", rec.Code, rec.Body)
		}
	})
	t.Run("success publishes the revision", func(t *testing.T) {
		fx := m4PopulatedServer(t)
		fx.pipes.revision = RevisionView{} // the digest is not published yet
		fx.pipes.pipeline.LatestRevisionNumber = 6
		fx.pipes.publishedOut = RevisionView{ID: "rev-new", RevisionNumber: 7,
			VersionLabel: "7.0.0", RevisionDigest: m4FullDigest, PlanDigest: m4FullDigest}
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("publish = %d: %s", rec.Code, rec.Body)
		}
		if loc := rec.Header().Get("Location"); loc != "/api/v1/revisions/rev-new" {
			t.Errorf("Location = %q", loc)
		}
		// Omitted version_label takes the server-assigned next semver, and
		// the two environment digests are the ones the compiler pinned.
		if fx.pipes.publishedIn.VersionLabel != "7.0.0" ||
			fx.pipes.publishedIn.SchemaDigest == "" || fx.pipes.publishedIn.CelEnvDigest == "" {
			t.Errorf("publish input = %+v", fx.pipes.publishedIn)
		}
	})
}

// TestM4PublishSecretFindingCode is § 7.1 C13c's measurable half: the block
// must NAME itself. The publish gate short-circuits on the draft's recorded
// validation, so the 422 it writes carries the § 2.2 code validate already
// returned for the same finding (`secret_literal_detected`) as a stable
// `code` member — not only inside prose or the `type` URI tail. And the code
// belongs to the finding, not the route: the same draft re-validated clean
// still publishes.
func TestM4PublishSecretFindingCode(t *testing.T) {
	const loc = "/spec/nodes/0/config/env/DATABASE_URL"
	fx := m4PopulatedServer(t)
	fx.pipes.draft.Status = "invalid"
	fx.pipes.draft.Validation = json.RawMessage(`{"valid":false,"digest_scope":"v1alpha1-canonical-1",` +
		`"errors":[{"code":"secret_literal_detected","source":"compiler","message":"URL with inline credentials",` +
		`"instance_location":"` + loc + `","schema_location":null}],"notes":[]}`)
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("publish = %d: %s", rec.Code, rec.Body)
	}
	var problem struct {
		Type   string `json:"type"`
		Status int    `json:"status"`
		Detail string `json:"detail"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.Code != string(DraftConflictSecretLiteral) {
		t.Errorf("code = %q, want %q (body %s)", problem.Code, DraftConflictSecretLiteral, rec.Body)
	}
	if problem.Type != "https://communication.dev/errors/secret-literal-detected" || problem.Status != 422 {
		t.Errorf("problem envelope = %+v", problem)
	}
	if !strings.Contains(problem.Detail, loc) {
		t.Errorf("detail does not name the location: %q", problem.Detail)
	}

	fx.pipes.draft.Status = "valid"
	fx.pipes.draft.Validation = json.RawMessage(`{"valid":true,"errors":[],"notes":[]}`)
	fx.pipes.pipeline.LatestRevisionNumber = 6
	fx.pipes.revision = RevisionView{} // nothing published at this digest
	fx.pipes.publishedOut = RevisionView{ID: "rev-clean", RevisionNumber: 7, VersionLabel: "7.0.0"}
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/drafts/"+m4UUID2+"/publish", `{"version":1}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("clean draft publish = %d: %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), DraftConflictSecretLiteral) {
		t.Errorf("the published revision body carries the secret code: %s", rec.Body)
	}
}

func TestM4RevisionDocumentAndSchema(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.get(t, "http://localhost:8080/api/v1/revisions/"+m4UUID+"/document?format=yaml")
	if rec.Code != http.StatusOK {
		t.Fatalf("document = %d: %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/yaml") {
		t.Errorf("document content-type = %q", ct)
	}
	rec = fx.get(t, "http://localhost:8080/api/v1/revisions/"+m4UUID+"/document?format=json")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("format=json = %d, want 422", rec.Code)
	}
	rec = fx.get(t, "http://localhost:8080/api/v1/revisions/nope")
	if rec.Code != http.StatusNotFound {
		t.Errorf("malformed digestOrId = %d, want uniform 404 (not a probe surface)", rec.Code)
	}
	rec = fx.get(t, "http://localhost:8080/api/v1/schemas/pipeline-v1alpha1")
	if rec.Code != http.StatusOK ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("schema = %d ct=%q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), `"https://communication.dev/schemas/pipeline-v1alpha1.schema.json"`) {
		t.Errorf("served schema is not the $id'd asset: %.120s", rec.Body)
	}
}

// -------------------------------------------------------------- run actions

func TestM4RunConflictProblemBodies(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.pipes.draft.Status = "valid" // keep the draft routes out of the way
	fx.runs.retryErr = &RunConflictError{Kind: RunConflictNotRetriable,
		RunID: m4UUID, RunStatus: "running", Detail: "the run is still executing"}
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry", `{"reason":"crash"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("retry = %d: %s", rec.Code, rec.Body)
	}
	var problem struct {
		Type      string `json:"type"`
		RunID     string `json:"run_id"`
		RunStatus string `json:"run_status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(problem.Type, "/run-not-retriable") ||
		problem.RunID != m4UUID || problem.RunStatus != "running" {
		t.Errorf("conflict body = %+v", problem)
	}

	fx.runs.retryErr = &RunConflictError{Kind: RunConflictCheckpointUnavailable,
		RunID: m4UUID, RunStatus: "failed", Detail: "/implement declares restore_checkpoint but app is dirty"}
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry",
		`{"node_instance_keys":["/implement"]}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "checkpoint-unavailable") {
		t.Fatalf("checkpoint retry = %d: %s", rec.Code, rec.Body)
	}
	if len(fx.triggered) != 0 {
		t.Errorf("refused retries must not nudge the advancer: %v", fx.triggered)
	}

	fx.runs.lifeErr = &RunConflictError{Kind: RunConflictState, RunID: m4UUID,
		RunStatus: "waiting_human", Detail: "a gate is the wait; pausing would race it"}
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/pause", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "run-state-conflict") {
		t.Fatalf("pause waiting_human = %d: %s", rec.Code, rec.Body)
	}
}

func TestM4LifecycleNudgesAdvancer(t *testing.T) {
	fx := m4PopulatedServer(t)
	for _, action := range []string{"pause", "resume", "cancel"} {
		want := http.StatusOK
		if action == "cancel" {
			want = http.StatusAccepted // a request, not a stop (§ 2.1 route 30)
		}
		rec := fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/"+action, "")
		if rec.Code != want {
			t.Fatalf("%s = %d: %s", action, rec.Code, rec.Body)
		}
	}
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("empty-body retry = %d: %s", rec.Code, rec.Body)
	}
	if len(fx.triggered) != 4 {
		t.Errorf("nudges = %v, want one per committed lifecycle action (pause, resume, cancel, retry)", fx.triggered)
	}
	for _, id := range fx.triggered {
		if id != m4UUID {
			t.Errorf("nudge named %q, want the run id", id)
		}
	}
}

func TestM4RetryBodyCaps(t *testing.T) {
	fx := m4PopulatedServer(t)
	long := strings.Repeat("x", 513)
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry",
		`{"reason":"`+long+`"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("oversized reason = %d, want 422", rec.Code)
	}
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry",
		`{"node_instance_keys":[]}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("explicit empty key list = %d, want 422 (minItems 1)", rec.Code)
	}
}

// --------------------------------------------------------- approval decide

// TestM4DecideRefusedAfterRevocation is 12 case 9's C9c through the
// handler: the gate opens with a maintainer, the maintainer is REMOVED
// from the project (the fake project store now answers not-found), and the
// decide attempt is refused at decision time — the gate stays pending, the
// CAS version is unmoved, the refusal is audited, and the advancer is not
// nudged (there is nothing to advance).
func TestM4DecideRefusedAfterRevocation(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.approvs.ap.ApproverRoles = []string{"maintainer"}
	fx.projects.role = "maintainer" // authorized at gate-open
	// ... then removed: every later GetProject says "not visible".
	fx.projects.role = ""
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
		`{"decision":"approved","version":1}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("revoked decide = %d: %s", rec.Code, rec.Body)
	}
	if p := decodeProblem(t, rec); !strings.Contains(p.Type, "approval-denied") {
		t.Errorf("problem type = %q", p.Type)
	}
	if fx.approvs.decidedAs != "" {
		t.Error("a refused decision must not decide")
	}
	if fx.approvs.ap.State != "pending" || fx.approvs.ap.Version != 1 {
		t.Errorf("gate moved on a refusal: %+v", fx.approvs.ap)
	}
	if len(fx.approvs.denied) == 0 {
		t.Error("revocation refusal was not audited")
	}
	if len(fx.triggered) != 0 {
		t.Errorf("refusal must not nudge: %v", fx.triggered)
	}
}

// TestM4DecideCASOneWinner: the loser of a simultaneous click gets 409
// approval_already_decided carrying the winner's state/version — never a
// silent accept (route 36, C9d).
func TestM4DecideCASOneWinner(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.approvs.forbidCAS = true
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
		`{"decision":"approved","version":1}`)
	if rec.Code != http.StatusConflict ||
		!strings.Contains(rec.Body.String(), "approval-already-decided") {
		t.Fatalf("CAS miss = %d: %s", rec.Code, rec.Body)
	}
	var problem struct {
		ApprovalID string `json:"approval_id"`
		Approval   struct {
			State   string `json:"state"`
			Version int    `json:"version"`
		} `json:"approval"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.ApprovalID != m4UUID || problem.Approval.State != "pending" ||
		problem.Approval.Version != 1 {
		t.Errorf("winner body = %+v", problem)
	}
}

func TestM4DecideHappyPathNudgesRun(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
		`{"decision":"rejected","comments":"needs a migration plan","version":1}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("decide = %d: %s", rec.Code, rec.Body)
	}
	// A REJECTION is a normal decision (a business outcome, § 5.3): 200
	// with the gate at its next CAS version.
	if !strings.Contains(rec.Body.String(), `"decision":"rejected"`) ||
		!strings.Contains(rec.Body.String(), `"version":2`) {
		t.Errorf("decided body = %s", rec.Body)
	}
	if len(fx.triggered) != 1 || fx.triggered[0] != "approval:"+m4UUID {
		t.Errorf("nudges = %v, want the decided run advanced", fx.triggered)
	}
	// comments beyond 8 KiB never reach the store (route 36 / § 6).
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/approvals/"+m4UUID+"/decide",
		`{"decision":"approved","comments":"`+strings.Repeat("c", 8193)+`","version":1}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("oversized comments = %d, want 422", rec.Code)
	}
}

// ------------------------------------------------------------- assignment

func TestM4AssignmentBudgetOverridesOnlyLower(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.asgns.createErr = ErrBudgetOverridesRaise
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/assignments",
		`{"pipeline_id":"`+m4UUID+`","pinned_revision_id":"`+m4UUID+`",
		"budget_overrides":{"maxNodeExecutions":999999}}`)
	if rec.Code != http.StatusBadRequest ||
		!strings.Contains(rec.Body.String(), "budget-overrides-may-only-lower") {
		t.Fatalf("raising override = %d: %s", rec.Code, rec.Body)
	}
	fx.asgns.createErr = ErrAssignmentConflict
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/projects/p-1/assignments",
		`{"pipeline_id":"`+m4UUID+`","pinned_revision_id":"`+m4UUID+`"}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("second assignment = %d, want 409", rec.Code)
	}
}

// ------------------------------------------------------------- run SSE (33)

// TestM4RunEventStream proves the run stream frames, resumes from
// Last-Event-ID, answers 422 for a malformed cursor and never opens for a
// run the caller may not see — ADR-0014 § 5's mechanism, run-filtered.
func TestM4RunEventStream(t *testing.T) {
	openStream := func(t *testing.T, fx *m4Fixture, header map[string]string) (string, int) {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		r := httptest.NewRequest(http.MethodGet, "http://localhost:8080/api/v1/runs/"+m4UUID+"/events", nil)
		r = r.WithContext(ctx)
		for k, v := range header {
			r.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		done := make(chan struct{})
		go func() { defer close(done); fx.s.ServeHTTP(rec, r) }()
		time.Sleep(80 * time.Millisecond) // several millisecond-scale polls
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("stream did not stop after its request context was cancelled")
		}
		return rec.Body.String(), rec.Code
	}

	// A fresh stream replays the whole run from seq 0.
	fx := m4PopulatedServer(t)
	fx.streamTiming(t)
	body, code := openStream(t, fx, nil)
	if code != http.StatusOK {
		t.Fatalf("stream status = %d", code)
	}
	for _, want := range []string{"id: 1\nevent: run.created", "id: 2\nevent: node.scope.started",
		"id: 3\nevent: run.completed"} {
		if !strings.Contains(body, want) {
			t.Errorf("stream body missing %q:\n%s", want, body)
		}
	}
	if strings.Count(body, "id: 3") != 1 {
		t.Error("an event was delivered twice — the cursor did not advance")
	}

	// Last-Event-ID wins over ?after= and resumes after the given seq.
	body, _ = openStream(t, fx, map[string]string{"Last-Event-ID": "2"})
	if strings.Contains(body, "id: 1") || strings.Contains(body, "id: 2\n") {
		t.Errorf("resume replayed old events: %s", body)
	}
	if !strings.Contains(body, "id: 3\nevent: run.completed") {
		t.Errorf("resume missed the tail: %s", body)
	}

	// A malformed cursor is refused before any byte of stream.
	rec := do(t, fx.s.handler, request(http.MethodGet,
		"http://localhost:8080/api/v1/runs/"+m4UUID+"/events?after=nope", nil))
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), ProblemJSON) {
		t.Fatalf("bad after = %d: %s", rec.Code, rec.Body)
	}

	// No authorization, no stream: the 404 (plus audit) arrives instead of
	// a half-open event source (W9's SSE arm).
	fx2 := m4Server(t)
	fx2.streamTiming(t)
	body, code = openStream(t, fx2, nil)
	if code != http.StatusNotFound {
		t.Fatalf("unauthorized stream status = %d body %q, want 404", code, body)
	}
	if strings.Contains(body, "id: ") || strings.Contains(body, "event: ") {
		t.Errorf("unauthorized stream leaked SSE frames: %q", body)
	}
	if !strings.Contains(body, "No such run") {
		t.Errorf("unauthorized stream did not answer the uniform problem body: %q", body)
	}
	if len(fx2.runs.denied) == 0 {
		t.Error("the stream refusal was not audited")
	}
}

// streamTiming rebuilds the registration with millisecond-scale stream
// timing; production RegisterRuns keeps the § 6 batch (500) and the
// ADR-0014 heartbeat, which no test may slow-wait for.
func (f *m4Fixture) streamTiming(t *testing.T) {
	t.Helper()
	s := newTestServer(t, nil, fakeReadiness{expected: 5},
		AuthenticatorFunc(func(*http.Request) (*Principal, error) { return f.prin, nil }))
	RegisterPipelines(s, f.pipes, f.defs)
	registerRuns(s, f.runs, f.asgns, f.projects, f.stream,
		func(_ context.Context, runID string) { f.triggered = append(f.triggered, runID) },
		evtTiming{heartbeat: 5 * time.Millisecond, poll: 10 * time.Millisecond, batch: 10})
	RegisterApprovals(s, f.approvs, f.projects, nil)
	RegisterScheduler(s, f.sched)
	f.s = s
}

// TestM4PipelinesSortedBySlug: openapi orders the library by slug (the
// store rows arrive in created order; the handler owns the contract).
func TestM4PipelinesSortedBySlug(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.get(t, "http://localhost:8080/api/v1/pipelines")
	if !strings.Contains(rec.Body.String(), `"slug":"alpha"`) ||
		strings.Index(rec.Body.String(), "alpha") > strings.Index(rec.Body.String(), "mid") ||
		strings.Index(rec.Body.String(), "mid") > strings.Index(rec.Body.String(), "zeta") {
		t.Errorf("library not slug-ordered: %s", rec.Body)
	}
}

// ------------------------------------------------------------- scheduler (37)

func TestM4SchedulerStatusShape(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.sched.view = SchedulerStatusView{
		AttemptsByStatus: SchedulerAttemptsView{Queued: 2, Leased: 1, Running: 1}}
	rec := fx.get(t, "http://localhost:8080/api/v1/system/scheduler")
	if rec.Code != http.StatusOK {
		t.Fatalf("scheduler = %d: %s", rec.Code, rec.Body)
	}
	var view map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	// The queue-age is null when the queue is empty — "no queued attempts"
	// is an answer, not a zero lie (§ 5.2's honesty rule).
	if view["oldest_queued_age_seconds"] != nil {
		t.Errorf("empty queue age = %v, want null", view["oldest_queued_age_seconds"])
	}
	byStatus, _ := view["attempts_by_status"].(map[string]any)
	if byStatus["queued"] != float64(2) {
		t.Errorf("attempts_by_status = %v", view["attempts_by_status"])
	}
	if workers, ok := view["workers"].([]any); !ok || len(workers) != 0 {
		t.Errorf("workers = %v, want [] never null", view["workers"])
	}
}

// ------------------------------------------------ route-table diff proof

// TestM4RouteTableMatchesOpenAPI is the § 8 contract guard: route→OpenAPI
// coverage for all 37 operations, three-way — the frozen table above, the
// paths/methods parsed out of api/openapi.yaml v0.4.0-m4, and the
// patterns actually registered in pipelines.go / runs.go / approvals.go /
// scheduler.go. No extras, no gaps: a route present in code but not the
// document, or the reverse, fails here with the exact set difference.
func TestM4RouteTableMatchesOpenAPI(t *testing.T) {
	const doc = "../../api/openapi.yaml"
	raw, err := os.ReadFile(doc)
	if err != nil {
		t.Fatalf("read openapi document: %v", err)
	}
	docOps := m4OpenAPIOperations(string(raw))

	registered := m4RegisteredPatterns(t, "pipelines.go", "runs.go", "approvals.go", "scheduler.go")

	frozen := map[string]bool{}
	for _, op := range m4Operations {
		frozen[op[0]+" "+op[1]] = true
	}
	if len(frozen) != len(m4Operations) || len(m4Operations) != 37 {
		t.Fatalf("frozen table must hold 37 distinct operations, has %d/%d", len(frozen), len(m4Operations))
	}
	m4SetEqual(t, "openapi.yaml vs frozen table", docOps, frozen)
	m4SetEqual(t, "registered patterns vs frozen table", registered, frozen)
}

// m4OpenAPIOperations extracts (METHOD, path-template) pairs for every M4
// path in the openapi document. M4 paths are exactly the ones the frozen
// table names under its new prefixes; everything else in the document
// (health, projects, conversations, secrets, workspaces, artifacts…) is
// other milestones and deliberately out of this diff.
func m4OpenAPIOperations(doc string) map[string]bool {
	out := map[string]bool{}
	var current string
	methods := map[string]bool{"get": true, "post": true, "put": true, "patch": true, "delete": true}
	for _, line := range strings.Split(doc, "\n") {
		if m := regexp.MustCompile(`^  (/api/v1/[^:]+):$`).FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		if current == "" {
			continue
		}
		if m := regexp.MustCompile(`^    (get|post|put|patch|delete):$`).FindStringSubmatch(line); m != nil {
			// Only M4's own path templates belong in this diff.
			if m4IsM4Path(current) {
				out[strings.ToUpper(m[1])+" "+current] = true
			}
			continue
		}
		if !methods[strings.TrimSuffix(strings.TrimSpace(line), ":")] {
			continue
		}
	}
	return out
}

// m4IsM4Path is the prefix set of the M4 surface (route table § 2.1).
// The cross-project top-level lists (ADR-0047, registered in
// crossproject.go — outside the M4 files this diff greps) share the
// `/api/v1/runs` and `/api/v1/approvals` prefixes but are not part of the
// frozen M4 37, so the exact templates are excluded here.
func m4IsM4Path(p string) bool {
	if p == "/api/v1/runs" || p == "/api/v1/approvals" {
		return false
	}
	// ADR-0052's summarization pass and free-text interpretation live under
	// the approvals prefix but are assistant routes (registered in
	// approval_summary.go), not part of the frozen M4 37 — excluded the same
	// way as the cross-project top-level list above.
	if p == "/api/v1/approvals/{approvalId}/summary" || p == "/api/v1/approvals/{approvalId}/interpret" {
		return false
	}
	prefixes := []string{
		"/api/v1/pipelines", "/api/v1/drafts", "/api/v1/revisions",
		"/api/v1/schemas/pipeline-v1alpha1", "/api/v1/assignments",
		"/api/v1/projects/{projectId}/assignments", "/api/v1/projects/{projectId}/runs",
		"/api/v1/projects/{projectId}/approvals", "/api/v1/runs", "/api/v1/attempts",
		"/api/v1/approvals", "/api/v1/system/scheduler",
	}
	for _, pre := range prefixes {
		if strings.HasPrefix(p, pre) {
			return true
		}
	}
	return false
}

// m4RegisteredPatterns greps the HandleAuthed registrations out of the M4
// source files (the house registers every route through HandleAuthed) and
// returns them as METHOD+path-template keys.
func m4RegisteredPatterns(t *testing.T, files ...string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	pat := regexp.MustCompile(`HandleAuthed\("(GET|POST|PUT|PATCH|DELETE) (/api/v1/[^"]+)"`)
	for _, name := range files {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, m := range pat.FindAllStringSubmatch(string(raw), -1) {
			key := m[1] + " " + m[2]
			if out[key] {
				t.Errorf("%s registered twice: %s", key, name)
			}
			out[key] = true
		}
	}
	return out
}

func m4SetEqual(t *testing.T, what string, got, want map[string]bool) {
	t.Helper()
	var missing, extra []string
	for k := range want {
		if !got[k] {
			missing = append(missing, k)
		}
	}
	for k := range got {
		if !want[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) != 0 || len(extra) != 0 {
		t.Errorf("%s mismatch:\n  missing: %s\n  extra:   %s", what,
			strings.Join(missing, ", "), strings.Join(extra, ", "))
	}
}

// ------------------------------------------------------------- misc caps

// TestM4BodyCap covers the § 6 request cap every mutation shares: a body
// beyond 1 MiB is 413 before any parsing, and an over-256-KiB draft
// document is the named 422 well before the DB CHECK.
func TestM4BodyCaps(t *testing.T) {
	fx := m4PopulatedServer(t)

	pad := strings.Repeat("x", MaxJSONBodyBytes+8)
	rec := fx.call(t, "PUT", "http://localhost:8080/api/v1/drafts/"+m4UUID2,
		`{"document_yaml":"`+pad+`","version":1}`)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("1 MiB+ body = %d, want 413", rec.Code)
	}

	doc := "\"document_yaml\":\"apiVersion: x\\n" + strings.Repeat("# c\\n", 70000) + "\""
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/pipelines/"+m4UUID+"/drafts", "{"+doc+"}")
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), "document_too_large") {
		t.Fatalf("256 KiB+ document = %d: %.200s", rec.Code, rec.Body)
	}
}

// TestM4NodeDetailJoin: the {runId}/{nodeExecutionId} pair is a
// relationship claim; a node belonging to another run is the same 404 as
// nonsense, even for a caller who may see both runs.
func TestM4NodeDetailJoin(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.get(t, "http://localhost:8080/api/v1/runs/other-run/nodes/"+m4UUID2)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-run node probe = %d, want 404", rec.Code)
	}
	rec = fx.get(t, "http://localhost:8080/api/v1/runs/"+m4UUID+"/nodes/"+m4UUID2)
	if rec.Code != http.StatusOK {
		t.Fatalf("joined node = %d: %s", rec.Code, rec.Body)
	}
	// The CEL envelope the route promises — the object expressions read —
	// rides with the attempts list, and no attempt serializes lease state.
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if env, ok := body["cel_envelope"].(map[string]any); !ok || env["status"] != "succeeded" {
		t.Errorf("cel_envelope = %v", body["cel_envelope"])
	}
	if _, ok := body["attempts"].([]any); !ok {
		t.Errorf("attempts must always be an array: %v", body["attempts"])
	}
}

// TestM4ListsNeverNull pins the envelope key of every new list route —
// openapi gives each list its OWN key (pipelines/revisions/drafts/
// assignments/runs/node_executions/checkpoints/approvals), unlike M1's
// generic items envelope, and the UI reads the key literally.
func TestM4ListsNeverNull(t *testing.T) {
	fx := m4Server(t) // every list empty
	cases := []struct{ target, key string }{
		{"/api/v1/pipelines", "pipelines"},
		{"/api/v1/pipelines/" + m4UUID + "/revisions", "revisions"},
		{"/api/v1/pipelines/" + m4UUID + "/drafts", "drafts"},
		{"/api/v1/projects/p-1/assignments", "assignments"},
		{"/api/v1/projects/p-1/runs", "runs"},
		{"/api/v1/runs/" + m4UUID + "/nodes", "node_executions"},
		{"/api/v1/runs/" + m4UUID + "/checkpoints", "checkpoints"},
		{"/api/v1/projects/p-1/approvals", "approvals"},
	}
	// Make the project-visible pipelines/drafts list routes reach the store.
	fx.pipes.pipeline = PipelineView{ID: m4UUID}
	for _, tc := range cases {
		switch tc.target {
		case "/api/v1/runs/" + m4UUID + "/nodes", "/api/v1/runs/" + m4UUID + "/checkpoints":
			fx.runs.run = RunView{RunSummaryView: RunSummaryView{ID: m4UUID}, MyRole: "viewer"}
		}
		rec := fx.get(t, "http://localhost:8080"+tc.target)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d: %s", tc.target, rec.Code, firstLine(rec.Body.String()))
			continue
		}
		if !strings.Contains(rec.Body.String(), `"`+tc.key+`":[]`) {
			t.Errorf("GET %s body = %s, want %q as [] never null", tc.target, rec.Body, tc.key)
		}
	}
}

// TestM4ReplicaHeader pins that the M4 responses ride the standard chain:
// every response carries X-Communication-Replica (§ 2 conventions — the
// middleware sets it for all routes, this guards a future bypass).
func TestM4ReplicaHeader(t *testing.T) {
	fx := m4PopulatedServer(t)
	rec := fx.get(t, "http://localhost:8080/api/v1/pipelines")
	if rec.Header().Get("X-Communication-Replica") != "replica-a" {
		t.Errorf("replica header = %q", rec.Header().Get("X-Communication-Replica"))
	}
}

// TestM4RetryUnknownNodeIsNotFound is route 31's client-error arm: a body that
// names a node execution the run does not have answers 404 problem+json with
// the stable code node-execution-not-found (never a 500), names the key, and
// nudges nothing — the reopen was refused whole before any row moved.
func TestM4RetryUnknownNodeIsNotFound(t *testing.T) {
	fx := m4PopulatedServer(t)
	fx.runs.retryErr = &NodeExecutionNotFound{NodeInstanceKey: "/build_until_verified[1]/implement"}
	rec := fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry",
		`{"node_instance_keys":["/build_until_verified[1]/implement"]}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown-node retry = %d: %s", rec.Code, rec.Body)
	}
	var problem struct {
		Type            string `json:"type"`
		Status          int    `json:"status"`
		NodeInstanceKey string `json:"node_instance_key"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(problem.Type, "/node-execution-not-found") || problem.Status != 404 {
		t.Errorf("problem body = %+v", problem)
	}
	if problem.NodeInstanceKey != "/build_until_verified[1]/implement" {
		t.Errorf("body names %q, want the key the client sent", problem.NodeInstanceKey)
	}
	if len(fx.triggered) != 0 {
		t.Errorf("a refused retry must not nudge the advancer: %v", fx.triggered)
	}

	// The sentinel alone (a store that cannot name the key) maps the same way.
	fx.runs.retryErr = ErrNodeExecutionNotFound
	rec = fx.call(t, "POST", "http://localhost:8080/api/v1/runs/"+m4UUID+"/retry",
		`{"node_instance_keys":["/nope"]}`)
	if rec.Code != http.StatusNotFound ||
		!strings.Contains(rec.Body.String(), "node-execution-not-found") {
		t.Fatalf("sentinel retry = %d: %s", rec.Code, rec.Body)
	}
}
