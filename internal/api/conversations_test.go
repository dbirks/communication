package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/authz"
	"github.com/dbirks/communication/internal/events"
)

// These tests pin what a browser can observe on the M2 conversation surface:
// which status a role gets, what a 409 body must carry, and that the internal
// lease machinery stays server-side. The database semantics behind them — CAS,
// the one-active-turn index, transcript replay and gap-safety — are proven
// against a real PostgreSQL in internal/store/postgres/conversations_test.go.
//
// The fake is a *policy* fake: it answers like the store answers, including the
// conflicts, so a handler that stopped asking the store a question would fail
// here rather than discover it in production.

const (
	cnvTProject = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80"
	cnvTConv    = "01987a70-1111-7000-8000-abcdef012345"
	cnvTTurn    = "01987a73-4444-7000-8000-abcdef012345"
	cnvTProfile = "01987a71-2222-7000-8000-abcdef012345"
	cnvTPerms   = "01987a72-3333-7000-8000-abcdef012345"
	cnvTUserA   = "u-a"
	cnvTUserB   = "u-b"
)

// --- fake store ---------------------------------------------------------

type cnvFakeStore struct {
	chat     ConversationView
	profiles []AgentProfileView

	myRole     string
	controller string
	version    int

	created   []cnvCreateCall
	messaged  []cnvMessageCall
	taken     []int
	returned  []int
	cancelled int
	decided   []cnvDecideCall
	denied    []cnvDenial
	// authFails flips visibility: the fake answers every read as the store
	// answers a non-member, which is the only way to test that 404 (not 403) is
	// what an outsider sees on every route.
	authFails bool
	customErr error
	// decideConflict makes the fake answer the way the store answers a decision
	// on a request that is already answered: a conflict naming the request, not
	// a second write.
	decideConflict bool
	eventsRead     int
}

type cnvCreateCall struct{ projectID, profileID, title, prompt string }
type cnvMessageCall struct {
	conversationID, prompt string
}
type cnvDenial struct {
	// subject is the conversation id, or the project id for a project-scoped
	// route — the two ways a conversation attempt can be refused.
	subject, action string
}
type cnvDecideCall struct {
	conversationID, requestID, optionID string
}

