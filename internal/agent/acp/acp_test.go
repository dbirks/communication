package acp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/dbirks/communication/internal/domain"
)

const (
	fakeSessionID = "fake-session"
	fakeEnvMarker = "ACP_GO_TEST_FAKE_AGENT"
	// fakeDieMidTurnEnv makes the stdio fake answer a prompt by streaming a
	// chunk, opening a tool call, and killing itself: the live-harness death
	// the disconnect classification exists for.
	fakeDieMidTurnEnv = "ACP_GO_TEST_DIE_MID_TURN"
)

// TestMain re-executes the test binary as a minimal ACP agent process for
// the subprocess lifecycle test.
func TestMain(m *testing.M) {
	if os.Getenv(fakeEnvMarker) == "1" {
		runFakeAgentProcess()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fakeAgent is an in-process ACP agent built from the SDK's agent side.
type fakeAgent struct {
	conn    *acp.AgentSideConnection
	rawOut  io.Writer // agent→client pipe for wire-level unknown messages
	rawMu   sync.Mutex
	extErrs []error

	mu            sync.Mutex
	lastNew       acp.NewSessionRequest
	lastMode      string
	lastLoad      string
	modeErr       error
	loadErr       error
	permResponses []acp.RequestPermissionResponse
	promptFn      func(ctx context.Context, f *fakeAgent) (acp.PromptResponse, error)

	advertiseLoad    bool
	advertiseAddDirs bool

	cancelOnce sync.Once
	cancelled  chan struct{}
}

func newFakeAgent() *fakeAgent {
	return &fakeAgent{advertiseLoad: true, advertiseAddDirs: true, cancelled: make(chan struct{})}
}

func (f *fakeAgent) bind(c *acp.AgentSideConnection, raw io.Writer) {
	f.conn = c
	f.rawOut = raw
}

func (f *fakeAgent) Initialize(_ context.Context, p acp.InitializeRequest) (acp.InitializeResponse, error) {
	caps := acp.AgentCapabilities{LoadSession: f.advertiseLoad}
	if f.advertiseAddDirs {
		caps.SessionCapabilities.AdditionalDirectories = &acp.SessionAdditionalDirectoriesCapabilities{}
	}
	return acp.InitializeResponse{
		ProtocolVersion:   p.ProtocolVersion,
		AgentCapabilities: caps,
		AgentInfo:         &acp.Implementation{Name: "fake-agent", Version: "0.0.1"},
		AuthMethods:       []acp.AuthMethod{},
	}, nil
}

func (f *fakeAgent) NewSession(_ context.Context, p acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	f.mu.Lock()
	f.lastNew = p
	f.mu.Unlock()
	return acp.NewSessionResponse{SessionId: acp.SessionId(fakeSessionID)}, nil
}

func (f *fakeAgent) Prompt(ctx context.Context, p acp.PromptRequest) (acp.PromptResponse, error) {
	if f.promptFn != nil {
		return f.promptFn(ctx, f)
	}
	return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
}

func (f *fakeAgent) Cancel(_ context.Context, _ acp.CancelNotification) error {
	f.cancelOnce.Do(func() { close(f.cancelled) })
	return nil
}

func (f *fakeAgent) recordPermission(resp acp.RequestPermissionResponse) {
	f.mu.Lock()
	f.permResponses = append(f.permResponses, resp)
	f.mu.Unlock()
}

func (f *fakeAgent) recordedPermissions() []acp.RequestPermissionResponse {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]acp.RequestPermissionResponse(nil), f.permResponses...)
}

