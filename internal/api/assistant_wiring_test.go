package api

// ADR-0050 part 2 wiring: the API-level proof that the conversation
// routes, the real ConversationRunner and the store adapters move
// together — a scripted OpenAI-compatible model posts a draft edit
// (the change row records, the draft's bytes move, the closed inverse
// restores them on undo) and a risky action (ask_risky gates it into a
// pending approval_request that ONE confirm executes exactly once).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	as "github.com/dbirks/communication/internal/assistant"
)

// --- the scripted OpenAI-compatible model --------------------------------

// wiringStep is one scripted completion: either a tool turn or a final
// text answer.
type wiringStep struct {
	text  string
	calls []wiringWireCall
}

type wiringWireCall struct {
	name      string
	arguments string // the raw JSON string, model-shaped (untrusted)
}

// newWiringModel stands the fake endpoint: POST /v1/chat/completions
// answers the scripted steps in order.
func newWiringModel(t *testing.T, steps ...wiringStep) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	served := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		idx := served
		served++
		mu.Unlock()
		step := wiringStep{text: "no scripted step is left"}
		if idx < len(steps) {
			step = steps[idx]
		}
		resp := map[string]any{
			"choices": []map[string]any{{
				"message":       step.wireMessage(),
				"finish_reason": "stop",
			}},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (s wiringStep) wireMessage() map[string]any {
	m := map[string]any{"content": nil}
	if s.text != "" {
		blob, _ := json.Marshal(s.text)
		m["content"] = json.RawMessage(blob)
	}
	if len(s.calls) > 0 {
		calls := make([]map[string]any, 0, len(s.calls))
		for i, c := range s.calls {
			calls = append(calls, map[string]any{
				"id":   fmt.Sprintf("call-%d", i),
				"type": "function",
				"function": map[string]any{
					"name":      c.name,
					"arguments": c.arguments,
				},
			})
		}
		m["tool_calls"] = calls
	}
	return m
}

// --- the fake stores ------------------------------------------------------

// wiringPipeStore is the draft face: one pipeline (pl-1) with one
// published revision and (optionally) open drafts; reads are the
// caller's, writes are CAS.
type wiringPipeStore struct {
	mu          sync.Mutex
	drafts      map[string]wiringDraft
	revision    RevisionSummaryView
	revisionDoc string
	created     int
}

type wiringDraft struct {
	id      string
	doc     string
	version int
}

func newWiringPipeStore(withOpenDraft bool) *wiringPipeStore {
	s := &wiringPipeStore{
		drafts:      map[string]wiringDraft{},
		revision:    RevisionSummaryView{RevisionNumber: 1, Status: "published", RevisionDigest: "digest-1"},
		revisionDoc: wiringDraftYAML,
	}
	if withOpenDraft {
		s.drafts["d-1"] = wiringDraft{id: "d-1", doc: wiringDraftYAML, version: 1}
	}
	return s
}

func (s *wiringPipeStore) GetDraft(_ context.Context, _ Caller, draftID string) (DraftView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.drafts[draftID]
	if !ok {
		return DraftView{}, ErrPipelineNotFound
	}
	return DraftView{ID: d.id, DocumentYAML: d.doc, Version: d.version, Status: "draft"}, nil
}

func (s *wiringPipeStore) ReplaceDraft(_ context.Context, _ Caller, draftID, documentYAML, _ string, expectedVersion int) (DraftView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.drafts[draftID]
	if !ok {
		return DraftView{}, ErrPipelineNotFound
	}
	if d.version != expectedVersion {
		return DraftView{}, &DraftConflictError{
			Kind:           DraftConflictStaleVersion,
			DraftID:        draftID,
			CurrentVersion: d.version,
			Detail:         "stale",
		}
	}
	d.doc, d.version = documentYAML, d.version+1
	s.drafts[draftID] = d
	return DraftView{ID: d.id, DocumentYAML: d.doc, Version: d.version, Status: "draft"}, nil
}

func (s *wiringPipeStore) ListPipelineDrafts(_ context.Context, _ Caller, pipelineID string) ([]DraftSummaryView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pipelineID != "pl-1" {
		return nil, ErrPipelineNotFound
	}
	var out []DraftSummaryView
	for _, d := range s.drafts {
		out = append(out, DraftSummaryView{ID: d.id, Status: "draft", Version: d.version, UpdatedAt: time.Now().UTC()})
	}
	return out, nil
}

func (s *wiringPipeStore) ListPipelineRevisions(_ context.Context, _ Caller, pipelineID string) ([]RevisionSummaryView, error) {
	if pipelineID != "pl-1" {
		return nil, ErrPipelineNotFound
	}
	return []RevisionSummaryView{s.revision}, nil
}

func (s *wiringPipeStore) GetRevision(_ context.Context, _ Caller, digestOrID string) (RevisionView, error) {
	if digestOrID != s.revision.RevisionDigest {
		return RevisionView{}, ErrPipelineNotFound
	}
	return RevisionView{ID: "rev-1", PipelineID: "pl-1", DocumentText: s.revisionDoc, Status: "published"}, nil
}

func (s *wiringPipeStore) CreateDraft(_ context.Context, _ Caller, pipelineID string, in DraftCreateInput) (DraftView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pipelineID != "pl-1" {
		return DraftView{}, ErrPipelineNotFound
	}
	s.created++
	id := fmt.Sprintf("d-auto-%d", s.created)
	s.drafts[id] = wiringDraft{id: id, doc: in.DocumentYAML, version: 1}
	return DraftView{ID: id, DocumentYAML: in.DocumentYAML, Version: 1, Status: "draft"}, nil
}

// ListPipelines is the caller's own pipeline list the workflow.draft
// lookup resolves a slug or display name against: one visible pipeline
// (pl-1); anything else is not in the list, so the not-found sentinel
// keeps its existence hidden.
func (s *wiringPipeStore) ListPipelines(_ context.Context, _ Caller) ([]PipelineSummaryView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return []PipelineSummaryView{{
		ID: "pl-1", Slug: "feature-development", DisplayName: "Feature Development",
	}}, nil
}

// currentDoc reports the open draft's bytes and version for the asserts.
func (s *wiringPipeStore) currentDoc(t *testing.T, draftID string) (string, int) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.drafts[draftID]
	return d.doc, d.version
}

