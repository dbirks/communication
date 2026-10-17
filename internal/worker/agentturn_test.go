package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// The agent.acp wave (docs/m4-contract.md § 4 steps 4–6, 8, 10–12): the
// launch sequence composed at attempt scope, the permission bridge that
// decides from the node policy and events BOTH sides honestly, the
// resume_if_supported labelling (commit 9d0e560's rule: origin is read from
// the negotiated SessionInfo, never claimed), the cancel ack arms, and the
// mapOutcome-style stop mapping. NO real ACP runs on the host — adapters live
// only in the worker image; these tests pin the MAPPING, and the real-agent
// proof is the § 7 exit.

// queueACP queues an agent.acp attempt with uuid ids and a hydrated config —
// the exact shape claim hydration produces (§ 4 step 2).
func (s *fakeAttemptStore) queueACP(attemptID, runID string, cfg map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts = append(s.attempts, &fakeAttempt{
		id: attemptID, nodeExecID: "ne-" + attemptID, runID: runID,
		nodeID: "implement", instanceKey: "/implement",
		kind: NodeKindAgentACP, attemptNumber: 1,
		scheduledAt: time.Now(), status: AttemptStatusQueued, cfg: cfg,
	})
}

// ----------------------------------------------------------------- fakes

// agentSessionStub is a domain.AgentSession driven by tests. Its Prompt
// default echoes the prompt as JSON — the bindingText path made visible —
// and scripted promptFns model the harness arms: cancel-ack, wedge, death.
type agentSessionStub struct {
	mu         sync.Mutex
	info       domain.SessionInfo
	eventsCh   chan domain.ConversationEvent
	promptFn   func(ctx context.Context, s *agentSessionStub, text string) (domain.StopReason, error)
	prompts    []string
	cancelOnce sync.Once
	cancelled  chan struct{}
	closeOnce  sync.Once
	closed     chan struct{}

	// disc, when set, makes the stub answer like an acp handle whose
	// transport died while the turn was in flight.
	disc *acp.DisconnectInfo
}

// Disconnect implements acp.DisconnectReporter for the stub.
func (s *agentSessionStub) Disconnect() (acp.DisconnectInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.disc == nil {
		return acp.DisconnectInfo{}, false
	}
	return *s.disc, true
}

func (s *agentSessionStub) diedMidTurn(info acp.DisconnectInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.disc = &info
}

func newAgentSessionStub(info domain.SessionInfo) *agentSessionStub {
	if info.ACPSessionID == "" {
		info.ACPSessionID = "acp-fake-1"
	}
	if info.Origin == "" {
		info.Origin = events.SessionOriginNew
	}
	if info.LauncherID == "" {
		info.LauncherID = "claude"
	}
	return &agentSessionStub{
		info:      info,
		eventsCh:  make(chan domain.ConversationEvent, 32),
		cancelled: make(chan struct{}),
		closed:    make(chan struct{}),
	}
}

func (s *agentSessionStub) Info() domain.SessionInfo { return s.info }

func (s *agentSessionStub) Prompt(ctx context.Context, text string) (domain.StopReason, error) {
	s.mu.Lock()
	s.prompts = append(s.prompts, text)
	fn := s.promptFn
	s.mu.Unlock()
	if fn == nil {
		s.sendChunk(`{"prompt": ` + strconv.Quote(text) + `}`)
		return domain.StopEndTurn, nil
	}
	return fn(ctx, s, text)
}

func (s *agentSessionStub) Cancel(context.Context) error {
	s.cancelOnce.Do(func() { close(s.cancelled) })
	return nil
}

func (s *agentSessionStub) Events() <-chan domain.ConversationEvent { return s.eventsCh }

func (s *agentSessionStub) Close() error {
	s.closeOnce.Do(func() {
		close(s.closed)
		close(s.eventsCh)
	})
	return nil
}

func (s *agentSessionStub) sendChunk(text string) {
	s.eventsCh <- domain.ConversationEvent{Kind: "message_chunk", Text: text}
}

func (s *agentSessionStub) sendToolCall() {
	s.eventsCh <- domain.ConversationEvent{Kind: "tool_call", ToolCallID: "t1", Text: "edit"}
}

func (s *agentSessionStub) promptCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.prompts)
}

// spawnStub records every SessionRequest and context the executor composes.
type spawnStub struct {
	mu       sync.Mutex
	reqs     []domain.SessionRequest
	ctxs     []context.Context
	sessions []*agentSessionStub
	next     int
	err      error
}

func (f *spawnStub) NewSession(ctx context.Context, req domain.SessionRequest) (domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	f.ctxs = append(f.ctxs, context.WithoutCancel(ctx))
	if f.err != nil {
		return nil, f.err
	}
	if f.next >= len(f.sessions) {
		return nil, errFake("spawnStub: no session queued")
	}
	s := f.sessions[f.next]
	f.next++
	return s, nil
}

func (f *spawnStub) queue(s ...*agentSessionStub) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = append(f.sessions, s...)
}

func (f *spawnStub) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

func (f *spawnStub) lastReq() domain.SessionRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[len(f.reqs)-1]
}

func (f *spawnStub) lastCtxPlan() (acp.LaunchPlan, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return acp.LaunchPlanFromContext(f.ctxs[len(f.ctxs)-1])
}

// profilesStub is the pinned-revision profile read (AgentProfileResolver).
type profilesStub struct {
	mu     sync.Mutex
	prof   AgentProfile
	ok     bool
	err    error
	called []string
}

func (p *profilesStub) AgentProfileFor(_ context.Context, _ AttemptClaim, name string) (AgentProfile, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.called = append(p.called, name)
	if p.err != nil {
		return AgentProfile{}, false, p.err
	}
	if !p.ok {
		return AgentProfile{}, false, nil
	}
	return p.prof, true, nil
}

// sessionsStub is the § 4 step 6 pair + binding bookkeeping.
type sessionsStub struct {
	mu            sync.Mutex
	conv          AttemptConversation
	stamped       bool
	convErr       error
	resumable     domain.SessionInfo
	haveResumable bool
	recordErr     error
	recorded      []domain.SessionInfo
	closedReasons []string
}

func (s *sessionsStub) ConversationFor(context.Context, AttemptClaim) (AttemptConversation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.convErr != nil {
		return AttemptConversation{}, false, s.convErr
	}
	if !s.stamped {
		return AttemptConversation{}, false, nil
	}
	return s.conv, true, nil
}

func (s *sessionsStub) ResumableSession(context.Context, string, string) (domain.SessionInfo, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resumable, s.haveResumable, nil
}

