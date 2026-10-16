package acp

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/dbirks/communication/internal/domain"
)

// startFakeSubprocess launches this test binary as a stdio ACP agent.
func startFakeSubprocess(t *testing.T, extraEnv ...string) domain.AgentSession {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	rt := &Runtime{PermissionPolicy: PermissionDeny}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	sess, err := rt.StartWithOptions(ctx, domain.AgentLaunchSpec{
		Executable: exe,
		Env:        append(os.Environ(), append([]string{fakeEnvMarker + "=1"}, extraEnv...)...),
		WorkDir:    t.TempDir(),
	}, StartOptions{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = sess.Close() })
	return sess
}

// TestPromptDiesMidTurnIsDisconnect is the real-protocol leg: a harness
// process that dies with a turn in flight is reported as a disconnect, never
// as an answer. The child streams a chunk, opens a tool call, and exits 7 —
// the live15 C2 sequence — over a real stdio pipe.
func TestPromptDiesMidTurnIsDisconnect(t *testing.T) {
	sess := startFakeSubprocess(t, fakeDieMidTurnEnv+"=1")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stop, err := sess.Prompt(ctx, "fix hello.py")
	if err == nil {
		t.Fatalf("Prompt returned stop=%q with no error; a dead harness must not look like an answer", stop)
	}
	var d *DisconnectedError
	if !errors.As(err, &d) {
		t.Fatalf("Prompt error = %v, want *DisconnectedError", err)
	}
	if d.Info.Reason != DisconnectReasonProcessExited {
		t.Errorf("disconnect reason = %q, want %q", d.Info.Reason, DisconnectReasonProcessExited)
	}
	if info, ok := sess.(DisconnectReporter); !ok {
		t.Fatal("handle does not implement DisconnectReporter")
	} else if got, ok := info.Disconnect(); !ok || got.Reason != DisconnectReasonProcessExited {
		t.Errorf("Disconnect() = %+v,%v, want the process-exit record", got, ok)
	}
	if d.Err == nil {
		t.Errorf("want the underlying SDK error retained, got %+v", d)
	}
}

// TestPromptEndThenExitIsNotDisconnect: the ordinary case. The harness answers
// and only then goes away — its exit is the protocol closing, not a mid-turn
// death, and the turn keeps its meaning.
func TestPromptEndThenExitIsNotDisconnect(t *testing.T) {
	sess := startFakeSubprocess(t)
	hh := sess.(*handle)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stop, err := hh.Prompt(ctx, "say hello")
	if err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if stop != domain.StopEndTurn {
		t.Fatalf("stop = %q, want end_turn", stop)
	}
	if err := hh.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	<-hh.exited
	if info, ok := hh.Disconnect(); ok {
		t.Errorf("Disconnect() after a completed turn = %+v, want nothing", info)
	}
}

// TestDisconnectRecordOnlyWithinTheTurnWindow pins the window: a death is
// recorded for the turn in flight, stays readable after it ends (the caller
// asks after Prompt), and is dropped when the next turn begins.
func TestDisconnectRecordOnlyWithinTheTurnWindow(t *testing.T) {
	h := startInProcess(t, newFakeAgent(), PermissionDeny)

	h.endTurn()
	h.recordDisconnect(DisconnectInfo{Reason: DisconnectReasonConnectionClosed})
	if info, ok := h.Disconnect(); ok {
		t.Fatalf("a death outside a turn was recorded: %+v", info)
	}

	h.beginTurn()
	if _, ok := h.Disconnect(); ok {
		t.Fatal("beginTurn did not clear the earlier record")
	}
	h.recordDisconnect(DisconnectInfo{Reason: DisconnectReasonProcessExited, Detail: "signal: killed"})
	h.recordDisconnect(DisconnectInfo{Reason: DisconnectReasonConnectionClosed})
	info, ok := h.Disconnect()
	if !ok || info.Reason != DisconnectReasonProcessExited {
		t.Fatalf("Disconnect() = %+v,%v, want the first record of the turn", info, ok)
	}
	h.endTurn()
	if info, ok := h.Disconnect(); !ok || info.Reason != DisconnectReasonProcessExited {
		t.Errorf("record must stay readable after the turn so the caller can ask post-Prompt, got %+v,%v", info, ok)
	}
}

func TestDisconnectFromError(t *testing.T) {
	peerGone := acp.NewInternalError(map[string]any{"error": "peer disconnected before response"})
	cases := []struct {
		name       string
		err        error
		wantReason string
	}{
		{"sdk peer disconnected mid-request", peerGone, DisconnectReasonConnectionClosed},
		{"sdk notification wait lost", acp.NewInternalError(map[string]any{"error": "peer disconnected while waiting for pre-response notifications"}), DisconnectReasonConnectionClosed},
		{"read side eof", io.ErrUnexpectedEOF, DisconnectReasonConnectionClosed},
		{"reaped process", errors.New("acp: adapter process exited with signal 9"), DisconnectReasonProcessExited},
		{"killed", errors.New("exit status 137"), DisconnectReasonProcessExited},
		{"agent-side refusal is not a transport death", errors.New("agent overloaded, try later"), ""},
		{"caller cancel is the loop's own arm", context.Canceled, ""},
		{"deadline is a timeout, not a disconnect", context.DeadlineExceeded, ""},
		{"wrapped cancel stays unclassified", &requestErrShim{err: context.Canceled}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info, ok := disconnectFromError(tc.err)
			if tc.wantReason == "" {
				if ok {
					t.Fatalf("classified %+v as a disconnect", tc.err)
				}
				return
			}
			if !ok {
				t.Fatalf("missed the disconnect in %v", tc.err)
			}
			if info.Reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", info.Reason, tc.wantReason)
			}
			if info.Detail == "" {
				t.Error("detail must carry the observed evidence")
			}
		})
	}

	if _, ok := disconnectFromError(nil); ok {
		t.Error("nil classified as a disconnect")
	}
	wrapped := &requestErrShim{err: peerGone}
	if info, ok := disconnectFromError(wrapped); !ok || info.Reason != DisconnectReasonConnectionClosed {
		t.Errorf("wrapped peer-gone = %+v,%v, want it recognised through Unwrap", info, ok)
	}
	if info, ok := DisconnectInfoOf(&DisconnectedError{Info: DisconnectInfo{Reason: DisconnectReasonProcessExited}, Err: peerGone}); !ok || info.Reason != DisconnectReasonProcessExited {
		t.Errorf("DisconnectInfoOf = %+v,%v, want the carried reason", info, ok)
	}
	if _, ok := DisconnectInfoOf(errors.New("plain")); ok {
		t.Error("DisconnectInfoOf invented a disconnect")
	}
}

// requestErrShim is an arbitrary wrapper: classification must see through it.
type requestErrShim struct{ err error }

func (s *requestErrShim) Error() string { return "wrapped: " + s.err.Error() }
func (s *requestErrShim) Unwrap() error { return s.err }
