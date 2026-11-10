package assistant

// ADR-0079 (CONTRACT §3): the decision model behind "Ask when it looks
// risky". The provisional OpenAI-compatible adapter's wire behaviour, the
// gate table for every trust level × tool class × the always-ask floor × a
// down judge, and the runner's use of it (a judged ask on a risky call cards
// with the judge's reason; no_ask never spends a judge call; the args that
// leave the host are bounded and carry no keying material).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- the HTTP adapter ---------------------------------------------------

// judgeServer is a fake OpenAI-compatible endpoint: it answers the judge's
// POST with whatever the test wants to observe.
type judgeServer struct {
	*httptest.Server
	mu     sync.Mutex
	bodies []chatRequest
	auths  []string
	paths  []string
}

func newJudgeServer(t *testing.T, reply func(w http.ResponseWriter, r *http.Request)) *judgeServer {
	t.Helper()
	js := &judgeServer{}
	js.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("judge server: request body is not a chat request: %v", err)
		}
		js.mu.Lock()
		js.bodies = append(js.bodies, req)
		js.auths = append(js.auths, r.Header.Get("Authorization"))
		js.paths = append(js.paths, r.URL.Path)
		js.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		reply(w, r)
	}))
	t.Cleanup(js.Close)
	return js
}

// completionBody is one chat-completions answer whose message content is the
// judge's text.
func completionBody(content string) string {
	body, _ := json.Marshal(map[string]any{"choices": []map[string]any{{
		"message":       map[string]any{"content": content, "tool_calls": nil},
		"finish_reason": "stop",
	}}})
	return string(body)
}

func TestChatJudgeAllowAndAsk(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content string
		want    JudgeVerdict
	}{
		{"allow", `{"decision":"allow","reason":"Starting this run is routine for an owner."}`,
			JudgeVerdict{Allow: true, Reason: "Starting this run is routine for an owner."}},
		{"ask", `{"decision":"ask","reason":"This cancels a run someone else started."}`,
			JudgeVerdict{Allow: false, Reason: "This cancels a run someone else started."}},
		// The first JSON object is the answer; a model that wraps it in prose
		// or fences it is still readable, and so is one that adds a second
		// object (which is not part of the answer).
		{"fenced", "Sure!\n```json\n{\"decision\":\"allow\",\"reason\":\"A plain look-up.\"}\n```\n",
			JudgeVerdict{Allow: true, Reason: "A plain look-up."}},
		{"trailing object", `{"decision":"ask","reason":"Broad scope."} {"decision":"allow","reason":"noise"}`,
			JudgeVerdict{Allow: false, Reason: "Broad scope."}},
		{"empty reason", `{"decision":"ask"}`, JudgeVerdict{Allow: false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newJudgeServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(completionBody(tc.content)))
			})
			j := NewChatJudge(srv.URL+"/v1", "judge-key-not-a-secret", "small-judge", 0, nil)
			if j == nil {
				t.Fatal("NewChatJudge returned no judge for a complete config")
			}
			got, err := j.Decide(context.Background(), JudgeInput{
				Tool: "run.start", Class: "risky", Args: map[string]string{"project_id": "p-1"},
				Role: "owner", Page: "page: Runs",
			})
			if err != nil {
				t.Fatalf("Decide: %v", err)
			}
			if got != tc.want {
				t.Fatalf("verdict = %+v, want %+v", got, tc.want)
			}
			srv.mu.Lock()
			defer srv.mu.Unlock()
			if len(srv.paths) != 1 || srv.paths[0] != "/v1/chat/completions" {
				t.Fatalf("path = %v, want exactly /v1/chat/completions", srv.paths)
			}
			if len(srv.auths) != 1 || srv.auths[0] != "Bearer judge-key-not-a-secret" {
				t.Fatalf("authorization = %v, want the bearer key", srv.auths)
			}
			req := srv.bodies[0]
			if req.Model != "small-judge" {
				t.Fatalf("model = %q, want small-judge", req.Model)
			}
			if req.Temperature == nil || *req.Temperature != 0 {
				t.Fatalf("temperature = %v, want an explicit 0", req.Temperature)
			}
			if len(req.Messages) != 2 || req.Messages[0].Role != "system" || req.Messages[1].Role != "user" {
				t.Fatalf("messages = %+v, want the fixed system prompt then one user turn", req.Messages)
			}
			if req.Messages[0].Content == nil || *req.Messages[0].Content != judgeSystemPrompt {
				t.Fatal("the system half is not the fixed prompt")
			}
			if len(req.Tools) != 0 {
				t.Fatalf("the judge was offered %d tools; it must have none", len(req.Tools))
			}
		})
	}
}