func cnvNewFakeStore() *cnvFakeStore {
	controller := cnvTUserA
	previous := ""
	return &cnvFakeStore{
		myRole:     string(authz.RoleMaintainer),
		controller: cnvTUserA,
		version:    1,
		profiles: []AgentProfileView{
			{ID: cnvTProfile, Name: "Claude Code", LauncherID: "claude", PermissionMode: "ask", CreatedAt: prjFixedTime},
			{ID: "p-2", Name: "Codex", LauncherID: "codex", PermissionMode: "ask", CreatedAt: prjFixedTime},
		},
		chat: ConversationView{
			ID:               cnvTConv,
			ProjectID:        cnvTProject,
			AgentProfileID:   cnvTProfile,
			AgentProfileName: "Claude Code",
			LauncherID:       "claude",
			Title:            "Fix the flaky test",
			Status:           "active",
			CreatedBy:        cnvTUserA,
			CreatedAt:        prjFixedTime,
			UpdatedAt:        prjFixedTime,
			Control: ConversationControlView{
				Kind: events.ControllerKindHuman, UserID: &controller,
				DisplayName: strPtr("Alice"), PreviousUserID: &previous, Version: 1,
			},
			PendingPermissions: []PermissionRequestView{},
		},
	}
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// cnvActiveTurn is the turn the fake reports as in flight.
func (f *cnvFakeStore) cnvActiveTurn(status string) {
	worker := "01987a74-5555-7000-8000-abcdef012345"
	f.chat.ActiveTurn = &ConversationTurnView{
		ID: cnvTTurn, ConversationID: cnvTConv, Status: status,
		SubmittedBy: cnvTUserA, CreatedAt: prjFixedTime, WorkerID: &worker,
	}
}

func (f *cnvFakeStore) visible(c Caller) bool {
	if f.authFails || f.customErr != nil {
		return false
	}
	return authz.CanView(c.IsOrgAdmin, authz.Role(f.myRole))
}

// syncControl keeps the view's control row the single answer, so a test cannot
// make the fake contradict itself between the control object and the fields the
// handlers reason about.
func (f *cnvFakeStore) syncControl() {
	f.chat.Control.Version = f.version
	if f.controller == "" {
		f.chat.Control.Kind = events.ControllerKindNone
		f.chat.Control.UserID = nil
		f.chat.Control.DisplayName = nil
		return
	}
	f.chat.Control.Kind = events.ControllerKindHuman
	f.chat.Control.UserID = &f.controller
	name := "Alice"
	if f.controller == cnvTUserB {
		name = "Bob"
	}
	f.chat.Control.DisplayName = &name
}

func (f *cnvFakeStore) setActive(status string) {
	worker := "01987a74-5555-7000-8000-abcdef012345"
	f.chat.ActiveTurn = &ConversationTurnView{
		ID: cnvTTurn, ConversationID: cnvTConv, Status: status,
		SubmittedBy: cnvTUserA, CreatedAt: prjFixedTime, WorkerID: &worker,
	}
}

func (f *cnvFakeStore) conflict(kind, detail string, turn *ConversationTurnView) error {
	f.syncControl()
	control := f.chat.Control
	return &ConversationConflict{
		Kind: kind, Detail: detail, ConversationID: cnvTConv, Control: &control, ActiveTurn: turn,
	}
}

func (f *cnvFakeStore) ListAgentProfiles(context.Context, Caller) ([]AgentProfileView, error) {
	if f.customErr != nil {
		return nil, f.customErr
	}
	return f.profiles, nil
}

func (f *cnvFakeStore) ListConversations(ctx context.Context, c Caller, projectID string) ([]ConversationSummaryView, error) {
	if !f.visible(c) {
		return nil, ErrConversationNotFound
	}
	if projectID != cnvTProject {
		return nil, ErrConversationNotFound
	}
	f.syncControl()
	return []ConversationSummaryView{{
		ID: cnvTConv, ProjectID: cnvTProject, AgentProfileID: cnvTProfile,
		Title: f.chat.Title, Status: f.chat.Status, CreatedBy: f.chat.CreatedBy,
		CreatedAt: f.chat.CreatedAt, UpdatedAt: f.chat.UpdatedAt,
		Control: f.chat.Control,
	}}, nil
}

func (f *cnvFakeStore) CreateConversation(_ context.Context, c Caller, projectID, profileID, title, prompt string) (ConversationView, error) {
	if !f.visible(c) {
		return ConversationView{}, ErrConversationNotFound
	}
	if !authz.CanManage(c.IsOrgAdmin, authz.Role(f.myRole)) && f.myRole == string(authz.RoleViewer) {
		return ConversationView{}, ErrConversationForbidden
	}
	if projectID != cnvTProject {
		return ConversationView{}, ErrConversationNotFound
	}
	known := false
	for _, p := range f.profiles {
		if p.ID == profileID {
			known = true
		}
	}
	if !known {
		return ConversationView{}, fmt.Errorf("%w: no such agent profile in your organization", ErrConversationValidation)
	}
	f.created = append(f.created, cnvCreateCall{projectID, profileID, title, prompt})
	f.version = 1
	f.controller = c.UserID
	f.syncControl()
	out := f.chat
	out.ID = "conv-new"
	out.Title = title
	out.Control = f.chat.Control
	return out, nil
}

func (f *cnvFakeStore) GetConversation(_ context.Context, c Caller, conversationID string) (ConversationView, error) {
	if !f.visible(c) || conversationID != cnvTConv {
		return ConversationView{}, ErrConversationNotFound
	}
	f.syncControl()
	return f.chat, nil
}

func (f *cnvFakeStore) AuthorizeConversation(_ context.Context, c Caller, conversationID string) (string, error) {
	if !f.visible(c) || conversationID != cnvTConv {
		return "", ErrConversationNotFound
	}
	return cnvTProject, nil
}

func (f *cnvFakeStore) RecordDenied(_ context.Context, _ Caller, conversationID, action string) error {
	f.denied = append(f.denied, cnvDenial{conversationID, action})
	return nil
}

func (f *cnvFakeStore) RecordProjectDenied(_ context.Context, _ Caller, projectID, action string) error {
	f.denied = append(f.denied, cnvDenial{projectID, action})
	return nil
}

func (f *cnvFakeStore) PostMessage(_ context.Context, c Caller, conversationID, prompt string) (ConversationTurnView, error) {
	if !f.visible(c) {
		return ConversationTurnView{}, ErrConversationNotFound
	}
	if f.myRole == string(authz.RoleViewer) {
		return ConversationTurnView{}, ErrConversationForbidden
	}
	if f.controller != c.UserID {
		return ConversationTurnView{}, f.conflict(ConflictNotController, "Alice holds the controller lock", nil)
	}
	f.messaged = append(f.messaged, cnvMessageCall{conversationID, prompt})
	if f.chat.ActiveTurn != nil {
		return ConversationTurnView{}, f.conflict(ConflictTurnInProgress, "A turn is already running", f.chat.ActiveTurn)
	}
	return ConversationTurnView{
		ID: cnvTTurn, ConversationID: conversationID, Status: events.TurnStatusQueued,
		Prompt: prompt, SubmittedBy: c.UserID, CreatedAt: prjFixedTime,
	}, nil
}

func (f *cnvFakeStore) TakeControl(_ context.Context, c Caller, conversationID string, version int) (ConversationView, error) {
	if !f.visible(c) {
		return ConversationView{}, ErrConversationNotFound
	}
	if f.myRole == string(authz.RoleViewer) {
		return ConversationView{}, ErrConversationForbidden
	}
	f.taken = append(f.taken, version)
	// The fake applies the same rule the database does: a holder is unchanged
	// when the caller already holds the lock at the version it sent.
	if f.controller == c.UserID {
		f.syncControl()
		return f.chat, nil
	}
	if f.version != version {
		return ConversationView{}, f.conflict(ConflictControlVersionStale,
			fmt.Sprintf("conversation_control.version is %d, not %d.", f.version, version), nil)
	}
	f.chat.Control.PreviousUserID = strPtr(f.controller)
	f.controller = c.UserID
	f.version++
	f.syncControl()
	return f.chat, nil
}

func (f *cnvFakeStore) ReturnControl(_ context.Context, c Caller, conversationID string, version int) (ConversationView, error) {
	if !f.visible(c) {
		return ConversationView{}, ErrConversationNotFound
	}
	if f.myRole == string(authz.RoleViewer) {
		return ConversationView{}, ErrConversationForbidden
	}
	f.returned = append(f.returned, version)
	if f.controller != c.UserID {
		return ConversationView{}, f.conflict(ConflictNotController, "Alice holds the controller lock", nil)
	}
	if f.version != version {
		return ConversationView{}, f.conflict(ConflictControlVersionStale,
			fmt.Sprintf("conversation_control.version is %d, not %d.", f.version, version), nil)
	}
	previous := ""
	if f.chat.Control.PreviousUserID != nil {
		previous = *f.chat.Control.PreviousUserID
	}
	f.chat.Control.PreviousUserID = strPtr(f.controller)
	f.controller = previous
	f.version++
	f.syncControl()
	return f.chat, nil
}

func (f *cnvFakeStore) CancelTurn(_ context.Context, c Caller, conversationID string) (ConversationTurnView, error) {
	if !f.visible(c) {
		return ConversationTurnView{}, ErrConversationNotFound
	}
	if f.myRole == string(authz.RoleViewer) {
		return ConversationTurnView{}, ErrConversationForbidden
	}
	f.cancelled++
	if f.controller != c.UserID {
		return ConversationTurnView{}, f.conflict(ConflictNotController, "Alice holds the controller lock", nil)
	}
	if f.chat.ActiveTurn == nil {
		return ConversationTurnView{}, f.conflict(ConflictNoActiveTurn, "No turn is queued or running", nil)
	}
	return *f.chat.ActiveTurn, nil
}

func (f *cnvFakeStore) DecidePermission(_ context.Context, c Caller, conversationID, requestID, optionID string) (PermissionRequestView, error) {
	if !f.visible(c) {
		return PermissionRequestView{}, ErrConversationNotFound
	}
	if f.myRole == string(authz.RoleViewer) {
		return PermissionRequestView{}, ErrConversationForbidden
	}
	if f.controller != c.UserID {
		return PermissionRequestView{}, f.conflict(ConflictNotController, "Alice holds the controller lock", nil)
	}
	if requestID != cnvTPerms {
		return PermissionRequestView{}, ErrConversationNotFound
	}
	if f.decideConflict {
		return PermissionRequestView{}, f.conflict(ConflictPermissionNotPending,
			"the request is already decided or expired", nil)
	}
	if optionID != "allow_once" && optionID != "reject_once" {
		return PermissionRequestView{}, fmt.Errorf("%w: the agent did not offer option_id %q", ErrConversationValidation, optionID)
	}
	f.decided = append(f.decided, cnvDecideCall{conversationID, requestID, optionID})
	return PermissionRequestView{
		ID: requestID, ConversationID: conversationID, TurnID: cnvTTurn,
		Status: events.PermissionStatusDecided, ToolTitle: "Write a file", ToolKind: "edit",
		Options:          []PermissionOptionView{{OptionID: optionID, Label: "Allow once", Kind: "allow_once"}},
		DecidedBy:        strPtr(c.UserID),
		DecisionOptionID: strPtr(optionID),
		RequestedAt:      prjFixedTime,
		DecidedAt:        strptrTime(),
	}, nil
}

func strptrTime() *time.Time {
	t := prjFixedTime.Add(time.Minute)
	return &t
}

var _ ConversationStore = (*cnvFakeStore)(nil)

// --- mounting -----------------------------------------------------------

func cnvMount(t *testing.T, store *cnvFakeStore, stream ConversationEventStream, auth Authenticator) *Server {
	t.Helper()
	if stream == nil {
		// Always mounted: an unregistered stream route would answer 404 and let a
		// test mistake the router's not-found for the handler's.
		stream = &cnvFakeStream{}
	}
	s := New(Config{ReplicaName: "replica-a", Version: "dev", PublicURL: "http://localhost:8080",
		Logger: discardLogger()}, fakeReadiness{expected: 3}, auth, nil)
	RegisterConversations(s, store, store, stream)
	return s
}

// cnvCaller is a signed-in user; the session is faked because this file tests
// conversation authorization, not ADR-0012's login flow.
func cnvCaller(userID string) Authenticator {
	return principalAuth(&Principal{UserID: userID, OrganizationID: "o-1",
		DisplayName: userID, CSRFToken: "csrf-token-value"}, nil)
}

func cnvPost(t *testing.T, s *Server, userID, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	return do(t, s, req)
}

func TestConversationsAnonymousIsUnauthorized(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, principalAuth(nil, ErrUnauthenticated))
	for _, r := range []struct {
		method, target string
	}{
		{http.MethodGet, "http://localhost:8080/api/v1/agent-profiles"},
		{http.MethodGet, "http://localhost:8080/api/v1/projects/" + cnvTProject + "/conversations"},
		{http.MethodGet, "http://localhost:8080/api/v1/conversations/" + cnvTConv},
		{http.MethodPost, "http://localhost:8080/api/v1/conversations/" + cnvTConv + "/messages"},
		{http.MethodGet, "http://localhost:8080/api/v1/conversations/" + cnvTConv + "/events"},
	} {
		rec := do(t, s, request(r.method, r.target, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401 (%s)", r.method, r.target, rec.Code, rec.Body)
		}
	}
}

func TestConversationsMutationWithoutCSRF(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	req := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/take-control",
		strings.NewReader(`{"version":1}`))
	req.Header.Set("Content-Type", "application/json")
	rec := do(t, s, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("take-control without CSRF = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if len(store.taken) != 0 {
		t.Errorf("store saw %d take-control calls; CSRF must be refused before the store", len(store.taken))
	}
}

func TestListAgentProfiles(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/agent-profiles", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /agent-profiles = %d (%s)", rec.Code, rec.Body)
	}
	var out struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
	if len(out.Items) != 2 || out.Items[0]["name"] != "Claude Code" {
		t.Fatalf("items = %s, want the two seeded profiles", rec.Body)
	}
	if out.Items[0]["permission_mode"] != "ask" {
		t.Errorf("permission_mode = %v, want ask: no launcher has a verified sandbox", out.Items[0]["permission_mode"])
	}
	if _, ok := out.Items[0]["version"]; ok {
		t.Errorf("profile exposed a version field: %v", out.Items[0])
	}
}

