package acp

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/dbirks/communication/internal/domain"
)

// TestHandshakeAppliesAskMode proves the session switches into the prompting
// mode requested by an ask profile (docs/compatibility/ACP.md: prompting is
// a mode property, so the worker must select it).
func TestHandshakeAppliesAskMode(t *testing.T) {
	fake := newFakeAgent()
	h, err := startInProcessOpts(t, fake, PermissionAsk, StartOptions{ModeID: "default", LauncherVersion: "0.90.0"})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	fake.mu.Lock()
	mode := fake.lastMode
	fake.mu.Unlock()
	if mode != "default" {
		t.Fatalf("agent saw mode %q, want %q", mode, "default")
	}
	info := h.Info()
	if info.ModeID != "default" || info.LauncherVersion != "0.90.0" || info.Origin != "new" {
		t.Errorf("Info = %+v, want mode recorded on a new session", info)
	}
	if info.ProtocolVersion != 1 {
		t.Errorf("ProtocolVersion = %d, want 1", info.ProtocolVersion)
	}
	if len(info.AgentCapabilities) == 0 {
		t.Error("AgentCapabilities empty; the binding row would record nothing observed")
	}
}

// TestHandshakeModeFailureFailsClosed: when the adapter refuses the asking
// mode, the handshake must fail — running the auto-approving default under
// an ask policy would be a silent lie.
func TestHandshakeModeFailureFailsClosed(t *testing.T) {
	fake := newFakeAgent()
	fake.modeErr = acp.NewMethodNotFound("session/set_mode")
	_, err := startInProcessOpts(t, fake, PermissionAsk, StartOptions{ModeID: "default"})
	if err == nil || !strings.Contains(err.Error(), "session/set_mode") {
		t.Fatalf("handshake error = %v, want the set_mode failure surfaced", err)
	}
}

// TestHandshakeResumeUsesLoad: with loadSession advertised and a session id
// to restore, the handshake calls session/load and records origin resumed.
func TestHandshakeResumeUsesLoad(t *testing.T) {
	fake := newFakeAgent() // advertises loadSession by default
	h, err := startInProcessOpts(t, fake, PermissionDeny, StartOptions{LoadSessionID: "prev-session"})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	fake.mu.Lock()
	loaded := fake.lastLoad
	fake.mu.Unlock()
	if loaded != "prev-session" {
		t.Fatalf("session/load carried %q, want the previous id", loaded)
	}
	if h.SessionID() != "prev-session" || h.Info().Origin != "resumed" {
		t.Errorf("session = %q origin %q, want the resumed id", h.SessionID(), h.Info().Origin)
	}
}

// TestHandshakeLoadFailureRecordsNew: a failed resume becomes a visible new
// session — never a silent claim of restoration (ADR-0016 §6).
func TestHandshakeLoadFailureRecordsNew(t *testing.T) {
	fake := newFakeAgent()
	fake.loadErr = errors.New("no such session")
	h, err := startInProcessOpts(t, fake, PermissionDeny, StartOptions{LoadSessionID: "gone-session"})
	if err != nil {
		t.Fatalf("handshake after failed load: %v", err)
	}
	if h.SessionID() != fakeSessionID {
		t.Errorf("SessionID = %q, want the fresh session/new id", h.SessionID())
	}
	if got := h.Info().Origin; got != "new" {
		t.Errorf("Origin = %q, want new after a failed resume", got)
	}
}

// TestHandshakeLoadNotAdvertisedSkipsLoad: an agent that never advertised
// loadSession is asked for session/new only.
func TestHandshakeLoadNotAdvertisedSkipsLoad(t *testing.T) {
	fake := newFakeAgent()
	fake.advertiseLoad = false
	h, err := startInProcessOpts(t, fake, PermissionDeny, StartOptions{LoadSessionID: "prev"})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	fake.mu.Lock()
	loaded := fake.lastLoad
	fake.mu.Unlock()
	if loaded != "" {
		t.Errorf("session/load was called (%q) without the capability", loaded)
	}
	if h.Info().Origin != "new" {
		t.Errorf("Origin = %q, want new", h.Info().Origin)
	}
}

func permissionPromptOptions() []acp.PermissionOption {
	return []acp.PermissionOption{
		{OptionId: "allow-once", Kind: acp.PermissionOptionKindAllowOnce, Name: "Yes"},
		{OptionId: "allow-all", Kind: acp.PermissionOptionKindAllowAlways, Name: "Yes, all session"},
		{OptionId: "reject", Kind: acp.PermissionOptionKindRejectOnce, Name: "No"},
	}
}

// bareHandle is a live, handshaked-enough handle for permission tests: the
// RequestPermission path needs initLive state, not a protocol peer.
func bareHandle(decider domain.PermissionDecider) *handle {
	h := &handle{policy: PermissionDeny, decider: decider, stderr: newRingBuffer(maxStderrBytes)}
	h.initLive()
	return h
}

func permissionRequest() acp.RequestPermissionRequest {
	return acp.RequestPermissionRequest{
		SessionId: acp.SessionId(fakeSessionID),
		ToolCall:  acp.ToolCallUpdate{ToolCallId: "tperm", Title: ptr("Write allowed.txt")},
		Options:   permissionPromptOptions(),
	}
}