func TestChatJudgeUserMessageIsTheBoundedInput(t *testing.T) {
	srv := newJudgeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(completionBody(`{"decision":"allow","reason":"fine"}`)))
	})
	j := NewChatJudge(srv.URL+"/v1", "", "small-judge", time.Second, nil)
	long := strings.Repeat("x", 400)
	if _, err := j.Decide(context.Background(), JudgeInput{
		Tool:  "run.list",
		Class: "read",
		Args:  map[string]string{"project_id": "p-1", "note": long},
		Role:  "member",
		Page:  "page: Run 9c1e · status waiting",
	}); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	var in map[string]any
	if err := json.Unmarshal([]byte(*srv.bodies[0].Messages[1].Content), &in); err != nil {
		t.Fatalf("user message is not json: %v", err)
	}
	if in["tool"] != "run.list" || in["class"] != "read" || in["role"] != "member" ||
		in["page"] != "page: Run 9c1e · status waiting" {
		t.Fatalf("input = %v, want the tool, class, role and page line", in)
	}
	args, _ := in["args"].(map[string]any)
	if args["project_id"] != "p-1" {
		t.Fatalf("args = %v, want the plain args too", args)
	}
	if v, _ := args["note"].(string); len(v) > judgeArgValueMaxChars {
		t.Fatalf("arg \"note\" reached the wire at %d chars, want ≤%d", len(v), judgeArgValueMaxChars)
	}
}

func TestChatJudgeRefusesNonVerdicts(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content string
	}{
		{"prose only", "I think you should ask the user."},
		{"unknown decision", `{"decision":"maybe","reason":"unclear"}`},
		{"missing decision", `{"reason":"no decision here"}`},
		{"array", `[{"decision":"allow"}]`},
		{"empty", ""},
		{"non-string reason", `{"decision":"allow","reason":{"text":"no"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newJudgeServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(completionBody(tc.content)))
			})
			j := NewChatJudge(srv.URL+"/v1", "", "small-judge", time.Second, nil)
			if _, err := j.Decide(context.Background(), JudgeInput{Tool: "run.start", Class: "risky"}); err == nil {
				t.Fatalf("Decide(%q) returned no error; the gate must read this as down", tc.content)
			}
		})
	}
}

func TestChatJudgeTimeoutAndUpstreamFailure(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		srv := newJudgeServer(t, func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done() // never answers inside the judge's deadline
		})
		j := NewChatJudge(srv.URL+"/v1", "", "small-judge", 80*time.Millisecond, nil)
		start := time.Now()
		if _, err := j.Decide(context.Background(), JudgeInput{Tool: "run.start", Class: "risky"}); err == nil {
			t.Fatal("a judge that never answered returned a verdict")
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("the slow judge took %s; the per-decision deadline must cap it", d)
		}
	})
	for _, tc := range []struct {
		name string
		sv   int
		body string
	}{
		{"http 500", http.StatusInternalServerError, "<html>gateway blew up</html>"},
		{"http 429", http.StatusTooManyRequests, `{"error":{"message":"slow down"}}`},
		{"error envelope on 200", http.StatusOK, `{"error":{"type":"model_loading","message":"reloading"}}`},
		{"not an envelope", http.StatusOK, `not json at all`},
		{"no choices", http.StatusOK, `{"choices":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newJudgeServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.sv)
				_, _ = w.Write([]byte(tc.body))
			})
			j := NewChatJudge(srv.URL+"/v1", "", "small-judge", time.Second, nil)
			if _, err := j.Decide(context.Background(), JudgeInput{Tool: "run.start", Class: "risky"}); err == nil {
				t.Fatal("an outage returned a verdict")
			}
		})
	}
}