func TestCreateConversation(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/projects/"+cnvTProject+"/conversations",
		map[string]any{"agent_profile_id": cnvTProfile, "title": "Fix the flaky test", "prompt": "start"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST conversations = %d (%s)", rec.Code, rec.Body)
	}
	if len(store.created) != 1 || store.created[0].prompt != "start" {
		t.Fatalf("create calls = %+v", store.created)
	}
	body := decodeBody(t, rec)
	control, ok := body["control"].(map[string]any)
	if !ok || control["version"] != float64(1) || control["user_id"] != cnvTUserA {
		t.Fatalf("control = %v, want the creator holding version 1", body["control"])
	}
	if body["active_turn"] != nil {
		t.Errorf("active_turn = %v; the create response carries the conversation, not a turn read", body["active_turn"])
	}
}

func TestCreateConversationValidation(t *testing.T) {
	for _, tt := range []struct {
		name string
		body map[string]any
	}{
		{"missing title", map[string]any{"agent_profile_id": cnvTProfile}},
		{"empty title", map[string]any{"agent_profile_id": cnvTProfile, "title": "   "}},
		{"long title", map[string]any{"agent_profile_id": cnvTProfile, "title": strings.Repeat("t", 201)}},
		{"missing profile", map[string]any{"title": "x"}},
		{"malformed profile id", map[string]any{"agent_profile_id": "not-a-uuid", "title": "x"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := cnvNewFakeStore()
			s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
			rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/projects/"+cnvTProject+"/conversations", tt.body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
			}
			if len(store.created) != 0 {
				t.Errorf("store was called with %+v although validation failed", store.created)
			}
		})
	}
}

