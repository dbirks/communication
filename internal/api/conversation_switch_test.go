package api

// Contract tests for the ADR-0068 switch-agent route and the per-turn agent
// profile fields on the conversation surface: which status which caller gets
// (403 identity, 409 timing, 400 body), what the 409 body must carry, and
// that the detail read exposes the derived agents list, the next-turn model
// and the turn rows' profile/name/model triple. The database semantics behind
// them are proven against a real PostgreSQL in
// internal/store/postgres/conversations_switch_test.go.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const cnvTProfile2 = "01987a71-6666-7000-8000-abcdef012345"

func cnvSwitchStore() *cnvFakeStore {
	f := cnvNewFakeStore()
	model := "gpt-5"
	f.profiles = append(f.profiles, AgentProfileView{
		ID: cnvTProfile2, Name: "Codex", LauncherID: "codex", PermissionMode: "ask",
		Version: 3, Model: &model,
	})
	return f
}

func TestConversationSwitchAgentByController(t *testing.T) {
	store := cnvSwitchStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))

	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		map[string]string{"agent_profile_id": cnvTProfile2})
	if rec.Code != http.StatusOK {
		t.Fatalf("switch by the controller = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var view ConversationView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode conversation: %v", err)
	}
	if view.AgentProfileID != cnvTProfile2 || view.AgentProfileName != "Codex" {
		t.Errorf("view profile = %s/%s, want the codex profile", view.AgentProfileID, view.AgentProfileName)
	}
	if view.AgentProfileModel == nil || *view.AgentProfileModel != "gpt-5" {
		t.Errorf("view agent_profile_model = %v, want gpt-5", view.AgentProfileModel)
	}
	if len(store.switched) != 1 || store.switched[0].conversationID != cnvTConv || store.switched[0].agentProfileID != cnvTProfile2 {
		t.Errorf("store saw %+v, want one switch of %s to %s", store.switched, cnvTConv, cnvTProfile2)
	}
}

func TestConversationSwitchAgentMalformedBody(t *testing.T) {
	for _, body := range []any{
		map[string]string{"agent_profile_id": "not-a-uuid"},
		map[string]string{"agent_profile_id": ""},
		map[string]string{},
	} {
		store := cnvSwitchStore()
		s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
		rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %v = %d, want 400 (%s)", body, rec.Code, rec.Body)
		}
		if !strings.Contains(rec.Body.String(), "invalid_agent_profile") {
			t.Errorf("body %v: %s, want the invalid_agent_profile code", body, rec.Body)
		}
		if len(store.switched) != 0 {
			t.Errorf("a malformed body reached the store: %+v", store.switched)
		}
	}
}

// A well-formed uuid of a profile the project's organization does not have is
// the store's 400 (ADR-0068): named, not a 422 — the route documents 400.
func TestConversationSwitchAgentUnknownProfile400(t *testing.T) {
	store := cnvSwitchStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		map[string]string{"agent_profile_id": "01987a71-9999-7000-8000-abcdef012345"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown profile = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "invalid_agent_profile") ||
		!strings.Contains(rec.Body.String(), "agent profiles") {
		t.Errorf("body = %s, want invalid_agent_profile naming the project's profiles", rec.Body)
	}
}

func TestConversationSwitchAgentNonController403(t *testing.T) {
	store := cnvSwitchStore()
	store.controller = cnvTUserA // the caller below is UserB; Alice holds the wheel
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserB))
	rec := cnvPost(t, s, cnvTUserB, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		map[string]string{"agent_profile_id": cnvTProfile2})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-controller switch = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "Alice holds the controller lock") {
		t.Errorf("403 body = %s, want it to name the controller", rec.Body)
	}
	if len(store.switched) != 0 {
		t.Errorf("a non-controller reached the store switch: %+v", store.switched)
	}
}

func TestConversationSwitchAgentViewerRole403(t *testing.T) {
	store := cnvSwitchStore()
	store.myRole = "viewer"
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		map[string]string{"agent_profile_id": cnvTProfile2})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer switch = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