func (s *sessionsStub) RecordBinding(_ context.Context, _ AttemptClaim, _ string, info domain.SessionInfo) (string, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recordErr != nil {
		return "", nil, s.recordErr
	}
	s.recorded = append(s.recorded, info)
	return "binding-1", nil, nil
}

func (s *sessionsStub) CloseBinding(_ context.Context, _, _, reason string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closedReasons = append(s.closedReasons, reason)
	return []string{"binding-1"}, nil
}

func (s *sessionsStub) snapshot() (recorded []domain.SessionInfo, closed []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]domain.SessionInfo(nil), s.recorded...), append([]string(nil), s.closedReasons...)
}

// ------------------------------------------------------------- fixture

type agentTurnFixture struct {
	root     string
	layout   wsgit.Layout
	turn     *AgentTurn
	spawn    *spawnStub
	sessions *sessionsStub
	sink     *recordingSink
}

func newAgentTurnFixture(t *testing.T, enforcement domain.EnforcementMode) *agentTurnFixture {
	t.Helper()
	base := procExecScratch(t, "agentturn")
	wsRoot := filepath.Join(base, "workspaces")
	layout, err := wsgit.LayoutOf(wsRoot, "run", fakeRunID)
	if err != nil {
		t.Fatalf("LayoutOf: %v", err)
	}
	if err := layout.Ensure(""); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	f := &agentTurnFixture{root: base, layout: layout, spawn: &spawnStub{}}
	f.sessions = &sessionsStub{
		conv:    AttemptConversation{ConversationID: "conv-1", TurnID: "turn-1"},
		stamped: true,
	}
	f.sink = &recordingSink{stopping: make(chan struct{})}
	f.turn = &AgentTurn{
		WorkspaceRoot: wsRoot,
		LauncherHome:  filepath.Join(base, "launcher-home"),
		PolicyDir:     filepath.Join(base, "policy"),
		Enforcement:   enforcement,
		Spawn:         f.spawn,
		Sessions:      f.sessions,
		Profiles: &profilesStub{ok: true, prof: AgentProfile{
			AgentProfileID: "m4-implementer", LauncherID: "claude", PermissionMode: "deny",
		}},
		Checkpoints: stubCheckpoints{},
		// Prod always wires the launcher registry's prompting mode
		// (cmd/communication/worker.go acpAskModeID); the fixture mirrors it so
		// a deny/preapproved attempt reaches the session instead of failing
		// closed. Tests of the fail-closed arm nil this out.
		AskModeID: func(launcherID string) string {
			if l, ok := acp.LookupLauncher(launcherID); ok {
				return l.AskModeID
			}
			return ""
		},
		AckGrace: 300 * time.Millisecond,
		Quiesce:  time.Millisecond,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	return f
}

func (f *agentTurnFixture) claim(cfg map[string]any) AttemptClaim {
	return AttemptClaim{
		AttemptID: fakeAttemptID, NodeExecutionID: "ne-" + fakeAttemptID,
		RunID: fakeRunID, ProjectID: "p-1", WorkerID: "worker-1", FencingToken: 1,
		NodeID: "implement", NodeInstanceKey: "/implement", Kind: NodeKindAgentACP,
		AttemptNumber: 1, Config: cfg,
	}
}

func agentCfg(prompt string) map[string]any {
	return map[string]any{"prompt": prompt, "profile": "m4-implementer", "sessionMode": "new"}
}

// -------------------------------------------------------------- the tests

// TestAgentTurnHappyPath proves the composed sequence end to end: exactly ONE
// prompt carrying the bindingText text, the binding recorded and journalled
// with the negotiated origin, the honest disconnect, and the boundary fields
// (outputs, digest, checkpoint volume) the loop's CompleteAttempt takes
// (§ 4 steps 6 and 10).
func TestAgentTurnHappyPath(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	prompt := "Implement the approved plan. Previous review feedback: (first iteration: no prior review)"

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg(prompt)), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	if f.spawn.calls() != 1 {
		t.Fatalf("spawn calls = %d, want exactly one session per attempt (§ 4 step 14)", f.spawn.calls())
	}
	sess := f.spawn.sessions[0]
	if sess.promptCount() != 1 {
		t.Fatalf("prompts = %d, want ONE prompt turn per attempt (§ 4 step 6)", sess.promptCount())
	}
	req := f.spawn.lastReq()
	if req.WorkDir != f.layout.Repos {
		t.Errorf("WorkDir %q is not the run workspace checkout root %q", req.WorkDir, f.layout.Repos)
	}
	outs, ok := res.Outputs.(map[string]any)
	if !ok || outs["prompt"] != prompt {
		t.Fatalf("outputs = %#v, want the bindingText prompt echoed by the agent (the § 5 bindingText → real-turn path)", res.Outputs)
	}
	if !strings.HasPrefix(res.OutputsDigest, "sha256:") || len(res.OutputsDigest) != 71 {
		t.Errorf("outputs_digest %q is not a sha256 identity", res.OutputsDigest)
	}
	if res.Outcome != "passed" {
		t.Errorf("outcome = %q, want passed", res.Outcome)
	}
	if res.Checkpoint.VolumeID != "vol-stub" || res.Checkpoint.WorkspaceID != "ws-stub" {
		t.Errorf("checkpoint = %+v, want the bound workspace seam", res.Checkpoint)
	}
	if res.Checkpoint.InputsDigest == "" || res.Checkpoint.OutputsDigest != res.OutputsDigest {
		t.Errorf("checkpoint digests = %+v, want inputs digested and outputs matching", res.Checkpoint)
	}
	types := strings.Join(f.sink.types(), ",")
	if !strings.Contains(types, events.TypeAgentSessionConnected) || !strings.Contains(types, events.TypeAgentSessionDisconnected) {
		t.Fatalf("session events missing: %s", types)
	}
	connected := f.sink.events[0].Payload.(events.SessionConnectedPayload)
	if connected.SessionOrigin != events.SessionOriginNew || connected.BindingID != "binding-1" {
		t.Errorf("connected payload = %+v, want origin new for a session this attempt created", connected)
	}
	recorded, closed := f.sessions.snapshot()
	if len(recorded) != 1 || recorded[0].Origin != events.SessionOriginNew {
		t.Errorf("recorded bindings = %+v", recorded)
	}
	if len(closed) != 1 || closed[0] != "process_exited" {
		t.Errorf("close reasons = %v, want the honest process_exited", closed)
	}
}