// Unused Agent methods: answer method-not-found so tests catch accidental use.
func (f *fakeAgent) Authenticate(_ context.Context, _ acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	return acp.AuthenticateResponse{}, acp.NewMethodNotFound("authenticate")
}
func (f *fakeAgent) Logout(_ context.Context, _ acp.LogoutRequest) (acp.LogoutResponse, error) {
	return acp.LogoutResponse{}, acp.NewMethodNotFound("logout")
}
func (f *fakeAgent) CloseSession(_ context.Context, _ acp.CloseSessionRequest) (acp.CloseSessionResponse, error) {
	return acp.CloseSessionResponse{}, acp.NewMethodNotFound("session/close")
}
func (f *fakeAgent) ListSessions(_ context.Context, _ acp.ListSessionsRequest) (acp.ListSessionsResponse, error) {
	return acp.ListSessionsResponse{}, acp.NewMethodNotFound("session/list")
}
func (f *fakeAgent) ResumeSession(_ context.Context, _ acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	return acp.ResumeSessionResponse{}, acp.NewMethodNotFound("session/resume")
}
func (f *fakeAgent) SetSessionConfigOption(_ context.Context, _ acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	return acp.SetSessionConfigOptionResponse{}, acp.NewMethodNotFound("session/set_config_option")
}
func (f *fakeAgent) SetSessionMode(_ context.Context, p acp.SetSessionModeRequest) (acp.SetSessionModeResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.modeErr != nil {
		return acp.SetSessionModeResponse{}, f.modeErr
	}
	f.lastMode = string(p.ModeId)
	return acp.SetSessionModeResponse{}, nil
}
func (f *fakeAgent) LoadSession(_ context.Context, p acp.LoadSessionRequest) (acp.LoadSessionResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.loadErr != nil {
		return acp.LoadSessionResponse{}, f.loadErr
	}
	f.lastLoad = string(p.SessionId)
	return acp.LoadSessionResponse{}, nil
}
func (f *fakeAgent) UnstableDidChangeDocument(_ context.Context, _ acp.UnstableDidChangeDocumentNotification) error {
	return acp.NewMethodNotFound("text_document/did_change")
}
func (f *fakeAgent) UnstableDidCloseDocument(_ context.Context, _ acp.UnstableDidCloseDocumentNotification) error {
	return acp.NewMethodNotFound("text_document/did_close")
}
func (f *fakeAgent) UnstableDidFocusDocument(_ context.Context, _ acp.UnstableDidFocusDocumentNotification) error {
	return acp.NewMethodNotFound("text_document/did_focus")
}
func (f *fakeAgent) UnstableDidOpenDocument(_ context.Context, _ acp.UnstableDidOpenDocumentNotification) error {
	return acp.NewMethodNotFound("text_document/did_open")
}
func (f *fakeAgent) UnstableDidSaveDocument(_ context.Context, _ acp.UnstableDidSaveDocumentNotification) error {
	return acp.NewMethodNotFound("text_document/did_save")
}
func (f *fakeAgent) UnstableAcceptNes(_ context.Context, _ acp.UnstableAcceptNesNotification) error {
	return acp.NewMethodNotFound("nes/accept")
}
func (f *fakeAgent) UnstableCloseNes(_ context.Context, _ acp.UnstableCloseNesRequest) (acp.UnstableCloseNesResponse, error) {
	return acp.UnstableCloseNesResponse{}, acp.NewMethodNotFound("nes/close")
}
func (f *fakeAgent) UnstableRejectNes(_ context.Context, _ acp.UnstableRejectNesNotification) error {
	return acp.NewMethodNotFound("nes/reject")
}
func (f *fakeAgent) UnstableStartNes(_ context.Context, _ acp.UnstableStartNesRequest) (acp.UnstableStartNesResponse, error) {
	return acp.UnstableStartNesResponse{}, acp.NewMethodNotFound("nes/start")
}
func (f *fakeAgent) UnstableSuggestNes(_ context.Context, _ acp.UnstableSuggestNesRequest) (acp.UnstableSuggestNesResponse, error) {
	return acp.UnstableSuggestNesResponse{}, acp.NewMethodNotFound("nes/suggest")
}
func (f *fakeAgent) UnstableDisableProvider(_ context.Context, _ acp.UnstableDisableProviderRequest) (acp.UnstableDisableProviderResponse, error) {
	return acp.UnstableDisableProviderResponse{}, acp.NewMethodNotFound("providers/disable")
}
func (f *fakeAgent) UnstableListProviders(_ context.Context, _ acp.UnstableListProvidersRequest) (acp.UnstableListProvidersResponse, error) {
	return acp.UnstableListProvidersResponse{}, acp.NewMethodNotFound("providers/list")
}
func (f *fakeAgent) UnstableSetProvider(_ context.Context, _ acp.UnstableSetProviderRequest) (acp.UnstableSetProviderResponse, error) {
	return acp.UnstableSetProviderResponse{}, acp.NewMethodNotFound("providers/set")
}
func (f *fakeAgent) UnstableDeleteSession(_ context.Context, _ acp.UnstableDeleteSessionRequest) (acp.UnstableDeleteSessionResponse, error) {
	return acp.UnstableDeleteSessionResponse{}, acp.NewMethodNotFound("session/delete")
}
func (f *fakeAgent) UnstableForkSession(_ context.Context, _ acp.UnstableForkSessionRequest) (acp.UnstableForkSessionResponse, error) {
	return acp.UnstableForkSessionResponse{}, acp.NewMethodNotFound("session/fork")
}