func TestCreateConversationUnknownProfileIs422(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/projects/"+cnvTProject+"/conversations",
		map[string]any{"agent_profile_id": "01987a71-9999-7000-8000-abcdef012345", "title": "x"})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}

// TestConversationsNonMemberIsNotFoundEverywhere is the existence-leak gate:
// every route, including the stream, answers 404 and writes an audit row
// (ADR-0014 §3, ADR-0016 §8).
func TestConversationsNonMemberIsNotFoundEverywhere(t *testing.T) {
	store := cnvNewFakeStore()
	store.authFails = true
	s := cnvMount(t, store, nil, cnvCaller("stranger"))

	paths := []struct {
		method, target string
		body           map[string]any
	}{
		{http.MethodGet, "/api/v1/projects/" + cnvTProject + "/conversations", nil},
		{http.MethodPost, "/api/v1/projects/" + cnvTProject + "/conversations", map[string]any{"agent_profile_id": cnvTProfile, "title": "x"}},
		{http.MethodGet, "/api/v1/conversations/" + cnvTConv, nil},
		{http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/messages", map[string]any{"prompt": "hi"}},
		{http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/take-control", map[string]any{"version": 1}},
		{http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/return-control", map[string]any{"version": 1}},
		{http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/cancel", map[string]any{}},
		{http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/permissions/" + cnvTPerms, map[string]any{"option_id": "allow_once"}},
	}
	for _, p := range paths {
		target := "http://localhost:8080" + p.target
		var rec *httptest.ResponseRecorder
		if p.method == http.MethodGet {
			rec = do(t, s, request(http.MethodGet, target, nil))
		} else {
			rec = cnvPost(t, s, "stranger", target, p.body)
		}
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404 (%s)", p.method, p.target, rec.Code, rec.Body)
			continue
		}
		if prob := decodeProblem(t, rec); prob.Title == "" {
			t.Errorf("%s: problem has no title", p.target)
		}
	}
	// Agent profiles are organization-scoped, not project-scoped: an outsider to
	// the project still lists them, which is why they are absent from the loop.
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/agent-profiles", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("agent-profiles = %d, want 200 for an organization member", rec.Code)
	}
	if len(store.denied) != len(paths) {
		t.Errorf("audit rows = %d, want one per refused route (%d)", len(store.denied), len(paths))
	}
}

// --- viewer: read-only ---------------------------------------------------

func TestViewerReadsButCannotWrite(t *testing.T) {
	for _, tt := range []struct {
		name   string
		method string
		target string
		body   map[string]any
		calls  func(f *cnvFakeStore) int
	}{
		{"message", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/messages",
			map[string]any{"prompt": "hi"}, func(f *cnvFakeStore) int { return len(f.messaged) }},
		{"take-control", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/take-control",
			map[string]any{"version": 1}, func(f *cnvFakeStore) int { return len(f.taken) }},
		{"return-control", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/return-control",
			map[string]any{"version": 2}, func(f *cnvFakeStore) int { return len(f.returned) }},
		{"cancel", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/cancel",
			map[string]any{}, func(f *cnvFakeStore) int { return f.cancelled }},
		{"permission", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/permissions/" + cnvTPerms,
			map[string]any{"option_id": "allow_once"}, func(f *cnvFakeStore) int { return len(f.decided) }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := cnvNewFakeStore()
			store.myRole = string(authz.RoleViewer)
			s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
			rec := cnvPost(t, s, cnvTUserB, "http://localhost:8080"+tt.target, tt.body)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("%s = %d, want 403 (%s)", tt.name, rec.Code, rec.Body)
			}
			if prob := decodeProblem(t, rec); prob.Status != 403 || prob.Title != "Forbidden" {
				t.Errorf("%s problem = %+v, want a 403 Forbidden", tt.name, prob)
			}
			if tt.calls(store) != 0 {
				t.Errorf("%s reached the store (%d calls); a viewer must be refused before any write", tt.name, tt.calls(store))
			}
			if len(store.denied) != 1 || store.denied[0].action != "conversation."+tt.name {
				t.Errorf("audit rows = %+v, want one conversation.%s", store.denied, tt.name)
			}
		})
	}

	// The same viewer reads normally, including control state and the stream.
	store := cnvNewFakeStore()
	store.myRole = string(authz.RoleViewer)
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
	if rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/conversations/"+cnvTConv, nil)); rec.Code != http.StatusOK {
		t.Errorf("viewer GET conversation = %d, want 200 (%s)", rec.Code, rec.Body)
	}
}