func TestChatJudgeNeverLeaksTheKey(t *testing.T) {
	const key = "sk-judge-material-should-never-echo"
	srv := newJudgeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		// A hostile endpoint echoing its own Authorization header into the
		// error text must not put the key in a returned error.
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
	})
	j := NewChatJudge(srv.URL+"/v1", key, "small-judge", time.Second, nil)
	_, err := j.Decide(context.Background(), JudgeInput{Tool: "run.start", Class: "risky"})
	if err == nil {
		t.Fatal("a 500 returned a verdict")
	}
	if strings.Contains(err.Error(), key) {
		t.Fatalf("error text leaked the key: %v", err)
	}
}

func TestNewChatJudgeHonestAbsence(t *testing.T) {
	for _, tc := range []struct {
		name, baseURL, model string
	}{
		{"no base url", "", "small-judge"},
		{"no model", "http://127.0.0.1:1/v1", "  "},
		{"not a url", "not a url", "small-judge"},
		{"no host", "http:///v1", "small-judge"},
		{"credentials in the url", "http://user:pw@host.example/v1", "small-judge"},
		{"query", "http://host.example/v1?key=abc", "small-judge"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if j := NewChatJudge(tc.baseURL, "k", tc.model, 0, nil); j != nil {
				t.Fatalf("NewChatJudge(%q,%q) returned a judge; nil (no judge) is the honest answer", tc.baseURL, tc.model)
			}
		})
	}
}

func TestJudgeEgressRefusesSecretMaterial(t *testing.T) {
	srv := newJudgeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(completionBody(`{"decision":"allow","reason":"ok"}`)))
	})
	j := NewChatJudge(srv.URL+"/v1", "", "small-judge", time.Second, nil)
	if _, err := j.Decide(context.Background(), JudgeInput{
		Tool:  "repo.add",
		Class: "risky",
		Args:  map[string]string{"repo_url": "https://example.test/a", "token": "ghp_abcdefghijklmnopqrst"},
	}); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	body := *srv.bodies[0].Messages[1].Content
	if strings.Contains(body, "ghp_abcdefghijklmnopqrst") {
		t.Fatalf("the judge egress carried keying material: %s", body)
	}
	if !strings.Contains(body, judgeSecretMarker) {
		t.Fatalf("the judged args lost the argument entirely; want it marked %q: %s", judgeSecretMarker, body)
	}
	var in map[string]any
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("user message is not json: %v", err)
	}
	args, _ := in["args"].(map[string]any)
	if args["repo_url"] != "https://example.test/a" {
		t.Fatalf("args = %v, want the non-secret arg intact", args)
	}
}

func TestCleanJudgeReasonBoundsAndStrips(t *testing.T) {
	got := cleanJudgeReason("  it   deletes\r\nthe whole \x00project\x07 <everything>  ")
	if strings.ContainsAny(got, "\r\n\x00\x07<>") {
		t.Fatalf("reason kept control or angle characters: %q", got)
	}
	if got != "it deletes the whole project everything" {
		t.Fatalf("reason = %q", got)
	}
	long := cleanJudgeReason(strings.Repeat("y", 500))
	if len([]rune(long)) != judgeReasonMaxChars {
		t.Fatalf("reason length = %d, want the %d-character bound", len([]rune(long)), judgeReasonMaxChars)
	}
}

func TestParseJudgeReplyTakesTheFirstObject(t *testing.T) {
	if _, err := parseJudgeReply(`{"decision":"allow"`); err == nil {
		t.Fatal("a truncated object returned a verdict")
	}
	v, err := parseJudgeReply("noise {\"decision\":\"ASK\",\"reason\":\"  spaced  \"} more")
	if err != nil {
		t.Fatalf("parseJudgeReply: %v", err)
	}
	if v.Allow || v.Reason != "spaced" {
		t.Fatalf("verdict = %+v, want ask with the trimmed reason", v)
	}
}

// --- the gate table (CONTRACT §3) ---------------------------------------

// fakeJudge is a counting decision model: the runner tests use it to prove
// which levels consult it, what they hand it, and what each verdict does.
type fakeJudge struct {
	mu      sync.Mutex
	calls   int
	inputs  []JudgeInput
	verdict JudgeVerdict
	err     error
}

func (f *fakeJudge) Decide(_ context.Context, in JudgeInput) (JudgeVerdict, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.inputs = append(f.inputs, in)
	return f.verdict, f.err
}

func (f *fakeJudge) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func newJudgeRunner(t *testing.T, j Judge) *ConversationRunner {
	t.Helper()
	b := newTestBroker(t, newFakeModel(t), newFakeStore())
	return NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: newFakeDraftService(), Judge: j})
}