// startInProcess wires our client handle to a fakeAgent over io.Pipes.
func startInProcess(t *testing.T, fake *fakeAgent, policy PermissionPolicy) *handle {
	t.Helper()
	h, err := startInProcessOpts(t, fake, policy, StartOptions{})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	return h
}

// startInProcessOpts is startInProcess with real session-setup options —
// the in-process proof surface for set_mode and session/load.
func startInProcessOpts(t *testing.T, fake *fakeAgent, policy PermissionPolicy, opts StartOptions) (*handle, error) {
	t.Helper()
	clientToAgentR, clientToAgentW := io.Pipe()
	agentToClientR, agentToClientW := io.Pipe()

	h := &handle{policy: policy, decider: opts.Decider, stderr: newRingBuffer(maxStderrBytes)}
	h.conn = acp.NewClientSideConnection(h, clientToAgentW, agentToClientR)
	h.initLive()

	asc := acp.NewAgentSideConnection(fake, agentToClientW, clientToAgentR)
	fake.bind(asc, agentToClientW)

	t.Cleanup(func() { _ = h.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := h.handshake(ctx, domain.AgentLaunchSpec{WorkDir: t.TempDir(), LauncherID: "claude"}, opts); err != nil {
		return h, err
	}
	return h, nil
}

func textBlock(s string) acp.ContentBlock {
	return acp.ContentBlock{Text: &acp.ContentBlockText{Type: "text", Text: s}}
}

func sessionUpdate(u acp.SessionUpdate) acp.SessionNotification {
	return acp.SessionNotification{SessionId: acp.SessionId(fakeSessionID), Update: u}
}

// sendRaw writes one hand-built JSON-RPC line straight to the agent→client
// pipe. Callers must ensure the SDK agent connection is not writing
// concurrently (e.g. while blocked inside Agent.Prompt).
func (f *fakeAgent) sendRaw(line string) error {
	f.rawMu.Lock()
	defer f.rawMu.Unlock()
	_, err := io.WriteString(f.rawOut, line+"\n")
	return err
}

func TestHandshakeRecordsSession(t *testing.T) {
	fake := newFakeAgent()
	h := startInProcess(t, fake, PermissionDeny)

	if h.SessionID() != fakeSessionID {
		t.Fatalf("SessionID = %q, want %q", h.SessionID(), fakeSessionID)
	}
	if h.ProtocolVersion() != 1 {
		t.Fatalf("ProtocolVersion = %d, want 1", h.ProtocolVersion())
	}
	if !h.LoadSessionSupported() {
		t.Fatal("LoadSessionSupported = false, want true")
	}
	fake.mu.Lock()
	last := fake.lastNew
	fake.mu.Unlock()
	if len(last.AdditionalDirectories) != 0 {
		t.Fatalf("no AdditionalDirs in spec, got %v", last.AdditionalDirectories)
	}
}

func TestHandshakePassesAdditionalDirsWhenAdvertised(t *testing.T) {
	fake := newFakeAgent()
	h := startInProcess(t, fake, PermissionDeny)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.handshake(ctx, domain.AgentLaunchSpec{
		WorkDir:        t.TempDir(),
		AdditionalDirs: []string{"/tmp/cache"},
	}, StartOptions{}); err != nil {
		t.Fatalf("second handshake: %v", err)
	}
	fake.mu.Lock()
	last := fake.lastNew
	fake.mu.Unlock()
	if len(last.AdditionalDirectories) != 1 || last.AdditionalDirectories[0] != "/tmp/cache" {
		t.Fatalf("AdditionalDirectories = %v, want [/tmp/cache]", last.AdditionalDirectories)
	}

	// An agent that does not advertise additionalDirectories must not see them.
	fake2 := newFakeAgent()
	fake2.advertiseAddDirs = false
	fake2.advertiseLoad = false
	h2 := startInProcess(t, fake2, PermissionDeny)
	if h2.LoadSessionSupported() {
		t.Fatal("LoadSessionSupported = true, want false")
	}
	fake2.mu.Lock()
	last2 := fake2.lastNew
	fake2.mu.Unlock()
	if len(last2.AdditionalDirectories) != 0 {
		t.Fatalf("AdditionalDirectories = %v, want none when not advertised", last2.AdditionalDirectories)
	}
}

func TestEventMappingSeqAndUnknown(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = func(ctx context.Context, f *fakeAgent) (acp.PromptResponse, error) {
		send := func(u acp.SessionUpdate) {
			if err := f.conn.SessionUpdate(ctx, sessionUpdate(u)); err != nil {
				t.Errorf("SessionUpdate: %v", err)
			}
		}
		send(acp.SessionUpdate{AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
			SessionUpdate: "agent_message_chunk", Content: textBlock("hello ")}})
		send(acp.SessionUpdate{AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
			SessionUpdate: "agent_message_chunk", Content: textBlock("world")}})
		send(acp.SessionUpdate{AgentThoughtChunk: &acp.SessionUpdateAgentThoughtChunk{
			SessionUpdate: "agent_thought_chunk", Content: textBlock("thinking")}})
		send(acp.SessionUpdate{ToolCall: &acp.SessionUpdateToolCall{
			SessionUpdate: "tool_call", ToolCallId: "t1", Title: "write hello.txt"}})
		send(acp.SessionUpdate{ToolCallUpdate: &acp.SessionToolCallUpdate{
			SessionUpdate: "tool_call_update", ToolCallId: "t1"}})
		send(acp.SessionUpdate{Plan: &acp.SessionUpdatePlan{
			SessionUpdate: "plan",
			Entries:       []acp.PlanEntry{{Content: "step 1", Priority: acp.PlanEntryPriorityMedium, Status: acp.PlanEntryStatusPending}}}})
		// Kinds observed in the raw probe that must survive as opaque.
		send(acp.SessionUpdate{UsageUpdate: &acp.SessionUsageUpdate{
			SessionUpdate: "usage_update", Used: 10, Size: 100}})
		send(acp.SessionUpdate{SessionInfoUpdate: &acp.SessionSessionInfoUpdate{
			SessionUpdate: "session_info_update"}})
		// A discriminator from a future protocol revision, sent exactly as
		// it would appear on the wire (the SDK union marshals only known
		// discriminators, so this uses a raw write).
		if err := f.sendRaw(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"` +
			fakeSessionID + `","update":{"sessionUpdate":"quantum_entanglement_update","qubit":4}}}`); err != nil {
			t.Errorf("sendRaw: %v", err)
		}
		return acp.PromptResponse{StopReason: acp.StopReasonMaxTokens}, nil
	}
	h := startInProcess(t, fake, PermissionDeny)

	got, err := h.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	// Stop-reason mapping is also exercised here: max_tokens → StopMaxTokens.
	if got != domain.StopMaxTokens {
		t.Fatalf("stop reason = %q, want %q", got, domain.StopMaxTokens)
	}

	events := drainSome(t, h, 9)
	if len(events) != 9 {
		t.Fatalf("got %d events, want 9: %+v", len(events), events)
	}
	wantKinds := []string{
		"message_chunk", "message_chunk", "thought_chunk", "tool_call",
		"tool_call_update", "plan", "unknown", "unknown", "unknown",
	}
	for i, ev := range events {
		if ev.Kind != wantKinds[i] {
			t.Errorf("event %d: kind = %q, want %q", i, ev.Kind, wantKinds[i])
		}
		if ev.Seq != int64(i+1) {
			t.Errorf("event %d: seq = %d, want %d", i, ev.Seq, i+1)
		}
		if ev.At.IsZero() {
			t.Errorf("event %d: At is zero", i)
		}
	}
	if events[0].Text != "hello " || events[1].Text != "world" {
		t.Errorf("chunk text not propagated: %q %q", events[0].Text, events[1].Text)
	}
	if events[3].ToolCallID != "t1" || events[3].Text != "write hello.txt" {
		t.Errorf("tool_call fields: %+v", events[3])
	}
	if events[4].ToolCallID != "t1" {
		t.Errorf("tool_call_update id: %+v", events[4])
	}
}