// TestAgentTurnOutcomeMapping is the mapOutcome-style table: what the harness
// says, plus which stop arm we are in, decides the honest attempt terminal.
// A mocked green unit test does not substitute for the § 7 real-agent leg —
// but the MAPPING is exactly what two workers must not invent.
func TestAgentTurnOutcomeMapping(t *testing.T) {
	cases := []struct {
		name       string
		text       []string
		toolBefore string // emit a tool call, then this text, proving the reset rule
		stop       domain.StopReason
		promptErr  error
		wantStatus string
		wantClass  string
		wantMarker string // substring of Detail or of an output_errors entry
	}{
		{"end_turn json object is outputs", []string{`{"summary":"done"}`}, "", domain.StopEndTurn, nil, AttemptStatusSucceeded, "", ""},
		{"fenced json block extracts", []string{"Answer:\n```json\n{\"approved\": true}\n```"}, "", domain.StopEndTurn, nil, AttemptStatusSucceeded, "", ""},
		{"json inside prose extracts", []string{`Done. Result: {"ok": 1}`}, "", domain.StopEndTurn, nil, AttemptStatusSucceeded, "", ""},
		{"text before a tool call is not final", []string{`{"stale": true}`}, `{"fresh": true}`, domain.StopEndTurn, nil, AttemptStatusSucceeded, "", ""}, {"no json is invalid_output", []string{"I could not do it"}, "", domain.StopEndTurn, nil, AttemptStatusFailed, ErrorClassInvalidOutput, "invalid_json"},
		{"empty reply is invalid_output", nil, "", domain.StopEndTurn, nil, AttemptStatusFailed, ErrorClassInvalidOutput, "no text"},
		{"a json array is not outputs", []string{`[1,2]`}, "", domain.StopEndTurn, nil, AttemptStatusFailed, ErrorClassInvalidOutput, "not an object"},
		{"refusal is agent_error", nil, "", domain.StopRefusal, nil, AttemptStatusFailed, ErrorClassAgentError, "refused"},
		{"max_tokens is agent_error", nil, "", domain.StopMaxTokens, nil, AttemptStatusFailed, ErrorClassAgentError, "token limit"},
		{"unprompted cancel is agent_error", nil, "", domain.StopCancelled, nil, AttemptStatusFailed, ErrorClassAgentError, "no stop request"},
		{"other is agent_error", nil, "", domain.StopOther, nil, AttemptStatusFailed, ErrorClassAgentError, "other"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAgentTurnFixture(t, domain.EnforceDisabled)
			sess := newAgentSessionStub(domain.SessionInfo{})
			sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
				if tc.toolBefore != "" {
					s.sendChunk(tc.text[0])
					s.sendToolCall()
					s.sendChunk(tc.toolBefore)
				} else {
					for _, chunk := range tc.text {
						s.sendChunk(chunk)
					}
				}
				return tc.stop, tc.promptErr
			}
			f.spawn.queue(sess)
			res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("do the work")), f.sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != tc.wantStatus {
				t.Fatalf("status = %q (%s), want %q", res.Status, res.Detail, tc.wantStatus)
			}
			if tc.wantClass != "" && res.ErrorClass != tc.wantClass {
				t.Errorf("error_class = %q, want %q", res.ErrorClass, tc.wantClass)
			}
			if tc.wantMarker != "" {
				blob := strings.ToLower(res.Detail)
				if raw, err := json.Marshal(res.OutputErrors); err == nil {
					blob += " " + strings.ToLower(string(raw))
				}
				if !strings.Contains(blob, strings.ToLower(tc.wantMarker)) {
					t.Errorf("want %q in %+v", tc.wantMarker, res)
				}
			}
		})
	}

	t.Run("process death mid-turn is honest infra", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(context.Context, *agentSessionStub, string) (domain.StopReason, error) {
			return "", errors.New("acp: adapter process exited with signal 9")
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra (a dead agent is not an agent verdict)", res)
		}
	})

	t.Run("oversize outputs refuse with the § 6 code", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(context.Context, *agentSessionStub, string) (domain.StopReason, error) {
			sess.sendChunk(`{"big":"` + strings.Repeat("x", 40<<10) + `"}`)
			return domain.StopEndTurn, nil
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output", res)
		}
		raw, _ := json.Marshal(res.OutputErrors)
		if !strings.Contains(string(raw), "outputs_too_large") {
			t.Errorf("output_errors = %s, want outputs_too_large (§ 6)", raw)
		}
	})

	t.Run("node deadline mid-turn is timeout", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(ctx context.Context, _ *agentSessionStub, _ string) (domain.StopReason, error) {
			<-ctx.Done() // the harness answers the cancel with a cancelled turn
			return domain.StopCancelled, ctx.Err()
		}
		f.spawn.queue(sess)
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		res, err := f.turn.Execute(ctx, f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassTimeout {
			t.Fatalf("res = %+v, want failed/timeout (§ 4 step 7's deadline arm, mirrored)", res)
		}
	})

	t.Run("cancel without an ack is interrupted, not a claimed cancel", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
			<-s.closed // wedged: session/cancel is NOT answered; only Close frees it
			return domain.StopCancelled, nil
		}
		f.spawn.queue(sess)
		ctx, cancel := context.WithCancel(context.Background())
		go func() { time.Sleep(30 * time.Millisecond); cancel() }()
		res, err := f.turn.Execute(ctx, f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusInterrupted || res.InterruptReason != "process_group_kill_timeout" {
			t.Fatalf("res = %+v, want interrupted{process_group_kill_timeout}: the ack never came (§ 4 step 11)", res)
		}
	})

	t.Run("drain ask hands the terminal to the loop", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
			<-s.cancelled // answers the session/cancel drain sends
			return domain.StopCancelled, nil
		}
		f.spawn.queue(sess)
		close(f.sink.stopping) // drain's graceful ask, ctx NOT cancelled
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != "" || res.CancelReason != "" || res.ErrorClass != "" {
			t.Fatalf("res = %+v, want nothing honest claimed: the loop's shutdown flag writes interrupted{worker_shutdown} (§ 4 step 12)", res)
		}
	})
}