func TestConversationSwitchAgentMidTurn409(t *testing.T) {
	store := cnvSwitchStore()
	store.cnvActiveTurn("running")
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		map[string]string{"agent_profile_id": cnvTProfile2})
	if rec.Code != http.StatusConflict {
		t.Fatalf("mid-turn switch = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "turn-in-progress") {
		t.Errorf("409 body = %s, want the turn-in-progress problem type", rec.Body)
	}
	// The 409 carries the state to adopt: control AND the turn in the way.
	var problem struct {
		Control    *ConversationControlView `json:"control"`
		ActiveTurn *ConversationTurnView    `json:"active_turn"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatalf("decode 409: %v", err)
	}
	if problem.Control == nil || problem.Control.Version != store.version {
		t.Errorf("409 control = %+v, want the live control row", problem.Control)
	}
	if problem.ActiveTurn == nil || problem.ActiveTurn.ID != cnvTTurn {
		t.Errorf("409 active_turn = %+v, want the running turn", problem.ActiveTurn)
	}
}

func TestConversationSwitchAgentInvisibleConversation404(t *testing.T) {
	store := cnvSwitchStore()
	store.authFails = true
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := cnvPost(t, s, cnvTUserA, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		map[string]string{"agent_profile_id": cnvTProfile2})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("invisible conversation = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if len(store.denied) == 0 {
		t.Errorf("an invisible-conversation switch wrote no audit row")
	}
}

func TestConversationSwitchAgentRequiresCSRF(t *testing.T) {
	store := cnvSwitchStore()
	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	req := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/v1/conversations/"+cnvTConv+"/switch-agent",
		strings.NewReader(`{"agent_profile_id":"`+cnvTProfile2+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := do(t, s, req)
	if rec.Code == http.StatusOK || rec.Code == http.StatusNoContent {
		t.Fatalf("a POST with no CSRF token succeeded (%d) — mutations must require it", rec.Code)
	}
}

// TestConversationDetailCarriesTurnProfileAndAgents pins the read side: the
// detail response exposes agent_profile_model, the derived agents list with
// turn ranges, and the active turn's agent_profile_id / name / model.
func TestConversationDetailCarriesTurnProfileAndAgents(t *testing.T) {
	store := cnvSwitchStore()
	model := "gpt-5"
	store.chat.Agents = []ConversationChatAgentView{
		{AgentProfileID: cnvTProfile, AgentProfileName: "Claude Code", FirstTurn: 1, LastTurn: 3, TurnCount: 3},
		{AgentProfileID: cnvTProfile2, AgentProfileName: "Codex", Model: &model, FirstTurn: 4, LastTurn: 4, TurnCount: 1},
	}
	store.chat.AgentProfileModel = &model
	store.cnvActiveTurn("running")
	store.chat.ActiveTurn.AgentProfileID = cnvTProfile2
	store.chat.ActiveTurn.AgentProfileName = "Codex"
	store.chat.ActiveTurn.Model = &model

	s := cnvMount(t, store, nil, cnvCaller(cnvTUserA))
	rec := do(t, s, request(http.MethodGet, "http://localhost:8080/api/v1/conversations/"+cnvTConv, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("getConversation = %d (%s)", rec.Code, rec.Body)
	}
	var view ConversationView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(view.Agents) != 2 || view.Agents[0].FirstTurn != 1 || view.Agents[0].LastTurn != 3 ||
		view.Agents[1].AgentProfileID != cnvTProfile2 || view.Agents[1].FirstTurn != 4 {
		t.Errorf("agents = %+v, want the two segments with turn ranges", view.Agents)
	}
	if view.AgentProfileModel == nil || *view.AgentProfileModel != "gpt-5" {
		t.Errorf("agent_profile_model = %v, want gpt-5", view.AgentProfileModel)
	}
	if view.ActiveTurn == nil || view.ActiveTurn.AgentProfileID != cnvTProfile2 ||
		view.ActiveTurn.AgentProfileName != "Codex" || view.ActiveTurn.Model == nil {
		t.Errorf("active_turn profile fields = %+v, want the codex triple", view.ActiveTurn)
	}
	// The agents list and the model are on the WIRE, not just the Go view.
	for _, want := range []string{`"agents"`, `"first_turn"`, `"last_turn"`, `"agent_profile_model"`, `"agent_profile_id"`} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("response body lacks %s", want)
		}
	}
}