func TestMapStopReason(t *testing.T) {
	cases := map[acp.StopReason]domain.StopReason{
		acp.StopReasonEndTurn:   domain.StopEndTurn,
		acp.StopReasonCancelled: domain.StopCancelled,
		acp.StopReasonMaxTokens: domain.StopMaxTokens,
		acp.StopReasonRefusal:   domain.StopRefusal,
		"something_new":         domain.StopOther,
		"":                      domain.StopOther,
	}
	for in, want := range cases {
		if got := mapStopReason(in); got != want {
			t.Errorf("mapStopReason(%q) = %q, want %q", in, got, want)
		}
	}
}

func permissionOptions() []acp.PermissionOption {
	return []acp.PermissionOption{
		{OptionId: "aa", Kind: acp.PermissionOptionKindAllowAlways, Name: "Always allow"},
		{OptionId: "ro", Kind: acp.PermissionOptionKindRejectOnce, Name: "Reject once"},
		{OptionId: "ao", Kind: acp.PermissionOptionKindAllowOnce, Name: "Allow once"},
		{OptionId: "ra", Kind: acp.PermissionOptionKindRejectAlways, Name: "Reject always"},
	}
}

func promptRequestsPermission(options []acp.PermissionOption) func(context.Context, *fakeAgent) (acp.PromptResponse, error) {
	return func(ctx context.Context, f *fakeAgent) (acp.PromptResponse, error) {
		resp, err := f.conn.RequestPermission(ctx, acp.RequestPermissionRequest{
			SessionId: acp.SessionId(fakeSessionID),
			ToolCall:  acp.ToolCallUpdate{ToolCallId: "tperm", Title: ptr("edit file")},
			Options:   options,
		})
		if err != nil {
			return acp.PromptResponse{}, err
		}
		f.recordPermission(resp)
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
	}
}