// wiringRuns is the run face: the caller's read plus the two lifecycle
// writes, each counted so "executed exactly once" is a fact.
type wiringRuns struct {
	mu          sync.Mutex
	createCalls int
	retryCalls  int
}

func (r *wiringRuns) GetRun(_ context.Context, _ Caller, runID string) (RunView, error) {
	if runID != "run-1" {
		return RunView{}, ErrRunNotFound
	}
	return RunView{ID: runID}, nil
}

func (r *wiringRuns) CreateRun(_ context.Context, _ Caller, in RunCreateInput) (RunView, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.createCalls++
	return RunView{ID: "run-new"}, true, nil
}

func (r *wiringRuns) RetryRun(_ context.Context, _ Caller, runID string, _ RunRetryInput) (RunView, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.retryCalls++
	return RunView{ID: runID}, nil
}

func (r *wiringRuns) counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.createCalls, r.retryCalls
}

type wiringAssignments struct{}

func (wiringAssignments) ListAssignments(_ context.Context, _ Caller, projectID string, _ AssignmentListFilter) ([]AssignmentView, error) {
	if projectID != "p-1" {
		return nil, ErrProjectNotFound
	}
	return []AssignmentView{{ID: "as-1", ProjectID: "p-1", PipelineID: "pl-1", PinnedRevisionID: "rev-1"}}, nil
}

type wiringApprovals struct {
	mu      sync.Mutex
	decides int
}

func (a *wiringApprovals) GetApproval(_ context.Context, _ Caller, approvalID string) (ApprovalView, error) {
	if approvalID != "ap-1" {
		return ApprovalView{}, ErrApprovalNotFound
	}
	return ApprovalView{
		ID: "ap-1", ProjectID: "p-1", RunID: "run-1",
		ApproverUserIDs: []string{"u-1"}, Version: 1, State: "pending",
	}, nil
}