// TestAgentTurnMidTurnDisconnectIsNotInvalidOutput is the live15 C2 fix: a
// harness whose ACP session died before the turn ended produced
// invalid_output{“produced no text”}, which is not an agent verdict — the
// agent never got to give one — and invalid_output is outside the
// implement node's retriableErrors (docs/compatibility/probes/m4/pipeline.yaml
// doc 1:150 [infra, interrupted, timeout, agent_error]), so the until scope
// died unretried. ADR-0023 § 7 reserves invalid_output for a reply that
// fails its JSON Schema; a dead harness is infra, retriable by default.
func TestAgentTurnMidTurnDisconnectIsNotInvalidOutput(t *testing.T) {
	t.Run("session died mid-turn, no final text: the reason rides the detail", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
			s.sendChunk("working on it")
			s.sendToolCall() // the buffer resets; the death follows the tool call
			s.diedMidTurn(acp.DisconnectInfo{
				Reason: acp.DisconnectReasonProcessExited, Detail: "exit status 7",
			})
			return domain.StopEndTurn, nil
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed {
			t.Fatalf("status = %q, want failed (%s)", res.Status, res.Detail)
		}
		if res.ErrorClass == ErrorClassInvalidOutput {
			t.Fatalf("a dead harness was reported as an invalid answer: %+v", res)
		}
		if res.ErrorClass != ErrorClassInfra {
			t.Fatalf("error_class = %q, want infra (ADR-0023 § 7: not an agent verdict, and retriable)", res.ErrorClass)
		}
		for _, want := range []string{"disconnected before the turn ended", acp.DisconnectReasonProcessExited, "exit status 7"} {
			if !strings.Contains(res.Detail, want) {
				t.Errorf("detail %q must name the disconnect reason and carry the evidence (want %q)", res.Detail, want)
			}
		}
	})

	t.Run("disconnect carried on the prompt error names the transport", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(context.Context, *agentSessionStub, string) (domain.StopReason, error) {
			return "", &acp.DisconnectedError{
				Info: acp.DisconnectInfo{
					Reason: acp.DisconnectReasonConnectionClosed,
					Detail: `{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`,
				},
				Err: errors.New("peer disconnected before response"),
			}
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra", res)
		}
		if !strings.Contains(res.Detail, acp.DisconnectReasonConnectionClosed) {
			t.Errorf("detail %q must name %q", res.Detail, acp.DisconnectReasonConnectionClosed)
		}
	})

	t.Run("a completed turn whose reply fails the schema is still invalid_output", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
			s.sendChunk("I could not do it") // a real answer, a bad one: the schema judges it
			return domain.StopEndTurn, nil
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output — the disconnect rule must not swallow real schema failures", res)
		}
	})

	t.Run("a late death never undoes an answer that arrived", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
			s.sendChunk(`{"summary":"done"}`)
			s.diedMidTurn(acp.DisconnectInfo{Reason: acp.DisconnectReasonProcessExited, Detail: "exit status 0"})
			return domain.StopEndTurn, nil // the response arrived first: the turn ended
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded — the harness answered before it exited", res)
		}
	})
}

// TestAgentTurnPermissionRequestIsDecidedAndEvented pins the Decider bridge:
// the node policy answers synchronously, BOTH the request and the answer are
// journalled (the reused conversation.permission.* pair), the option is
// matched by KIND (domain.PermissionOption's observed-ids rule), and a deny
// returns the ACP cancelled outcome with an event — never a fabricated
// option id.
func TestAgentTurnPermissionRequestIsDecidedAndEvented(t *testing.T) {
	prompt := domain.PermissionPrompt{
		ToolCallID: "call-1", Title: "write file", Kind: "edit",
		Options: []domain.PermissionOption{
			{OptionID: "proceed_once", Label: "Allow", Kind: "allow_once"},
			{OptionID: "proceed_always", Label: "Always", Kind: "allow_always"},
			{OptionID: "cancel", Label: "No", Kind: "reject_once"},
		},
	}
	run := func(t *testing.T, policy PermissionPolicy, wantChosen string, wantStatus string) {
		t.Helper()
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.turn.Permissions = policy
		var choice domain.PermissionChoice
		var bridgeErr error
		sess := newAgentSessionStub(domain.SessionInfo{})
		sess.promptFn = func(ctx context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
			decider := f.spawn.lastReq().Decider
			if decider == nil {
				t.Error("the session was launched without a Decider bridge")
			}
			choice, bridgeErr = decider(ctx, prompt)
			s.sendChunk(`{"ok": true}`)
			return domain.StopEndTurn, nil
		}
		f.spawn.queue(sess)
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want the turn to survive the permission round-trip", res)
		}
		if bridgeErr != nil {
			t.Fatalf("bridge: %v", bridgeErr)
		}
		if choice.OptionID != wantChosen {
			t.Fatalf("choice = %q, want %q", choice.OptionID, wantChosen)
		}
		var requested *events.PermissionRequestedPayload
		var decided *events.PermissionDecidedPayload
		for _, ev := range f.sink.events {
			if p, ok := ev.Payload.(events.PermissionRequestedPayload); ok {
				copied := p
				requested = &copied
			}
			if p, ok := ev.Payload.(events.PermissionDecidedPayload); ok {
				copied := p
				decided = &copied
			}
		}
		if requested == nil || decided == nil {
			t.Fatalf("permission events missing: %v", f.sink.types())
		}
		if requested.ConversationID != "conv-1" || requested.TurnID != "turn-1" || requested.PermissionRequestID == "" {
			t.Errorf("requested payload is not correlated to the attempt's pair: %+v", requested)
		}
		if len(requested.Options) != 3 {
			t.Errorf("requested options = %d, want the prompt's own set", len(requested.Options))
		}
		if requested.PermissionRequestID != decided.PermissionRequestID {
			t.Errorf("request/decided ids differ: %q vs %q", requested.PermissionRequestID, decided.PermissionRequestID)
		}
		if decided.Status != wantStatus || decided.DecisionOptionID != wantChosen {
			t.Errorf("decided = (%q, %q), want (%q, %q)", decided.Status, decided.DecisionOptionID, wantStatus, wantChosen)
		}
		if requested.TurnID != "turn-1" {
			t.Errorf("requested turn id %q", requested.TurnID)
		}
	}

	t.Run("policy allow is decided and evented", func(t *testing.T) {
		run(t, func(domain.PermissionPrompt) PermissionVerdict {
			return PermissionVerdict{OptionKind: "allow_once", DecidedBy: "node-policy"}
		}, "proceed_once", events.PermissionStatusDecided)
	})
	t.Run("policy rejection option is decided", func(t *testing.T) {
		run(t, func(domain.PermissionPrompt) PermissionVerdict {
			return PermissionVerdict{OptionKind: "reject_once", DecidedBy: "node-policy"}
		}, "cancel", events.PermissionStatusDecided)
	})
	t.Run("no matching option is an honest deny", func(t *testing.T) {
		run(t, func(domain.PermissionPrompt) PermissionVerdict {
			return PermissionVerdict{OptionKind: "allow_always_root", DecidedBy: "node-policy"}
		}, "", events.PermissionStatusCancelled)
	})
	t.Run("no policy denies fail-closed", func(t *testing.T) {
		run(t, nil, "", events.PermissionStatusCancelled)
	})
}