func ptr(s string) *string { return &s }

func TestPermissionDenySelectsRejectOnce(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission(permissionOptions())
	h := startInProcess(t, fake, PermissionDeny)
	runPromptAndCheckPermission(t, h, fake, "ro", true)
}

func TestPermissionDenyFallsBackToRejectAlways(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission([]acp.PermissionOption{
		{OptionId: "ao", Kind: acp.PermissionOptionKindAllowOnce},
		{OptionId: "ra", Kind: acp.PermissionOptionKindRejectAlways},
	})
	h := startInProcess(t, fake, PermissionDeny)
	runPromptAndCheckPermission(t, h, fake, "ra", true)
}

func TestPermissionDenyWithoutRejectCancels(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission([]acp.PermissionOption{
		{OptionId: "ao", Kind: acp.PermissionOptionKindAllowOnce},
		{OptionId: "aa", Kind: acp.PermissionOptionKindAllowAlways},
	})
	h := startInProcess(t, fake, PermissionDeny)
	runPromptAndCheckPermission(t, h, fake, "", false)
}

func TestPermissionPreapprovedSelectsAllowOnce(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission(permissionOptions())
	h := startInProcess(t, fake, PermissionPreapproved)
	runPromptAndCheckPermission(t, h, fake, "ao", true)
}

func TestPermissionPreapprovedFallsBackToAllowAlways(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission([]acp.PermissionOption{
		{OptionId: "ra", Kind: acp.PermissionOptionKindRejectAlways},
		{OptionId: "aa", Kind: acp.PermissionOptionKindAllowAlways},
	})
	h := startInProcess(t, fake, PermissionPreapproved)
	runPromptAndCheckPermission(t, h, fake, "aa", true)
}

func TestPermissionAskBehavesAsDeny(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission(permissionOptions())
	h := startInProcess(t, fake, PermissionAsk)
	runPromptAndCheckPermission(t, h, fake, "ro", true)
}

func runPromptAndCheckPermission(t *testing.T, h *handle, fake *fakeAgent, wantOption string, wantSelected bool) {
	t.Helper()
	reason, err := h.Prompt(context.Background(), "do it")
	if err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if reason != domain.StopEndTurn {
		t.Fatalf("stop reason = %q, want end_turn", reason)
	}
	recs := fake.recordedPermissions()
	if len(recs) != 1 {
		t.Fatalf("recorded %d permission responses, want 1", len(recs))
	}
	out := recs[0].Outcome
	if wantSelected {
		if out.Selected == nil || string(out.Selected.OptionId) != wantOption {
			t.Fatalf("outcome = %+v, want selected %q", out, wantOption)
		}
	} else {
		if out.Cancelled == nil {
			t.Fatalf("outcome = %+v, want cancelled", out)
		}
	}
	// Every permission request must also surface as a permission_request event.
	ev := drainSome(t, h, 1)
	if len(ev) == 0 || ev[0].Kind != "permission_request" || ev[0].ToolCallID != "tperm" {
		t.Fatalf("permission_request event missing: %+v", ev)
	}
}