func (a *wiringApprovals) DecideApproval(_ context.Context, _ Caller, approvalID, decision, _ string, version int, authorize ApproverAuthorize) (ApprovalView, error) {
	ap, err := a.GetApproval(context.Background(), Caller{UserID: "u-1"}, approvalID)
	if err != nil || version != ap.Version {
		return ApprovalView{}, ErrApprovalNotFound
	}
	if ok, _ := authorize(ap, "u-1"); !ok {
		return ApprovalView{}, fmt.Errorf("not a designated approver")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.decides++
	ap.State, ap.Decision = "decided", &decision
	return ap, nil
}

type wiringProjects struct{}

func (wiringProjects) GetProject(_ context.Context, _ Caller, projectID string) (ProjectView, error) {
	if projectID != "p-1" {
		return ProjectView{}, ErrProjectNotFound
	}
	return ProjectView{ID: "p-1", MyRole: "member"}, nil
}

// wiringReadStore is the broker's read-only registry face: every tool
// reads rows the caller may read (here: none), so the loop's answers are
// built from its own write-tool outcomes alone.
type wiringReadStore struct{ calls []string }

func (s *wiringReadStore) ListProjects(_ context.Context, _ as.Caller) (json.RawMessage, error) {
	s.calls = append(s.calls, "projects")
	return json.RawMessage(`[]`), nil
}
func (s *wiringReadStore) ListPipelines(_ context.Context, _ as.Caller) (json.RawMessage, error) {
	s.calls = append(s.calls, "pipelines")
	return json.RawMessage(`[]`), nil
}
func (s *wiringReadStore) ListProjectRuns(_ context.Context, _ as.Caller, _ string) (json.RawMessage, error) {
	s.calls = append(s.calls, "runs")
	return json.RawMessage(`[]`), nil
}
func (s *wiringReadStore) ListRunNodes(_ context.Context, _ as.Caller, _ string) (json.RawMessage, error) {
	s.calls = append(s.calls, "nodes")
	return json.RawMessage(`[]`), nil
}
func (s *wiringReadStore) ListProjectApprovals(_ context.Context, _ as.Caller, _ string) (json.RawMessage, error) {
	s.calls = append(s.calls, "approvals")
	return json.RawMessage(`[]`), nil
}
func (s *wiringReadStore) ListPipelineRevisions(_ context.Context, _ as.Caller, _ string) (json.RawMessage, error) {
	s.calls = append(s.calls, "revisions")
	return json.RawMessage(`[]`), nil
}
func (s *wiringReadStore) ListAgentProfiles(_ context.Context, _ as.Caller) (json.RawMessage, error) {
	s.calls = append(s.calls, "profiles")
	return json.RawMessage(`[]`), nil
}

// wiringUndoStore is the fake conversation store plus the REAL undo seam:
// it records each change's undo payload as the turn appends, and its
// UndoChange applies the inverse through the caller's Undoer exactly the
// way the Postgres store's undoOne transaction does (already-undone and
// not-undoable keep their stable 409 sentinels).
type wiringUndoStore struct {
	*fakeAssistantStore
	undoer   as.Undoer
	mu       sync.Mutex
	payloads map[string][]byte
	convID   string
}

func newWiringUndoStore(inner *fakeAssistantStore, undoer as.Undoer) *wiringUndoStore {
	return &wiringUndoStore{fakeAssistantStore: inner, undoer: undoer, payloads: map[string][]byte{}}
}

func (w *wiringUndoStore) AppendTurn(ctx context.Context, userID, conversationID string,
	in AppendTurnInput) ([]AssistantMessage, error) {
	out, err := w.fakeAssistantStore.AppendTurn(ctx, userID, conversationID, in)
	if err != nil {
		return nil, err
	}
	w.mu.Lock()
	w.convID = conversationID
	w.mu.Unlock()
	i := 0
	for _, m := range out {
		if m.Kind != "change" {
			continue
		}
		var p struct {
			ChangeID string `json:"change_id"`
		}
		if json.Unmarshal(m.Payload, &p) == nil && i < len(in.Changes) && in.Changes[i].UndoPayload != nil {
			w.payloads[p.ChangeID] = in.Changes[i].UndoPayload
		}
		i++
	}
	return out, nil
}

func (w *wiringUndoStore) UndoChange(ctx context.Context, c as.Caller, changeID string) (AssistantChange, error) {
	w.mu.Lock()
	convID := w.convID
	w.mu.Unlock()
	chs, err := w.fakeAssistantStore.ListChanges(ctx, c.UserID, convID, "all")
	if err != nil {
		return AssistantChange{}, err
	}
	var ch *AssistantChange
	for i := range chs {
		if chs[i].ID == changeID {
			ch = &chs[i]
		}
	}
	if ch == nil {
		return AssistantChange{}, fmt.Errorf("x: %w", ErrAssistantChangeNotFound)
	}
	if ch.UndoneAt != nil {
		return AssistantChange{}, fmt.Errorf("x: %w", ErrAssistantChangeAlreadyUndone)
	}
	w.mu.Lock()
	payload := w.payloads[changeID]
	w.mu.Unlock()
	if payload == nil {
		return AssistantChange{}, &AssistantChangeNotUndoable{Detail: "the change has no recorded inverse op"}
	}
	if err := w.undoer.UndoChange(ctx, c, changeID, payload); err != nil {
		return AssistantChange{}, &AssistantChangeNotUndoable{Detail: err.Error()}
	}
	now := time.Now().UTC()
	return AssistantChange{
		ID: ch.ID, Kind: ch.Kind, TargetRef: ch.TargetRef, Summary: ch.Summary,
		Undoable: ch.Undoable, UndoneAt: &now, CreatedAt: ch.CreatedAt,
	}, nil
}

// --- the server under test ------------------------------------------------

// wiringDraftYAML is a schema-valid two-node draft the ops can load and
// edit (the pipeline schema requires spec.inputs).
const wiringDraftYAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: wiring-fixture
spec:
  inputs: {type: object}
  nodes:
  - id: plan
    kind: agent.acp
    config: {profile: planner, prompt: plan the change}
  - id: check
    kind: model.chat
    dependsOn: [plan]
    config:
      model: test-model
      messages:
      - role: user
        content: inspect the plan
`

func newWiringServer(t *testing.T, model *httptest.Server, store *wiringUndoStore,
	pipe *wiringPipeStore, runs *wiringRuns, approvals *wiringApprovals,
	trust func(ctx context.Context, c as.Caller) (string, bool)) *Server {
	t.Helper()
	b, err := as.New(as.Config{BaseURL: model.URL + "/v1", Model: "wiring-model"},
		&wiringReadStore{})
	if err != nil {
		t.Fatalf("broker: %v", err)
	}
	draft := NewAssistantDraftService(pipe)
	runner := as.NewConversationRunner(as.ConversationRunnerDeps{
		Broker: b,
		Draft:  draft,
		Actions: NewAssistantActions(AssistantActionsDeps{
			Runs:        runs,
			Assignments: wiringAssignments{},
			Approvals:   approvals,
			Projects:    wiringProjects{},
		}),
	})
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: "http://localhost:8080"},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterAssistantConversations(s, AssistantConversationDeps{
		Store: store, Runner: runner, TrustLevel: trust,
	})
	return s
}

// TestAssistantWiringDraftEditChangeAndUndo: post "add a step" and the
// scripted model's draft.apply (the ADR-0044 op set) lands through the
// version-checked PUT — the draft's bytes move, a draft_edit change row
// with its closed inverse is appended — and the change's undo restores
// the draft through the same PUT.
func TestAssistantWiringDraftEditChangeAndUndo(t *testing.T) {
	t.Parallel()
	pipe := newWiringPipeStore(true)
	inner := newFakeAssistantStore()
	inner.seedConversation("u-1", "conv-1", "t")
	undoer := as.DraftEditUndoer{Draft: NewAssistantDraftService(pipe)}
	store := newWiringUndoStore(inner, undoer)
	model := newWiringModel(t,
		wiringStep{calls: []wiringWireCall{{
			name: "draft_apply",
			arguments: `{"draft_id":"d-1","version":"1","op":"insert_on_edge",` +
				`"from":"plan","to":"check","kind":"agent.acp","id":"review",` +
				`"config":"{\"profile\":\"planner\",\"prompt\":\"review the plan\"}"}`,
		}}},
		wiringStep{text: "Added the review step."},
	)
	srv := newWiringServer(t, model, store, pipe, &wiringRuns{}, &wiringApprovals{}, nil)

	rec := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages",
		`{"text":"add a step"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("post: status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	msgs := body["messages"].([]any)
	var changeID string
	var changeKind, undoable any
	var assistantRow bool
	for _, m := range msgs {
		mm := m.(map[string]any)
		if mm["kind"] == "assistant" {
			assistantRow = true
		}
		if mm["kind"] != "change" {
			continue
		}
		pl := mm["payload"].(map[string]any)
		changeID, changeKind, undoable = pl["change_id"].(string), pl["change_kind"], pl["undoable"]
	}
	if changeID == "" || changeKind != "draft_edit" || undoable != true || !assistantRow {
		t.Fatalf("rows = %v, want an assistant row and an undoable draft_edit change", msgs)
	}
	doc, version := pipe.currentDoc(t, "d-1")
	if !strings.Contains(doc, "review") || version != 2 {
		t.Fatalf("draft not updated (version %d):\n%s", version, doc)
	}

	// The closed inverse restores the draft through the same CAS PUT.
	rec2 := convPost(t, srv, "http://localhost:8080/api/v1/assistant/changes/"+changeID+"/undo", "")
	if rec2.Code != http.StatusOK {
		t.Fatalf("undo: status = %d, want 200 (body %s)", rec2.Code, rec2.Body)
	}
	if decodeBody(t, rec2)["undone_at"] == nil {
		t.Fatalf("undo response = %s, want undone_at set", rec2.Body)
	}
	doc2, version2 := pipe.currentDoc(t, "d-1")
	if strings.Contains(doc2, "review") {
		t.Fatalf("undo left the inserted node behind (version %d):\n%s", version2, doc2)
	}
	if version2 != 3 {
		t.Fatalf("undo version = %d, want 3 (the inverse is a second CAS write)", version2)
	}
	// A second undo of the same row is the stable 409.
	rec3 := convPost(t, srv, "http://localhost:8080/api/v1/assistant/changes/"+changeID+"/undo", "")
	if rec3.Code != http.StatusConflict {
		t.Fatalf("second undo: status = %d, want 409 (body %s)", rec3.Code, rec3.Body)
	}
}

// TestAssistantWiringRiskyGatedThenConfirmed: with the ADR's default
// trust (ask_risky, the route's nil reader) the scripted run.start is
// NOT executed — the turn appends the pending approval_request — and ONE
// confirm executes the action exactly once as the caller.
func TestAssistantWiringRiskyGatedThenConfirmed(t *testing.T) {
	t.Parallel()
	pipe := newWiringPipeStore(true)
	runs := &wiringRuns{}
	approvals := &wiringApprovals{}
	inner := newFakeAssistantStore()
	inner.seedConversation("u-1", "conv-1", "t")
	store := newWiringUndoStore(inner, as.DraftEditUndoer{Draft: NewAssistantDraftService(pipe)})
	model := newWiringModel(t,
		wiringStep{calls: []wiringWireCall{{
			name:      "run_start",
			arguments: `{"project_id":"p-1","pipeline_id":"pl-1"}`,
		}}},
		wiringStep{text: "This action needs your approval before I start it."},
	)
	srv := newWiringServer(t, model, store, pipe, runs, approvals, nil) // nil → ask_risky

	rec := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages",
		`{"text":"start a run"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("post: status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	var approvalID string
	var action, state any
	for _, m := range decodeBody(t, rec)["messages"].([]any) {
		mm := m.(map[string]any)
		if mm["kind"] != "approval_request" {
			continue
		}
		approvalID = mm["id"].(string)
		pl := mm["payload"].(map[string]any)
		action, state = pl["action"], pl["state"]
	}
	if approvalID == "" || action != "run.start" || state != "pending" {
		t.Fatalf("approval request = %v/%v (id %q), want a pending run.start card", action, state, approvalID)
	}
	if n, _ := runs.counts(); n != 0 {
		t.Fatalf("a gated action executed: %d run starts", n)
	}

	// ONE confirm re-runs the recorded action exactly once, as the caller.
	rec2 := convPost(t, srv,
		"http://localhost:8080/api/v1/assistant/conversations/conv-1/messages",
		`{"confirm":`+"\""+approvalID+"\""+`}`)
	if rec2.Code != http.StatusOK {
		t.Fatalf("confirm: status = %d, want 200 (body %s)", rec2.Code, rec2.Body)
	}
	n, _ := runs.counts()
	if n != 1 {
		t.Fatalf("confirm executed the action %d times, want exactly 1", n)
	}
	if approvals.decides != 0 {
		t.Fatalf("confirm took the wrong path: %d approval decisions", approvals.decides)
	}
}

// TestAssistantWiringDraftCreatedFromLatestRevision: the draft service's
// no-open-draft case — a pipeline reference with no open draft creates a
// draft from the latest PUBLISHED revision (the caller's own CreateDraft,
// the clone's regenerated bytes), and a second read finds the open draft
// instead of a second creation.
func TestAssistantWiringDraftCreatedFromLatestRevision(t *testing.T) {
	t.Parallel()
	pipe := newWiringPipeStore(false)
	svc := NewAssistantDraftService(pipe)
	caller := as.Caller{UserID: "u-1", OrganizationID: "o-1"}

	doc, err := svc.GetDocument(context.Background(), caller, "pl-1")
	if err != nil {
		t.Fatalf("GetDocument: %v", err)
	}
	if doc.Version != 1 || string(doc.Document) != wiringDraftYAML || pipe.created != 1 {
		t.Fatalf("created = %d, version = %d; want one draft at version 1 from the revision",
			pipe.created, doc.Version)
	}
	// A second read resolves to the open draft: no second creation.
	if _, err := svc.GetDocument(context.Background(), caller, "pl-1"); err != nil || pipe.created != 1 {
		t.Fatalf("second read: err = %v, created = %d, want no new draft", err, pipe.created)
	}
	// A nonsense reference is the not-found sentinel, existence hidden.
	if _, err := svc.GetDocument(context.Background(), caller, "does-not-exist"); err == nil {
		t.Fatalf("a nonsense reference resolved, want the not-found sentinel")
	}
}

// TestAssistantWiringPipelineDraftLookup: the workflow.draft service face
// — the "what is the open draft of workflow X?" read. It resolves the
// reference by id, by slug and by display name (case-insensitive),
// answers a null draft for a workflow with none open (the tool's hint
// then names the create-from-latest-revision behaviour), and keeps an
// invisible pipeline's existence hidden behind the not-found sentinel.
func TestAssistantWiringPipelineDraftLookup(t *testing.T) {
	t.Parallel()
	caller := as.Caller{UserID: "u-1", OrganizationID: "o-1"}

	// locator asserts the DraftLocator face the api's draft service
	// carries (the runner's type-assertion finds it through the very
	// same NewAssistantDraftService in production).
	locator := func(t *testing.T, svc as.DraftService) as.DraftLocator {
		t.Helper()
		loc, ok := svc.(as.DraftLocator)
		if !ok {
			t.Fatalf("the api's draft service does not carry the DraftLocator face")
		}
		return loc
	}

	t.Run("by_id_slug_and_display_name", func(t *testing.T) {
		t.Parallel()
		for _, ref := range []string{"pl-1", "feature-development", "Feature Development", "feature"} {
			pipe := newWiringPipeStore(true)
			loc := locator(t, NewAssistantDraftService(pipe))
			view, err := loc.PipelineDraft(context.Background(), caller, ref)
			if err != nil {
				t.Fatalf("ref %q: %v", ref, err)
			}
			if view.PipelineID != "pl-1" || view.Slug != "feature-development" || view.DisplayName != "Feature Development" {
				t.Fatalf("ref %q: view = %+v, want the resolved workflow", ref, view)
			}
			if view.Draft == nil || view.Draft.DraftID != "d-1" || view.Draft.Version != 1 {
				t.Fatalf("ref %q: draft = %+v, want the open draft", ref, view.Draft)
			}
			if view.LatestRev == nil || view.LatestRev.Number != 1 {
				t.Fatalf("ref %q: latest revision = %+v, want the published one", ref, view.LatestRev)
			}
		}
	})

	t.Run("no_open_draft_is_null", func(t *testing.T) {
		t.Parallel()
		pipe := newWiringPipeStore(false)
		loc := locator(t, NewAssistantDraftService(pipe))
		view, err := loc.PipelineDraft(context.Background(), caller, "pl-1")
		if err != nil {
			t.Fatalf("PipelineDraft: %v", err)
		}
		if view.Draft != nil {
			t.Fatalf("draft = %+v, want null (the tool's hint names the create behaviour)", view.Draft)
		}
		if view.LatestRev == nil || view.LatestRev.Number != 1 {
			t.Fatalf("latest revision = %+v, want the published one", view.LatestRev)
		}
	})

	t.Run("no_published_revision_is_null", func(t *testing.T) {
		t.Parallel()
		pipe := newWiringPipeStore(false)
		pipe.revision.Status = "deprecated" // nothing published to draft from
		loc := locator(t, NewAssistantDraftService(pipe))
		view, err := loc.PipelineDraft(context.Background(), caller, "pl-1")
		if err != nil {
			t.Fatalf("PipelineDraft: %v", err)
		}
		if view.LatestRev != nil {
			t.Fatalf("latest revision = %+v, want null", view.LatestRev)
		}
	})

	t.Run("another_orgs_pipeline_is_not_found", func(t *testing.T) {
		t.Parallel()
		pipe := newWiringPipeStore(true)
		loc := locator(t, NewAssistantDraftService(pipe))
		for _, ref := range []string{"pl-2", "other-org-pipeline"} {
			if _, err := loc.PipelineDraft(context.Background(), caller, ref); !errors.Is(err, ErrPipelineNotFound) {
				t.Fatalf("ref %q: err = %v, want the not-found sentinel (existence hidden)", ref, err)
			}
		}
	})
}