// TestDeciderAnswersWithControllerChoice: the callback's option id — the one
// the conversation controller picked durably — is echoed verbatim when the
// agent offered it, and the prompt arrives normalized for the bridge.
func TestDeciderAnswersWithControllerChoice(t *testing.T) {
	var got domain.PermissionPrompt
	h := bareHandle(func(_ context.Context, p domain.PermissionPrompt) (domain.PermissionChoice, error) {
		got = p
		return domain.PermissionChoice{OptionID: "allow-once"}, nil
	})
	resp, err := h.RequestPermission(context.Background(), permissionRequest())
	if err != nil {
		t.Fatalf("RequestPermission: %v", err)
	}
	if resp.Outcome.Selected == nil || string(resp.Outcome.Selected.OptionId) != "allow-once" {
		t.Fatalf("outcome = %+v, want selected allow-once", resp.Outcome)
	}
	if got.Title != "Write allowed.txt" || got.ToolCallID != "tperm" || len(got.Options) != 3 {
		t.Fatalf("normalized prompt = %+v", got)
	}
	if got.Options[0].Label != "Yes" || got.Options[2].Kind != string(acp.PermissionOptionKindRejectOnce) {
		t.Errorf("options normalized wrong: %+v", got.Options)
	}
}

// TestDeciderRejectOptionIsHonouredVerbatim guards the Codex quirk: its
// reject option is literally id "cancel" with kind reject_once — clients
// must key on kind for policy and echo the id back verbatim.
func TestDeciderRejectOptionIsHonouredVerbatim(t *testing.T) {
	h := bareHandle(func(context.Context, domain.PermissionPrompt) (domain.PermissionChoice, error) {
		return domain.PermissionChoice{OptionID: "cancel"}, nil
	})
	resp, err := h.RequestPermission(context.Background(), acp.RequestPermissionRequest{
		SessionId: acp.SessionId(fakeSessionID),
		ToolCall:  acp.ToolCallUpdate{ToolCallId: "tperm", Title: ptr("Edit files")},
		Options:   []acp.PermissionOption{{OptionId: "cancel", Kind: acp.PermissionOptionKindRejectOnce, Name: "No"}},
	})
	if err != nil {
		t.Fatalf("RequestPermission: %v", err)
	}
	if resp.Outcome.Selected == nil || string(resp.Outcome.Selected.OptionId) != "cancel" {
		t.Fatalf("outcome = %+v, want the offered reject id echoed", resp.Outcome)
	}
}

// TestDeciderFabricatedOptionCancels: an answer naming an option the agent
// never offered resolves to the protocol cancelled outcome.
func TestDeciderFabricatedOptionCancels(t *testing.T) {
	h := bareHandle(func(context.Context, domain.PermissionPrompt) (domain.PermissionChoice, error) {
		return domain.PermissionChoice{OptionID: "yes-everything"}, nil
	})
	resp, err := h.RequestPermission(context.Background(), permissionRequest())
	if err != nil {
		t.Fatalf("RequestPermission: %v", err)
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("outcome = %+v, want cancelled", resp.Outcome)
	}
}

// TestDeciderErrorCancels: a bridge that cannot answer (database gone) must
// answer cancelled, not hang the agent or invent consent.
func TestDeciderErrorCancels(t *testing.T) {
	h := bareHandle(func(context.Context, domain.PermissionPrompt) (domain.PermissionChoice, error) {
		return domain.PermissionChoice{}, errors.New("store down")
	})
	resp, err := h.RequestPermission(context.Background(), permissionRequest())
	if err != nil {
		t.Fatalf("RequestPermission: %v", err)
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("outcome = %+v, want cancelled", resp.Outcome)
	}
}

// TestDeciderCancelledTurnUnblocks: turn cancellation while a human decision
// is pending must unblock the decider (its context ends) and answer the
// agent with the cancelled outcome, never a late "selected".
func TestDeciderCancelledTurnUnblocks(t *testing.T) {
	started := make(chan struct{})
	h := bareHandle(func(ctx context.Context, _ domain.PermissionPrompt) (domain.PermissionChoice, error) {
		close(started)
		<-ctx.Done()
		return domain.PermissionChoice{}, ctx.Err()
	})
	done := make(chan acp.RequestPermissionResponse, 1)
	go func() {
		resp, err := h.RequestPermission(context.Background(), permissionRequest())
		if err != nil {
			t.Errorf("RequestPermission: %v", err)
		}
		done <- resp
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("decider never started")
	}

	// Exactly what Cancel does before writing session/cancel on the wire.
	h.markTurnCancelled()

	select {
	case resp := <-done:
		if resp.Outcome.Cancelled == nil {
			t.Fatalf("outcome = %+v, want cancelled", resp.Outcome)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pending permission survived the turn cancel")
	}
}

// TestPromptClearsTurnCancelled: the cancel flag is per-turn — the next
// prompt on the same live session must be able to ask again.
func TestPromptClearsTurnCancelled(t *testing.T) {
	fake := newFakeAgent()
	fake.promptFn = promptRequestsPermission(permissionOptions())
	h := startInProcess(t, fake, PermissionDeny)
	h.markTurnCancelled()

	if _, err := h.Prompt(context.Background(), "go"); err != nil {
		t.Fatalf("Prompt after a previous cancel: %v", err)
	}
	recs := fake.recordedPermissions()
	if len(recs) != 1 || recs[0].Outcome.Selected == nil {
		t.Fatalf("recorded = %+v, want a fresh selected answer on the new turn", recs)
	}
}