func TestDecideGateTable(t *testing.T) {
	down := &fakeJudge{err: errors.New("the judge is down")}
	allowAll := &fakeJudge{verdict: JudgeVerdict{Allow: true, Reason: "routine"}}
	askAll := &fakeJudge{verdict: JudgeVerdict{Allow: false, Reason: "looks odd"}}
	ctx := context.Background()
	req := TurnRequest{Caller: testCaller}
	cases := []struct {
		name      string
		judge     Judge
		trust     TrustLevel
		class     ToolClass
		tool      string
		wantGate  bool
		wantWhy   string
		wantJudge string
		wantCalls int
	}{
		// ask_all: ADR-0050 unchanged, the judge never consulted.
		{"ask_all/risky", allowAll, TrustAskAll, ClassRisky, "run.start", true, GateReasonAskAll, "", 0},
		{"ask_all/draft_edit", allowAll, TrustAskAll, ClassDraftEdit, "draft.apply", true, GateReasonAskAll, "", 0},
		{"ask_all/read", allowAll, TrustAskAll, ClassRead, "run.list", false, "", "", 0},
		{"ask_all/navigate", allowAll, TrustAskAll, ClassNavigate, "ui.navigate", false, "", "", 0},
		// no_ask: everything runs, the judge never consulted.
		{"no_ask/risky", askAll, TrustNoAsk, ClassRisky, "run.start", false, "", "", 0},
		{"no_ask/read", askAll, TrustNoAsk, ClassRead, "run.list", false, "", "", 0},
		// ask_risky with no judge: the fixed table.
		{"no judge/risky", nil, TrustAskRisky, ClassRisky, "run.start", true, GateReasonFixedTable, "", 0},
		{"no judge/draft_edit", nil, TrustAskRisky, ClassDraftEdit, "draft.apply", false, "", "", 0},
		{"no judge/read", nil, TrustAskRisky, ClassRead, "run.list", false, "", "", 0},
		// ask_risky with a judge: the verdict decides …
		{"judge allow/risky", allowAll, TrustAskRisky, ClassRisky, "run.start", false, "", JudgeAllowed, 1},
		{"judge allow/read", allowAll, TrustAskRisky, ClassRead, "run.list", false, "", JudgeAllowed, 1},
		{"judge ask/read", askAll, TrustAskRisky, ClassRead, "run.list", true, "looks odd", JudgeAsked, 1},
		{"judge ask/navigate", askAll, TrustAskRisky, ClassNavigate, "ui.navigate", true, "looks odd", JudgeAsked, 1},
		{"judge ask/draft_edit", askAll, TrustAskRisky, ClassDraftEdit, "draft.apply", true, "looks odd", JudgeAsked, 1},
		// … and the floor: the always-ask set asks whatever the judge says,
		// without spending a call on it.
		{"floor/approval.decide", allowAll, TrustAskRisky, ClassRisky, "approval.decide", true, GateReasonAlwaysAskApproval, "", 0},
		{"floor/permission.allow", allowAll, TrustAskRisky, ClassRisky, "permission.allow", true, GateReasonAlwaysAskPermanent, "", 0},
		// A down judge fails closed for changes and open for look-ups.
		{"down/risky", down, TrustAskRisky, ClassRisky, "run.start", true, GateReasonJudgeDown, JudgeUnavailable, 1},
		{"down/draft_edit", down, TrustAskRisky, ClassDraftEdit, "draft.apply", true, GateReasonJudgeDown, JudgeUnavailable, 1},
		{"down/read", down, TrustAskRisky, ClassRead, "run.list", false, "", JudgeUnavailable, 1},
		{"down/navigate", down, TrustAskRisky, ClassNavigate, "ui.navigate", false, "", JudgeUnavailable, 1},
		// An empty stored level is the default posture, never no_ask.
		{"empty level/risky", allowAll, TrustLevel(""), ClassRisky, "run.start", false, "", JudgeAllowed, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newJudgeRunner(t, tc.judge)
			before := 0
			if f, ok := tc.judge.(*fakeJudge); ok {
				before = f.count()
			}
			gate, why, tag := r.decideGate(ctx, tc.trust, tc.class, tc.tool, map[string]string{}, req)
			if gate != tc.wantGate || why != tc.wantWhy || tag != tc.wantJudge {
				t.Fatalf("decideGate = (%v,%q,%q), want (%v,%q,%q)", gate, why, tag, tc.wantGate, tc.wantWhy, tc.wantJudge)
			}
			if f, ok := tc.judge.(*fakeJudge); ok && f.count()-before != tc.wantCalls {
				t.Fatalf("judge calls = %d, want %d", f.count()-before, tc.wantCalls)
			}
		})
	}
}