// TestAgentTurnResumeIfSupportedLabelsReuse pins the § 4 step 6 session arms:
// the binding's existence answers resume_if_supported, the negotiated origin
// is what the connected event and the binding RECORD (never a claimed
// `resumed` for a session that was not loaded — commit 9d0e560), and the
// fallback decides what the provider cannot resume.
func TestAgentTurnResumeIfSupportedLabelsReuse(t *testing.T) {
	t.Run("a resumable binding is loaded and labelled resumed", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.sessions.haveResumable = true
		f.sessions.resumable = domain.SessionInfo{ACPSessionID: "acp-prev",
			AgentCapabilities: map[string]any{"loadSession": true}}
		f.spawn.queue(newAgentSessionStub(domain.SessionInfo{
			ACPSessionID: "acp-prev", Origin: events.SessionOriginResumed,
		}))
		cfg := agentCfg("carry on the implementation")
		cfg["sessionMode"] = "resume_if_supported"
		cfg["fallback"] = "new"

		res, err := f.turn.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v", res)
		}
		if got := f.spawn.lastReq().LoadSessionID; got != "acp-prev" {
			t.Fatalf("LoadSessionID = %q, want the stored binding's session", got)
		}
		connected := f.sink.events[0].Payload.(events.SessionConnectedPayload)
		if connected.SessionOrigin != events.SessionOriginResumed {
			t.Errorf("connected origin = %q, want resumed — the label follows the negotiation, not the wish", connected.SessionOrigin)
		}
		recorded, _ := f.sessions.snapshot()
		if len(recorded) != 1 || recorded[0].Origin != events.SessionOriginResumed {
			t.Errorf("recorded binding = %+v, want origin resumed", recorded)
		}
	})

	t.Run("no binding with fallback new spawns new and says so", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
		cfg := agentCfg("start the implementation")
		cfg["sessionMode"] = "resume_if_supported"

		res, err := f.turn.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v", res)
		}
		if got := f.spawn.lastReq().LoadSessionID; got != "" {
			t.Errorf("LoadSessionID = %q without a binding: resume is answered by existence", got)
		}
		connected := f.sink.events[0].Payload.(events.SessionConnectedPayload)
		if connected.SessionOrigin != events.SessionOriginNew {
			t.Errorf("connected origin = %q, want new", connected.SessionOrigin)
		}
	})

	t.Run("no binding with fallback fail refuses honestly", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		cfg := agentCfg("start the implementation")
		cfg["sessionMode"] = "resume_if_supported"
		cfg["fallback"] = "fail"

		res, err := f.turn.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "fallback: fail") {
			t.Fatalf("res = %+v, want the honest fallback:fail refusal", res)
		}
		if f.spawn.calls() != 0 {
			t.Errorf("spawned %d sessions after refusing: nothing may launch on the fail arm", f.spawn.calls())
		}
	})

	t.Run("a provider that silently did not resume fails on fallback fail", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.sessions.haveResumable = true
		f.sessions.resumable = domain.SessionInfo{ACPSessionID: "acp-prev"}
		f.spawn.queue(newAgentSessionStub(domain.SessionInfo{Origin: events.SessionOriginNew}))
		cfg := agentCfg("carry on")
		cfg["sessionMode"] = "resume_if_supported"
		cfg["fallback"] = "fail"

		res, err := f.turn.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || !strings.Contains(res.Detail, "did not resume") {
			t.Fatalf("res = %+v, want the refused-load failure, never a continued new session on the fail arm", res)
		}
	})
}

// TestAgentTurnDefensiveRefusals covers the config shapes the compiler is
// supposed to have blocked (§ 4 step 14's belt) and the wiring gaps named by
// step.
func TestAgentTurnDefensiveRefusals(t *testing.T) {
	t.Run("continue_live is refused even though the compiler blocks it", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		cfg := agentCfg("x")
		cfg["sessionMode"] = "continue_live"
		res, err := f.turn.Execute(context.Background(), f.claim(cfg), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "continue_live") {
			t.Fatalf("res = %+v, want the defensive continue_live refusal (§ 4 step 14)", res)
		}
		if f.spawn.calls() != 0 {
			t.Errorf("no session may be spawned for a refused mode, got %d", f.spawn.calls())
		}
	})

	t.Run("unresolved prompt is a binding_error", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		res, err := f.turn.Execute(context.Background(), f.claim(map[string]any{
			"prompt":  map[string]any{"$unresolved": true, "expr_ids": []any{"e7"}, "template": "run ${{ x }}"},
			"profile": "m4-implementer",
		}), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassBindingError {
			t.Fatalf("res = %+v, want failed/binding_error (§ 4 step 14)", res)
		}
	})

	t.Run("unstamped conversation names step 6", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.sessions.stamped = false
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "step 6") {
			t.Fatalf("res = %+v, want the infra refusal naming § 4 step 6", res)
		}
	})

	t.Run("ask mode fails closed without a verified prompting mode", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.turn.AskModeID = nil
		prof := f.turn.Profiles.(*profilesStub)
		prof.mu.Lock()
		prof.prof.PermissionMode = "ask"
		prof.mu.Unlock()

		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "prompting mode") {
			t.Fatalf("res = %+v, want the fail-closed ask refusal (docs/compatibility/ACP.md)", res)
		}
		if f.spawn.calls() != 0 {
			t.Fatalf("spawned %d sessions on the refused arm", f.spawn.calls())
		}

		f.turn.AskModeID = func(string) string { return "default" }
		f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
		if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
			t.Fatalf("Execute with a verified mode: %v", err)
		}
		if got := f.spawn.lastReq().ModeID; got != "default" {
			t.Errorf("ModeID = %q, want the registry's verified prompting mode", got)
		}
	})

	// Every recorded permission mode puts the harness in its prompting mode:
	// in its default mode the adapter sends no session/request_permission, so a
	// deny or preapproved attempt that skipped set_mode would enforce nothing
	// (deny) and journal no verdict (preapproved) — ADR-0036 condition (a).
	for _, mode := range []string{"ask", "deny", "preapproved_within_sandbox"} {
		mode := mode
		t.Run(mode+" requests the launcher prompting mode", func(t *testing.T) {
			f := newAgentTurnFixture(t, domain.EnforceDisabled)
			prof := f.turn.Profiles.(*profilesStub)
			prof.mu.Lock()
			prof.prof.PermissionMode = mode
			prof.mu.Unlock()
			f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
			if _, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink); err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if got, want := f.spawn.lastReq().ModeID, "default"; got != want {
				t.Errorf("%s: ModeID = %q, want the launcher's verified prompting mode %q", mode, got, want)
			}
		})

		if mode == "ask" {
			continue // fail-closed for 'ask' is covered by the case above
		}
		t.Run(mode+" fails closed without a verified prompting mode", func(t *testing.T) {
			f := newAgentTurnFixture(t, domain.EnforceDisabled)
			f.turn.AskModeID = nil
			prof := f.turn.Profiles.(*profilesStub)
			prof.mu.Lock()
			prof.prof.PermissionMode = mode
			prof.mu.Unlock()
			res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
				!strings.Contains(res.Detail, "prompting mode") {
				t.Fatalf("%s: res = %+v, want the fail-closed refusal (docs/compatibility/ACP.md)", mode, res)
			}
			if f.spawn.calls() != 0 {
				t.Errorf("spawned %d sessions on the refused arm", f.spawn.calls())
			}
		})
	}

	t.Run("unbound success closes as infra exactly like procexec", func(t *testing.T) {
		f := newAgentTurnFixture(t, domain.EnforceDisabled)
		f.turn.Checkpoints = nil
		f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
		res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra ||
			!strings.Contains(res.Detail, "step 3") || !strings.Contains(res.Detail, "no run workspace boundary") {
			t.Fatalf("res = %+v, want the unbound-boundary infra close — never an invented checkpoint (D-024)", res)
		}
	})
}