func drainSome(t *testing.T, h *handle, n int) []domain.ConversationEvent {
	t.Helper()
	var out []domain.ConversationEvent
	for len(out) < n {
		select {
		case ev, ok := <-h.Events():
			if !ok {
				return out
			}
			out = append(out, ev)
		case <-time.After(5 * time.Second):
			return out
		}
	}
	return out
}

func TestCancelDuringPendingPermissionYieldsCancelled(t *testing.T) {
	fake := newFakeAgent()
	// promptStarted closes once the agent has received session/prompt, i.e.
	// the client-side Prompt has already cleared turnCancelled. Cancelling
	// before that point races the reset and is not what this test means.
	promptStarted := make(chan struct{})
	fake.promptFn = func(ctx context.Context, f *fakeAgent) (acp.PromptResponse, error) {
		close(promptStarted)
		// Only ask once the client has already cancelled this turn: the
		// client MUST answer with the cancelled outcome.
		<-f.cancelled
		// Deliberately not the prompt ctx: the SDK's AgentSideConnection
		// cancels the in-flight prompt ctx when session/cancel arrives, so
		// issuing the follow-up request on it would abort locally with
		// -32800 before ever reaching the client. Real adapters (e.g.
		// claude-agent-acp) keep the request on the wire and await the
		// client's answer; this models that, exercising the client's
		// must-answer-cancelled obligation.
		resp, err := f.conn.RequestPermission(context.Background(), acp.RequestPermissionRequest{
			SessionId: acp.SessionId(fakeSessionID),
			ToolCall:  acp.ToolCallUpdate{ToolCallId: "tcancel", Title: ptr("sleep 60")},
			Options:   permissionOptions(),
		})
		if err != nil {
			return acp.PromptResponse{}, err
		}
		f.recordPermission(resp)
		return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
	}
	h := startInProcess(t, fake, PermissionPreapproved)

	done := make(chan domain.StopReason, 1)
	go func() {
		r, err := h.Prompt(context.Background(), "run sleep 60")
		if err != nil {
			t.Errorf("Prompt: %v", err)
		}
		done <- r
	}()

	select {
	case <-promptStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("agent never entered prompt")
	}
	if err := h.Cancel(context.Background()); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case r := <-done:
		if r != domain.StopCancelled {
			t.Fatalf("stop reason = %q, want cancelled", r)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("prompt did not finish after cancel")
	}
	recs := fake.recordedPermissions()
	if len(recs) != 1 || recs[0].Outcome.Cancelled == nil {
		t.Fatalf("permission outcome not cancelled: %+v", recs)
	}
}

// TestCancelMidTurnReachesABusyAgent is the ACP half of ADR-0016 § 5's takeover:
// a harness deep inside session/prompt must actually RECEIVE session/cancel on
// the wire, and the client must read the cancelled stop reason it answers with.
// The fake holds the prompt open until the notification arrives, so a cancel
// that only cancels the client-side context fails here.
func TestCancelMidTurnReachesABusyAgent(t *testing.T) {
	fake := newFakeAgent()
	promptStarted := make(chan struct{})
	fake.promptFn = func(_ context.Context, f *fakeAgent) (acp.PromptResponse, error) {
		close(promptStarted)
		select {
		case <-f.cancelled: // the agent is busy until session/cancel lands
			return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
		case <-time.After(10 * time.Second):
			return acp.PromptResponse{}, errors.New("fake: session/cancel never reached the agent")
		}
	}
	h := startInProcess(t, fake, PermissionPreapproved)

	done := make(chan domain.StopReason, 1)
	go func() {
		r, err := h.Prompt(context.Background(), "edit the whole repository")
		if err != nil {
			t.Errorf("Prompt: %v", err)
		}
		done <- r
	}()

	select {
	case <-promptStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("agent never entered prompt")
	}
	started := time.Now()
	if err := h.Cancel(context.Background()); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case r := <-done:
		if r != domain.StopCancelled {
			t.Fatalf("stop reason = %q, want cancelled", r)
		}
		if elapsed := time.Since(started); elapsed > 10*time.Second {
			t.Fatalf("cancel took %s to reach a busy agent; the takeover may not wait out a turn", elapsed)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("busy prompt did not end after session/cancel")
	}
	select {
	case <-fake.cancelled:
	default:
		t.Fatal("the agent never observed session/cancel")
	}
}