func TestDecideGateHandsTheJudgeTheWholeCall(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: true}}
	r := newJudgeRunner(t, j)
	_, _, _ = r.decideGate(context.Background(), TrustAskRisky, ClassRisky, "run.start",
		map[string]string{"project_id": "p-1"}, TurnRequest{
			Caller:  Caller{UserID: "u", OrganizationID: "o", IsOrgAdmin: true},
			Context: TurnContext{Route: "/projects/p-1/runs", Page: &TurnContextPage{Label: "Runs", Status: "waiting", Project: "feature-delivery"}},
		})
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.inputs) != 1 {
		t.Fatalf("judge inputs = %d, want 1", len(j.inputs))
	}
	in := j.inputs[0]
	if in.Tool != "run.start" || in.Class != "risky" || in.Args["project_id"] != "p-1" || in.Role != "owner" {
		t.Fatalf("judge input = %+v", in)
	}
	for _, want := range []string{"page: Runs", "status: waiting", "project: feature-delivery", "route: /projects/p-1/runs"} {
		if !strings.Contains(in.Page, want) {
			t.Fatalf("page line %q lacks %q", in.Page, want)
		}
	}
}

// --- the runner with a judge --------------------------------------------

func TestRunnerJudgedAskOnRiskyCardsWithTheJudgeReason(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: false, Reason: "This starts a run on a project you only view."}}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("run.start", map[string]any{"project_id": "p-1", "pipeline_id": "pl-1"})}},
		step{text: "waiting"},
	)
	b := newTestBroker(t, model, newFakeStore())
	execCalls := 0
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: b, Draft: newFakeDraftService(), Judge: j,
		Actions: map[string]ActionExecutor{
			"run.start": func(context.Context, Caller, string, map[string]string) (string, *ChangeRecord, error) {
				execCalls++
				return "Started", nil, nil
			},
		},
	})
	res := runOne(t, r, TrustAskRisky)
	if res.Approval == nil || res.Approval.Tool != "run.start" {
		t.Fatalf("approval = %+v, want the run.start card", res.Approval)
	}
	if res.Approval.Reason != "This starts a run on a project you only view." {
		t.Fatalf("card reason = %q, want the judge's line", res.Approval.Reason)
	}
	if execCalls != 0 {
		t.Fatalf("a judged-ask action executed %d times", execCalls)
	}
	if len(res.Answer.ToolCalls) != 1 || res.Answer.ToolCalls[0].Judge != "asked" {
		t.Fatalf("tool_calls = %+v, want the asked verdict recorded", res.Answer.ToolCalls)
	}
	if j.count() != 1 {
		t.Fatalf("judge calls = %d, want 1", j.count())
	}
}

func TestRunnerJudgedAllowRunsTheRiskyCallWithoutACard(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: true, Reason: "routine for an owner"}}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("run.start", map[string]any{"project_id": "p-1", "pipeline_id": "pl-1"})}},
		step{text: "The run is on its way."},
	)
	b := newTestBroker(t, model, newFakeStore())
	execCalls := 0
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: b, Draft: newFakeDraftService(), Judge: j,
		Actions: map[string]ActionExecutor{
			"run.start": func(context.Context, Caller, string, map[string]string) (string, *ChangeRecord, error) {
				execCalls++
				return "Started run r-1", &ChangeRecord{Kind: "run_start", TargetRef: "run:r-1", Summary: "Started run r-1"}, nil
			},
		},
	})
	res := runOne(t, r, TrustAskRisky)
	if res.Approval != nil {
		t.Fatalf("a judged-allow call was carded: %+v", res.Approval)
	}
	if execCalls != 1 {
		t.Fatalf("the allowed action ran %d times, want 1", execCalls)
	}
	if len(res.Answer.ToolCalls) != 1 || res.Answer.ToolCalls[0].Judge != "allowed" {
		t.Fatalf("tool_calls = %+v, want the allowed verdict", res.Answer.ToolCalls)
	}
}