// TestAgentTurnRequiredUsesTheAgentTurnProfile asserts the § 4 step 5 wiring:
// verify-then-launch with the agent-turn profile (network_enforced=false
// stays the honest label — this is NOT the egress-denied command profile),
// sandbox.verified journalled from the observed chain, and a refusal that
// fails sandbox_enforcement_failed visibly with no fallback launch.
func TestAgentTurnRequiredUsesTheAgentTurnProfile(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{}
	f.turn.Sandbox = fake
	f.turn.SandboxPath = "/usr/local/bin/nono"
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v", res)
	}
	if fake.calls() != 1 {
		t.Fatalf("Verify calls = %d, want 1 (no verify, no spawn — ADR-0019)", fake.calls())
	}
	spec := fake.lastSpec()
	if spec.Profile.Kind != nono.ProfileAgentTurn {
		t.Errorf("profile kind = %q, want %q", spec.Profile.Kind, nono.ProfileAgentTurn)
	}
	if spec.BlockNet {
		t.Error("the agent-turn profile does not claim egress denial; --block-net belongs to communication-command (§ 4 step 5)")
	}
	if spec.AdapterPath != "claude-agent-acp" {
		t.Errorf("adapter = %q, want the registry executable", spec.AdapterPath)
	}
	plan, ok := f.spawn.lastCtxPlan()
	if !ok || plan.Path != "/usr/local/bin/nono" || plan.Verified == nil || plan.Verified.NetworkEnforced {
		t.Errorf("spawn received plan %+v, want the verified nono argv with the honest network label", plan)
	}
	types := strings.Join(f.sink.types(), ",")
	if !strings.Contains(types, events.TypeSandboxVerified) {
		t.Fatalf("sandbox.verified missing: %s", types)
	}
	for _, ev := range f.sink.events {
		if p, ok := ev.Payload.(events.SandboxVerifiedPayload); ok {
			if !p.Verified || p.NetworkEnforced {
				t.Errorf("verified payload = %+v, want Verified from the chain and NetworkEnforced false (M3's label, § 0)", p)
			}
		}
	}
}

func TestAgentTurnRequiredRefusalIsHonestAndJournalled(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	f.turn.Sandbox = &recordingSandbox{err: &nono.Failure{
		Stage: "grant_assert", Reason: "grant_mismatch", Err: errors.New("resolved grant set is not the recorded one"),
	}}
	f.turn.SandboxPath = "/usr/local/bin/nono"
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("x")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassSandboxEnforcementFail {
		t.Fatalf("res = %+v, want failed/sandbox_enforcement_failed (ADR-0019 D6: no fallback run)", res)
	}
	types := strings.Join(f.sink.types(), ",")
	if !strings.Contains(types, events.TypeSandboxEnforcementFailed) {
		t.Errorf("sandbox.enforcement_failed missing: %s", types)
	}
	if strings.Contains(res.Detail, f.root) {
		t.Errorf("detail leaked host paths: %s", res.Detail)
	}
	if f.spawn.calls() != 0 {
		t.Errorf("spawned %d sessions after a sandbox refusal", f.spawn.calls())
	}
}

// TestAgentTurnCancelWatchThroughTheLoop runs the REAL attempt loop with the
// REAL executor under -race: the cancel watch stops the body, the executor
// sends session/cancel, the ack names the terminal (§ 4 step 11), and the
// attempt closes cancelled — never silently dropped.
func TestAgentTurnCancelWatchThroughTheLoop(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queueACP(fakeAttemptID, fakeRunID, agentCfg("long implementation turn"))
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
		<-s.cancelled // the ACP turn ends only when session/cancel arrives
		return domain.StopCancelled, nil
	}
	f.spawn.queue(sess)

	l := newLoopForAgent(t, store, AttemptExecutors{NodeKindAgentACP: f.turn}, 1)
	startLoop(t, l)
	waitFor(t, "attempt began", func() bool { return store.snapshot(fakeAttemptID).status == AttemptStatusRunning })
	store.setCancel(fakeAttemptID, time.Now())
	waitFor(t, "attempt cancelled", func() bool { return l.attemptsCompleted() >= 1 })

	a := store.snapshot(fakeAttemptID)
	if a.status != AttemptStatusCancelled {
		t.Fatalf("status %s, want cancelled", a.status)
	}
	if a.errorClass != ErrorClassCancelled || a.detail != CancelReasonACPAck {
		t.Fatalf("class %q reason %q, want cancelled/acp_cancel_ack (the session/cancel ack IS the reason)", a.errorClass, a.detail)
	}
	if _, active, _ := store.counts(); active != 0 {
		t.Fatalf("active slot not released after cancel terminal: %v", store.writeLog())
	}
}