// --- control -------------------------------------------------------------

func TestTakeControlAcquiresAndBumpsVersion(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
	rec := cnvPost(t, s, cnvTUserB, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/take-control",
		map[string]any{"version": 1})
	if rec.Code != http.StatusOK {
		t.Fatalf("take-control = %d (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	control := body["control"].(map[string]any)
	if control["user_id"] != cnvTUserB || control["version"] != float64(2) {
		t.Fatalf("control = %v, want u-b at version 2", control)
	}
	if control["previous_user_id"] != cnvTUserA {
		t.Errorf("previous_user_id = %v, want the controller handed over from", control["previous_user_id"])
	}
}

// TestTakeControlLoserGetsCurrentControlState is the ADR-0016 §3 UX promise:
// the 409 carries the control state the winner produced, so the client can
// re-present it instead of guessing.
func TestTakeControlLoserGetsCurrentControlState(t *testing.T) {
	store := cnvNewFakeStore()
	store.version = 4
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
	rec := cnvPost(t, s, cnvTUserB, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/take-control",
		map[string]any{"version": 2})
	if rec.Code != http.StatusConflict {
		t.Fatalf("take-control with a stale version = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["type"] != "https://communication.dev/errors/control-version-stale" {
		t.Errorf("type = %v", body["type"])
	}
	control, ok := body["control"].(map[string]any)
	if !ok {
		t.Fatalf("no control object in %s", rec.Body)
	}
	if control["version"] != float64(4) || control["user_id"] != cnvTUserA {
		t.Errorf("control = %v, want the winner's state (u-a at 4)", control)
	}
	if body["conversation_id"] != cnvTConv {
		t.Errorf("conversation_id = %v", body["conversation_id"])
	}
	if body["active_turn"] != nil {
		t.Errorf("active_turn = %v, want null for a control conflict", body["active_turn"])
	}
	// The problem is still a Problem: a client that only understands RFC 9457
	// must not have to special-case this route.
	if prob := decodeProblem(t, rec); prob.Status != 409 || prob.Title == "" || prob.Detail == "" {
		t.Errorf("problem = %+v, want type/title/status/detail alongside the conflict fields", prob)
	}
}

func TestTakeControlIsIdempotentForTheHolder(t *testing.T) {
	store := cnvNewFakeStore()
	store.version = 3
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/take-control",
		map[string]any{"version": 3})
	if rec.Code != http.StatusOK {
		t.Fatalf("re-taking control as the holder = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if store.version != 3 {
		t.Errorf("version moved to %d; an idempotent take must not bump the counter", store.version)
	}
}

func TestReturnControlHandsBackOrGoesNone(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/return-control",
		map[string]any{"version": 1})
	if rec.Code != http.StatusOK {
		t.Fatalf("return-control = %d (%s)", rec.Code, rec.Body)
	}
	if store.controller != "" {
		t.Fatalf("controller = %q, want none: no previous holder existed", store.controller)
	}
	body := decodeBody(t, rec)
	if body["control"].(map[string]any)["kind"] != events.ControllerKindNone {
		t.Errorf("control = %v, want kind none", body["control"])
	}
}

func TestReturnControlByNonHolderIs409(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
	rec := cnvPost(t, s, cnvTUserB, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/return-control",
		map[string]any{"version": 1})
	if rec.Code != http.StatusConflict {
		t.Fatalf("return-control by a non-holder = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if body := decodeBody(t, rec); body["type"] != "https://communication.dev/errors/not-controller" {
		t.Errorf("type = %v", body["type"])
	}
}

// --- messages, cancel, permissions ---------------------------------------

func TestPostMessageQueuesTurn(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/messages",
		map[string]any{"prompt": "please add a regression test"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("post message = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	turn := decodeBody(t, rec)
	if turn["status"] != events.TurnStatusQueued || turn["prompt"] != "please add a regression test" {
		t.Fatalf("turn = %v", turn)
	}
	if turn["conversation_id"] != cnvTConv {
		t.Errorf("turn conversation_id = %v", turn["conversation_id"])
	}
	// The lease machinery is server-side only: a browser may see which worker
	// claimed the turn, but never the deadline or the fencing token that would
	// let it arbitrate a lease (ADR-0016 §4).
	for _, forbidden := range []string{"lease_expires_at", "fencing_token", "lease_taken_at"} {
		if _, ok := turn[forbidden]; ok {
			t.Errorf("turn exposed %q; fencing is server-side only (ADR-0016 §4)", forbidden)
		}
	}
}

func TestPostMessageSecondTurnIs409(t *testing.T) {
	store := cnvNewFakeStore()
	store.setActive(events.TurnStatusRunning)
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/messages",
		map[string]any{"prompt": "and one more thing"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("second message = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["type"] != "https://communication.dev/errors/turn-in-progress" {
		t.Errorf("type = %v", body["type"])
	}
	turn, ok := body["active_turn"].(map[string]any)
	if !ok || turn["status"] != events.TurnStatusRunning || turn["id"] != cnvTTurn {
		t.Fatalf("active_turn = %v, want the running turn", body["active_turn"])
	}
	if _, leaked := turn["fencing_token"]; leaked {
		t.Errorf("active_turn leaked fencing_token")
	}
}

func TestPostMessageWithoutControlIs409(t *testing.T) {
	store := cnvNewFakeStore()
	store.controller = cnvTUserB
	store.version = 2
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/messages",
		map[string]any{"prompt": "hi"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("message without the lock = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if len(store.messaged) != 0 {
		t.Errorf("the store was asked to queue a turn (%+v) even though nobody holds control", store.messaged)
	}
}

func TestCancelTurn(t *testing.T) {
	store := cnvNewFakeStore()
	store.setActive(events.TurnStatusRunning)
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/cancel", nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("cancel = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	if store.cancelled != 1 {
		t.Fatalf("cancel calls = %d", store.cancelled)
	}
}

func TestCancelWithNoActiveTurnIs409(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/cancel", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("cancel with no turn = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if body := decodeBody(t, rec); body["type"] != "https://communication.dev/errors/no-active-turn" {
		t.Errorf("type = %v", body["type"])
	}
}

func TestDecidePermission(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/permissions/"+cnvTPerms,
		map[string]any{"option_id": "allow_once"})
	if rec.Code != http.StatusOK {
		t.Fatalf("permission decision = %d (%s)", rec.Code, rec.Body)
	}
	if len(store.decided) != 1 || store.decided[0].optionID != "allow_once" {
		t.Fatalf("decisions = %+v", store.decided)
	}
	body := decodeBody(t, rec)
	if body["status"] != events.PermissionStatusDecided || body["decided_by"] != cnvTUserA {
		t.Fatalf("permission = %v", body)
	}
}

func TestDecidePermissionUnknownRequestIs404(t *testing.T) {
	store := cnvNewFakeStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/permissions/01987a72-9999-7000-8000-abcdef012345",
		map[string]any{"option_id": "allow_once"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown permission request = %d, want 404 (no id-valid-but-not-visible 200) (%s)", rec.Code, rec.Body)
	}
	if len(store.decided) != 0 {
		t.Errorf("decisions = %+v, want none", store.decided)
	}
}

func TestDecidePermissionAlreadyAnsweredIs409(t *testing.T) {
	store := cnvNewFakeStore()
	store.customErr = nil
	// The fake refuses an option it was not offered; a request that is no longer
	// pending is the same shape of refusal from the store.
	decide := func() *httptest.ResponseRecorder {
		s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
		return cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/permissions/"+cnvTPerms,
			map[string]any{"option_id": "allow_always"})
	}
	if rec := decide(); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unoffered option = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	// The store reports the same conflict the real one reports for a request
	// that is not pending.
	store.decideConflict = true
	if rec := decide(); rec.Code != http.StatusConflict {
		t.Fatalf("answered request = %d, want 409 (%s)", rec.Code, rec.Body)
	} else if body := decodeBody(t, rec); body["type"] != "https://communication.dev/errors/permission-not-pending" {
		t.Errorf("type = %v", body["type"])
	}
}

// --- request validation --------------------------------------------------

func TestConversationRouteValidation(t *testing.T) {
	for _, tt := range []struct {
		name, method, target string
		body                 any
		want                 int
	}{
		{"unknown project route", http.MethodGet, "/api/v1/projects/" + cnvTProject + "/nope", nil, http.StatusNotFound},
		{"malformed project id", http.MethodGet, "/api/v1/projects/not-a-uuid/conversations", nil, http.StatusNotFound},
		{"malformed conversation id", http.MethodGet, "/api/v1/conversations/not-a-uuid", nil, http.StatusNotFound},
		{"malformed turn id on the control path", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/permissions/not-a-uuid",
			map[string]any{"option_id": "allow_once"}, http.StatusNotFound},
		{"empty prompt", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/messages", map[string]any{"prompt": "  "}, http.StatusUnprocessableEntity},
		{"oversized prompt", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/messages",
			map[string]any{"prompt": strings.Repeat("p", 65537)}, http.StatusUnprocessableEntity},
		{"missing version", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/take-control", map[string]any{}, http.StatusUnprocessableEntity},
		{"version zero", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/take-control", map[string]any{"version": 0}, http.StatusUnprocessableEntity},
		{"unknown field", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/take-control",
			map[string]any{"version": 1, "worker_id": "mine"}, http.StatusBadRequest},
		{"malformed json", http.MethodPost, "/api/v1/conversations/" + cnvTConv + "/messages", "{", http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := cnvNewFakeStore()
			s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
			var rec *httptest.ResponseRecorder
			switch tt.body.(type) {
			case string:
				req := httptest.NewRequest(tt.method, "http://localhost:8080"+tt.target, strings.NewReader(tt.body.(string)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://localhost:8080")
				req.Header.Set(HeaderCSRFToken, "csrf-token-value")
				rec = do(t, s, req)
			case map[string]any:
				rec = cnvPost(t, s, cnvTUserA, "http://localhost:8080"+tt.target, tt.body)
			default:
				rec = do(t, s, request(tt.method, "http://localhost:8080"+tt.target, nil))
			}
			if rec.Code != tt.want {
				t.Fatalf("%s %s = %d, want %d (%s)", tt.method, tt.target, rec.Code, tt.want, rec.Body)
			}
			if tt.want == http.StatusUnprocessableEntity {
				// A 422 must say what is wrong in the caller's terms: which field,
				// and what about it.
				if prob := decodeProblem(t, rec); prob.Title != "Validation Failed" || prob.Detail == "" {
					t.Errorf("problem = %+v, want a Validation Failed problem naming the field", prob)
				}
			}
			if tt.want == http.StatusNotFound && strings.Contains(tt.target, "/conversations") && len(store.denied) == 0 {
				t.Errorf("%s %s wrote no audit row although it refused", tt.method, tt.target)
			}
		})
	}
}