func TestRunnerJudgeDownStillLetsReadsRun(t *testing.T) {
	j := &fakeJudge{err: errors.New("the decision model is down")}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("project.list", map[string]any{})}},
		step{text: "Two projects."},
	)
	store := newFakeStore()
	b := newTestBroker(t, model, store)
	r := NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: newFakeDraftService(), Judge: j})
	res := runOne(t, r, TrustAskRisky)
	if res.Approval != nil {
		t.Fatalf("a dead judge blocked a read: %+v", res.Approval)
	}
	if len(res.Answer.ToolCalls) != 1 || !res.Answer.ToolCalls[0].OK {
		t.Fatalf("tool_calls = %+v, want the read to have run", res.Answer.ToolCalls)
	}
	if res.Answer.ToolCalls[0].Judge != "unavailable" {
		t.Fatalf("judge tag = %q, want unavailable", res.Answer.ToolCalls[0].Judge)
	}
}

func TestRunnerJudgedAskOnAReadConfirmsIntoTheRead(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: false, Reason: "This read reaches past the page you are on."}}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("project.list", map[string]any{})}},
		step{text: "waiting"},
	)
	store := newFakeStore()
	store.projects = json.RawMessage(`[{"id":"p-1","slug":"feature","name":"Feature"}]`)
	b := newTestBroker(t, model, store)
	r := NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: newFakeDraftService(), Judge: j})
	res := runOne(t, r, TrustAskRisky)
	if res.Approval == nil || res.Approval.Tool != "project.list" {
		t.Fatalf("approval = %+v, want the gated read", res.Approval)
	}
	if res.Approval.Reason != "This read reaches past the page you are on." {
		t.Fatalf("card reason = %q", res.Approval.Reason)
	}
	if !strings.Contains(res.Approval.Summary, "Look up project.list") {
		t.Fatalf("card summary = %q, want a look-up line, not a change line", res.Approval.Summary)
	}
	if !strings.Contains(res.Approval.Risk, "nothing in the app changes") {
		t.Fatalf("risk line for a gated read = %q, want the honest no-change line", res.Approval.Risk)
	}
	// The confirm runs the read the caller was asked about, as the caller.
	ack, change, err := r.ExecuteAction(context.Background(), testCaller, "project.list", res.Approval.Args)
	if err != nil {
		t.Fatalf("ExecuteAction(confirmed read): %v", err)
	}
	if change != nil {
		t.Fatalf("a confirmed read logged a change row %+v; a look-up changes nothing", change)
	}
	if !strings.Contains(ack, "Listed 1 project") {
		t.Fatalf("ack = %q, want the read's own summary", ack)
	}
}

func TestRunnerNoAskNeverConsultsTheJudge(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: false, Reason: "would have asked"}}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{
			toolCall("run.start", map[string]any{"project_id": "p-1", "pipeline_id": "pl-1"}),
			toolCall("project.list", map[string]any{}),
		}},
		step{text: "Done."},
	)
	b := newTestBroker(t, model, newFakeStore())
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: b, Draft: newFakeDraftService(), Judge: j,
		Actions: map[string]ActionExecutor{
			"run.start": func(context.Context, Caller, string, map[string]string) (string, *ChangeRecord, error) {
				return "Started run r-1", &ChangeRecord{Kind: "run_start", TargetRef: "run:r-1", Summary: "Started run r-1"}, nil
			},
		},
	})
	res := runOne(t, r, TrustNoAsk)
	if j.count() != 0 {
		t.Fatalf("no_ask consulted the judge %d times, want 0", j.count())
	}
	if res.Approval != nil {
		t.Fatalf("no_ask gated a call: %+v", res.Approval)
	}
	for _, c := range res.Answer.ToolCalls {
		if c.Judge != "" {
			t.Fatalf("tool_calls %s recorded judge %q at no_ask, want absent", c.Name, c.Judge)
		}
	}
}