// TestAgentTurnTakeoverClosesThePairedTurn runs ADR-0016 § 5's takeover through
// the REAL loop and the REAL executor: take-control closes the attempt over the
// worker's head and cancel-requests the pair in one transaction; the worker must
// still send ACP session/cancel and — having earned the ack — close the ONE row
// the takeover left it, the conversation turn. If it does not, the turn sits
// leased until the reconciler's lease arm expires it (~50s) and the resumed
// attempt's turn is refused by the one-active-turn index beside it.
func TestAgentTurnTakeoverClosesThePairedTurn(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queueACP(fakeAttemptID, fakeRunID, agentCfg("long implementation turn"))
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
		<-s.cancelled // the harness answers only when session/cancel arrives
		return domain.StopCancelled, nil
	}
	f.spawn.queue(sess)

	l := newLoopForAgent(t, store, AttemptExecutors{NodeKindAgentACP: f.turn}, 1)
	startLoop(t, l)
	waitFor(t, "attempt began", func() bool { return store.snapshot(fakeAttemptID).status == AttemptStatusRunning })
	store.takeOverAttempt(fakeAttemptID)
	waitFor(t, "taken-over attempt stopped", func() bool { return l.attemptsCompleted() >= 1 })

	select {
	case <-sess.cancelled:
	default:
		t.Fatal("no ACP session/cancel was sent for the taken-over turn")
	}
	if a := store.snapshot(fakeAttemptID); a.turnClosed != "cancelled" {
		t.Fatalf("paired turn close = %q, want cancelled: %v", a.turnClosed, store.writeLog())
	}
	for _, w := range store.writeLog() {
		if strings.HasPrefix(w, "cancel "+fakeAttemptID) || strings.HasPrefix(w, "interrupt "+fakeAttemptID) {
			t.Fatalf("the taken-over worker wrote an attempt terminal the takeover owns: %v", store.writeLog())
		}
	}
	if a := store.snapshot(fakeAttemptID); a.status != AttemptStatusInterrupted || a.errorClass != ErrorClassInterrupted {
		t.Fatalf("the takeover's own attempt terminal was disturbed: status=%s class=%s", a.status, a.errorClass)
	}
}

// TestAgentTurnCancelWriteFailureIsNotAnAck pins the honesty of the cancel arm:
// a session/cancel whose WRITE failed never reached the harness, so no ack was
// earned — interrupted{process_group_kill_timeout}, never a cancelled claiming
// acp_cancel_ack (which is also what licenses the takeover's turn close).
func TestAgentTurnCancelWriteFailureIsNotAnAck(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the attempt loop stopped the body
	res := f.turn.mapTurnOutcome(ctx, domain.StopCancelled, nil,
		turnStop{cancelFailed: true})
	if res.Status != AttemptStatusInterrupted || res.InterruptReason != interruptReasonKillTimeout {
		t.Fatalf("result = %+v, want interrupted/%s", res, interruptReasonKillTimeout)
	}
	if res.CancelReason != "" {
		t.Fatalf("a cancel nobody received reported ack %q", res.CancelReason)
	}
}

// executor: a renewal rejected on the fence stops the body, and NOTHING this
// executor would normally do at the teardown — the disconnect event, the
// binding close, any terminal — may touch the attempt after the steal
// (runner.go's abandon rule).
func TestAgentTurnLeaseLossMidTurnStopsWriting(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queueACP(fakeAttemptID, fakeRunID, agentCfg("x"))
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.promptFn = func(ctx context.Context, _ *agentSessionStub, _ string) (domain.StopReason, error) {
		<-ctx.Done()
		return domain.StopCancelled, ctx.Err()
	}
	f.spawn.queue(sess)

	l := newLoopForAgent(t, store, AttemptExecutors{NodeKindAgentACP: f.turn}, 1)
	startLoop(t, l)
	waitFor(t, "attempt live and renewing", func() bool { return store.snapshot(fakeAttemptID).renews >= 1 })
	store.steal(fakeAttemptID)
	waitFor(t, "stale attempt stops", func() bool { return l.attemptsCompleted() >= 1 })
	time.Sleep(30 * time.Millisecond)

	for _, e := range store.writeLog() {
		if strings.Contains(e, "complete ") || strings.Contains(e, "fail ") ||
			strings.Contains(e, "cancel "+fakeAttemptID) || strings.Contains(e, "interrupt ") {
			t.Fatalf("a terminal write landed after the fence rejected us: %v", store.writeLog())
		}
	}
	if _, closed := f.sessions.snapshot(); len(closed) != 0 {
		t.Fatalf("the stale worker closed the new owner's binding: %v", closed)
	}
	if a := store.snapshot(fakeAttemptID); a.workerID != "worker-thief" || a.finishedAt.Nanosecond() != 0 {
		t.Fatalf("stale worker disturbed the new owner: %+v", a)
	}
}

// TestAgentTurnDispatchThroughTheLoop proves the routing the deliverable
// claims: an agent.acp claim lands on AgentTurn (not refusalExecutor), the
// begin/renew cadence covers the body, and the boundary transaction carries
// the executor's outputs, digest, outcome and checkpoint (§ 4 steps 2, 6, 10).
func TestAgentTurnDispatchThroughTheLoop(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queueACP(fakeAttemptID, fakeRunID, agentCfg("implement the plan"))
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))

	l := newLoopForAgent(t, store, AttemptExecutors{NodeKindAgentACP: f.turn}, 1)
	startLoop(t, l)
	waitFor(t, "attempt terminal", func() bool { return store.snapshot(fakeAttemptID).finishedAt.Nanosecond() != 0 })

	a := store.snapshot(fakeAttemptID)
	if a.status != AttemptStatusSucceeded {
		t.Fatalf("status %s (%s/%s), want succeeded — the refusal executor would have said no executor exists",
			a.status, a.errorClass, a.detail)
	}
	if a.outcome != "passed" || a.digest == "" || a.checkpoint == nil || a.checkpoint.VolumeID != "vol-stub" {
		t.Fatalf("boundary transaction incomplete: %+v", a)
	}
	if outs, ok := a.outputs.(map[string]any); !ok || outs["prompt"] != "implement the plan" {
		t.Fatalf("stored outputs = %#v", a.outputs)
	}
	log := strings.Join(store.writeLog(), "\n")
	if !strings.Contains(log, "begin "+fakeAttemptID) || !strings.Contains(log, "complete "+fakeAttemptID) {
		t.Fatalf("begin/complete missing from the write order: %v", store.writeLog())
	}
}

// TestAgentTurnOutputsAreTheAgentJSON pins that the executor emits the agent
// reply's JSON object as outputs — the engine validates it against the node
// schema at Complete (§ 4 step 6); the worker neither wraps it in engine keys
// nor invents fields the schema never declared.
func TestAgentTurnOutputsAreTheAgentJSON(t *testing.T) {
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.promptFn = func(context.Context, *agentSessionStub, string) (domain.StopReason, error) {
		sess.sendChunk(`{"summary":"added docstring","files_changed":["hello.py"]}`)
		return domain.StopEndTurn, nil
	}
	f.spawn.queue(sess)
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("reply with JSON only")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v", res)
	}
	outs := res.Outputs.(map[string]any)
	if len(outs) != 2 || outs["summary"] != "added docstring" {
		t.Fatalf("outputs = %#v, want exactly the agent's JSON", res.Outputs)
	}
	if files, ok := outs["files_changed"].([]any); !ok || len(files) != 1 {
		t.Errorf("files_changed = %#v", outs["files_changed"])
	}
}