func TestUnsupportedAgentRequestsGetMethodNotFound(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = func(ctx context.Context, f *fakeAgent) (acp.PromptResponse, error) {
		f.mu.Lock()
		_, err := f.conn.ReadTextFile(ctx, acp.ReadTextFileRequest{SessionId: acp.SessionId(fakeSessionID), Path: "/etc/passwd"})
		f.extErrs = append(f.extErrs, err)
		_, err = f.conn.CreateTerminal(ctx, acp.CreateTerminalRequest{SessionId: acp.SessionId(fakeSessionID), Command: "echo"})
		f.extErrs = append(f.extErrs, err)
		_, err = f.conn.CallExtension(ctx, "_acme/unknown", map[string]any{})
		f.extErrs = append(f.extErrs, err)
		f.mu.Unlock()
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
	}
	h := startInProcess(t, fake, PermissionDeny)
	if _, err := h.Prompt(context.Background(), "try fs"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.extErrs) != 3 {
		t.Fatalf("expected 3 agent-side errors, got %d", len(fake.extErrs))
	}
	for i, err := range fake.extErrs {
		var re *acp.RequestError
		if !errors.As(err, &re) || re.Code != -32601 {
			t.Fatalf("error %d = %v, want JSON-RPC method-not-found", i, err)
		}
	}
}

func TestCloseIdempotent(t *testing.T) {
	fake := newFakeAgent()
	h := startInProcess(t, fake, PermissionDeny)
	if err := h.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := h.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, ok := <-h.Events(); ok {
		t.Fatal("events channel not closed after Close")
	}
	// Cleanup Close must also be safe.
	if err := h.Close(); err != nil {
		t.Fatalf("third Close: %v", err)
	}
}

func TestSubprocessLifecycleStderrAndClose(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	rt := &Runtime{PermissionPolicy: PermissionDeny}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h, err := rt.Start(ctx, domain.AgentLaunchSpec{
		Executable: exe,
		Env:        append(os.Environ(), fakeEnvMarker+"=1"),
		WorkDir:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	hh := h.(*handle)
	if hh.SessionID() != fakeSessionID {
		t.Fatalf("session = %q", hh.SessionID())
	}
	// Let the helper's stderr line arrive.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(hh.Stderr(), "fake-agent stderr noise") {
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(hh.Stderr(), "fake-agent stderr noise") {
		t.Fatalf("stderr capture missing marker, got %q", hh.Stderr())
	}
	if err := hh.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := hh.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	select {
	case <-hh.exited:
	case <-time.After(15 * time.Second):
		t.Fatal("subprocess not reaped after Close")
	}
}

func TestRingBufferKeepsLastBytes(t *testing.T) {
	rb := newRingBuffer(8)
	fmt.Fprint(rb, "0123456789abcdef")
	if got := rb.String(); got != "89abcdef" {
		t.Fatalf("ring buffer = %q, want %q", got, "89abcdef")
	}
}

// runFakeAgentProcess serves the ACP agent side over stdio for the
// subprocess test, mirroring the in-process fake.
func runFakeAgentProcess() {
	fmt.Fprintln(os.Stderr, "fake-agent stderr noise")
	ag := newFakeAgent()
	if os.Getenv(fakeDieMidTurnEnv) == "1" {
		ag.promptFn = func(ctx context.Context, f *fakeAgent) (acp.PromptResponse, error) {
			send := func(u acp.SessionUpdate) { _ = f.conn.SessionUpdate(ctx, sessionUpdate(u)) }
			send(acp.SessionUpdate{AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
				SessionUpdate: "agent_message_chunk", Content: textBlock("working on it")}})
			send(acp.SessionUpdate{ToolCall: &acp.SessionUpdateToolCall{
				SessionUpdate: "tool_call", ToolCallId: "t1", Title: "edit hello.py"}})
			// The CLI's own last words, printed as the newest stderr so the
			// tail the client reads names the death even behind whatever
			// noise (a race dump) the test child emits earlier.
			fmt.Fprintln(os.Stderr, "die-mid-turn: upstream model gateway returned 502, exiting")
			// No answer after the tool call: the process is gone.
			os.Exit(7)
			return acp.PromptResponse{}, nil
		}
	}
	asc := acp.NewAgentSideConnection(ag, os.Stdout, os.Stdin)
	ag.bind(asc, os.Stdout)
	<-asc.Done()
}