func TestRunnerAskAllNeverConsultsTheJudgeAndSaysWhy(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: true, Reason: "would have allowed"}}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("run.start", map[string]any{"project_id": "p-1", "pipeline_id": "pl-1"})}},
		step{text: "waiting"},
	)
	b := newTestBroker(t, model, newFakeStore())
	r := NewConversationRunner(ConversationRunnerDeps{
		Broker: b, Draft: newFakeDraftService(), Judge: j,
		Actions: map[string]ActionExecutor{
			"run.start": func(context.Context, Caller, string, map[string]string) (string, *ChangeRecord, error) {
				t.Fatal("ask_all executed a gated action")
				return "", nil, nil
			},
		},
	})
	res := runOne(t, r, TrustAskAll)
	if j.count() != 0 {
		t.Fatalf("ask_all consulted the judge %d times, want 0", j.count())
	}
	if res.Approval == nil || res.Approval.Reason != GateReasonAskAll {
		t.Fatalf("approval = %+v, want the ask_all reason", res.Approval)
	}
}

// The args the judge sees are the transcript's bounded view, never the raw
// call: a huge draft document is summarized by size, a secret-shaped value is
// marked, and a key-named argument never travels.
func TestRunnerJudgedArgsAreBoundedAndCarryNoKeys(t *testing.T) {
	j := &fakeJudge{verdict: JudgeVerdict{Allow: true}}
	model := newFakeModel(t,
		step{toolCalls: []toolCallRequest{toolCall("workflow.create_draft", map[string]any{
			"slug": "nightly", "display_name": "Nightly",
			"document": strings.Repeat("a", 6000),
		})}},
		step{text: "Saved."},
	)
	b := newTestBroker(t, model, newFakeStore())
	r := NewConversationRunner(ConversationRunnerDeps{Broker: b, Draft: newFakeDraftService(), Judge: j,
		Library: &fakeLibrary{}})
	runOne(t, r, TrustAskRisky)
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.inputs) == 0 {
		t.Fatal("the drafting tool was never judged")
	}
	var total int
	for _, in := range j.inputs {
		for k, v := range in.Args {
			total += len(v)
			if len(v) > judgeArgValueMaxChars {
				t.Fatalf("arg %q reached the judge at %d chars, want ≤%d", k, len(v), judgeArgValueMaxChars)
			}
			if strings.Contains(v, strings.Repeat("a", 100)) {
				t.Fatalf("arg %q carried the raw document to the judge", k)
			}
			if isSecretArgName(k) && v != judgeSecretMarker {
				t.Fatalf("secret-named arg %q travelled with a value: %q", k, v)
			}
		}
	}
	if total == 0 {
		t.Fatal("the judge saw no args at all")
	}
}

// CONTRACT §3: the judge is told the caller's role. The route reads the
// caller's CURRENT role in the project the turn is about and carries it on the
// request; the store's `contributor` is the contract's `member`, a role it does
// not name is dropped, and with nothing resolved an org admin still says so
// while a plain member's "" reads as "not sure, ask".
func TestDecideGateHandsTheJudgeTheCallersRole(t *testing.T) {
	cases := []struct {
		name  string
		role  string
		admin bool
		want  string
	}{
		{"maintainer", "maintainer", false, "maintainer"},
		{"viewer", "viewer", false, "viewer"},
		{"owner", "owner", false, "owner"},
		{"member passes through", "member", false, "member"},
		{"contributor is the contract's member", "contributor", false, "member"},
		{"trimmed and lower-cased", " Maintainer ", false, "maintainer"},
		{"no role, org admin", "", true, "owner"},
		{"no role, plain member", "", false, ""},
		{"unknown role, plain member", "superuser", false, ""},
		{"unknown role, org admin falls back to owner", "superuser", true, "owner"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			j := &fakeJudge{verdict: JudgeVerdict{Allow: true}}
			r := newJudgeRunner(t, j)
			_, _, _ = r.decideGate(context.Background(), TrustAskRisky, ClassRisky, "run.start",
				map[string]string{"project_id": "p-1"}, TurnRequest{
					Caller:      Caller{UserID: "u", OrganizationID: "o", IsOrgAdmin: tc.admin},
					ProjectRole: tc.role,
				})
			j.mu.Lock()
			defer j.mu.Unlock()
			if len(j.inputs) != 1 {
				t.Fatalf("judge inputs = %d, want 1", len(j.inputs))
			}
			if got := j.inputs[0].Role; got != tc.want {
				t.Fatalf("judge role = %q, want %q", got, tc.want)
			}
		})
	}
}