func newLoopForAgent(t *testing.T, store *fakeAttemptStore, execs AttemptExecutors, capacity int) *AttemptLoop {
	t.Helper()
	l, err := NewAttemptLoop(fastAttemptConfig(capacity), store, execs,
		func() string { return "worker-1" },
		WithAttemptLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
	if err != nil {
		t.Fatalf("NewAttemptLoop: %v", err)
	}
	return l
}

// --- ADR-0017 D4: the attempt plan's mirror grant axis -----------------------
//
// The lab's agent.task node could run no git command at all: the attempt's
// hand-built grant set omitted RoleMirrorRead, which probe P10 measured as
// never optional — every git command in a linked worktree dies with
// "fatal: not a git repository" without it (the worktree .git file points into
// the mirror tree). These pins hold the attempt shape to what wsgit.Plan
// builds: mirror_read always, the four commit-axis writes only under the
// profile's commit grant, in Plan's role order.

func agentTurnMirrorFixture(t *testing.T, commitGranted bool) (*agentTurnFixture, *recordingSandbox, string, string) {
	t.Helper()
	f := newAgentTurnFixture(t, domain.EnforceRequired)
	fake := &recordingSandbox{}
	f.turn.Sandbox = fake
	f.turn.SandboxPath = "/usr/local/bin/nono"
	mirror := filepath.Join(f.root, "repos", "proj-mirror", "app.git")
	checkout := filepath.Join(f.layout.Repos, "app")
	adminDir := filepath.Join(mirror, "worktrees", "app")
	for _, dir := range []string{
		filepath.Join(mirror, "objects"),
		filepath.Join(mirror, "refs", "heads", fakeRunID),
		filepath.Join(mirror, "logs", "refs", "heads", fakeRunID),
		adminDir,
		checkout,
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(checkout, ".git"), []byte("gitdir: "+adminDir+"\n"), 0o600); err != nil {
		t.Fatalf("write gitfile: %v", err)
	}
	f.turn.Secrets = &agentSecretsStub{repos: []MaterializeRepo{{
		ID: "repo-1", Name: "app", CheckoutPath: checkout, MirrorPath: mirror,
	}}}
	f.turn.Profiles = &profilesStub{ok: true, prof: AgentProfile{
		AgentProfileID: "m4-implementer", LauncherID: "claude", PermissionMode: "deny",
		CommitGranted: commitGranted,
	}}
	f.spawn.queue(newAgentSessionStub(domain.SessionInfo{}))
	return f, fake, mirror, adminDir
}

func hasGrant(grants []wsgit.Grant, role, path string) bool {
	for _, g := range grants {
		if g.Role == role && g.Path == path {
			return true
		}
	}
	return false
}

func grantPaths(grants []wsgit.Grant, role string) []string {
	var out []string
	for _, g := range grants {
		if g.Role == role {
			out = append(out, g.Path)
		}
	}
	return out
}

func TestAgentTurnAttemptPlanGrantsTheMirrorReadAlways(t *testing.T) {
	f, fake, mirror, _ := agentTurnMirrorFixture(t, false)
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	plan := fake.lastSpec().Plan
	if !hasGrant(plan.Grants, wsgit.RoleMirrorRead, mirror) {
		t.Errorf("grants = %+v, want a mirror_read grant on %s (probe P10: without it every git command in the worktree dies)", plan.Grants, mirror)
	}
	for _, role := range []string{wsgit.RoleMirrorObjects, wsgit.RoleMirrorRef, wsgit.RoleMirrorReflog, wsgit.RoleWorktreeAdmin} {
		if got := grantPaths(plan.Grants, role); len(got) != 0 {
			t.Errorf("commit-axis grant %s present without the commit axis: %v", role, got)
		}
	}
	// The pre-existing attempt shape is untouched: same checkout/scratch/home
	// grants, same cwd.
	if !hasGrant(plan.Grants, wsgit.RoleCheckout, f.layout.Repos) ||
		!hasGrant(plan.Grants, wsgit.RoleScratch, f.layout.Scratch) ||
		!hasGrant(plan.Grants, wsgit.RoleAgentHome, f.layout.Home) {
		t.Errorf("grants = %+v, want the checkout/scratch/home grants unchanged", plan.Grants)
	}
	if plan.Cwd != f.layout.Repos {
		t.Errorf("cwd = %q, want %q unchanged", plan.Cwd, f.layout.Repos)
	}
}

func TestAgentTurnAttemptPlanGrantsTheCommitAxisOnlyWhenGranted(t *testing.T) {
	f, fake, mirror, adminDir := agentTurnMirrorFixture(t, true)
	res, err := f.turn.Execute(context.Background(), f.claim(agentCfg("work")), f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("res = %+v, want succeeded", res)
	}
	plan := fake.lastSpec().Plan
	if !plan.CommitGranted {
		t.Errorf("plan.CommitGranted = false, want the profile axis carried through")
	}
	want := [][2]string{
		{wsgit.RoleMirrorRead, mirror},
		{wsgit.RoleMirrorObjects, filepath.Join(mirror, "objects")},
		{wsgit.RoleMirrorRef, filepath.Join(mirror, "refs", "heads", fakeRunID)},
		{wsgit.RoleMirrorReflog, filepath.Join(mirror, "logs", "refs", "heads", fakeRunID)},
		{wsgit.RoleWorktreeAdmin, adminDir},
	}
	for _, w := range want {
		if !hasGrant(plan.Grants, w[0], w[1]) {
			t.Errorf("grants = %+v, want %s at %s", plan.Grants, w[0], w[1])
		}
	}
	// Plan's per-repo role order, contiguously: read first, then the four
	// writes — the attempt must not reorder the axis wsgit.Plan defines.
	roles := make([]string, 0, len(plan.Grants))
	for _, g := range plan.Grants {
		for _, w := range want {
			if g.Role == w[0] && g.Path == w[1] {
				roles = append(roles, g.Role)
				break
			}
		}
	}
	wantRoles := []string{wsgit.RoleMirrorRead, wsgit.RoleMirrorObjects, wsgit.RoleMirrorRef, wsgit.RoleMirrorReflog, wsgit.RoleWorktreeAdmin}
	if strings.Join(roles, ",") != strings.Join(wantRoles, ",") {
		t.Errorf("mirror axis order = %v, want %v (Plan's shape)", roles, wantRoles)
	}
	// And the admin dir came from the gitfile read-back, not a construction:
	// the grant is the exact directory the .git file named.
	if got := grantPaths(plan.Grants, wsgit.RoleWorktreeAdmin); len(got) != 1 || got[0] != adminDir {
		t.Errorf("mirror_admin_dir = %v, want exactly %s", got, adminDir)
	}
}
