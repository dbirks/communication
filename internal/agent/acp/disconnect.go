package acp

import (
	"context"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/dbirks/communication/internal/domain"
)

// Disconnect reasons name why a session's transport went away. They share
// the machine-readable vocabulary of agent.session.disconnected's `reason`
// (ADR-0016 § 5, contract § 9): a cause, never prose.
const (
	// DisconnectReasonProcessExited: the harness process died with a turn in
	// flight (observed cmd.Wait, or the SDK's own read error).
	DisconnectReasonProcessExited = "agent_process_exited"
	// DisconnectReasonConnectionClosed: the stdio connection closed while a
	// turn was in flight but the process had not been reaped yet.
	DisconnectReasonConnectionClosed = "acp_connection_closed"
)

// DisconnectInfo records one transport death and when it was seen. Detail is
// the observed evidence (exit error, SDK message); it is bounded by the
// caller that prints it, never here.
type DisconnectInfo struct {
	Reason string
	Detail string
}

// DisconnectedError is returned by Prompt when the session's transport died
// before the turn ended. It is a transport fact, not an agent verdict: the
// turn never completed, so there is no reply for a schema to judge
// (ADR-0023 § 7 reserves invalid_output for a reply that fails its schema).
type DisconnectedError struct {
	Info DisconnectInfo
	// Err is the underlying transport/protocol error, when one surfaced.
	Err error
}

func (e *DisconnectedError) Error() string {
	if e == nil {
		return "<nil>"
	}
	msg := "acp: session disconnected before the turn ended (" + e.Info.Reason + ")"
	if d := strings.TrimSpace(e.Info.Detail); d != "" {
		msg += ": " + d
	}
	return msg
}

// Unwrap keeps the SDK error on the chain for errors.Is/As callers.
func (e *DisconnectedError) Unwrap() error { return e.Err }

// DisconnectInfoOf reads the disconnect facts an error carries.
func DisconnectInfoOf(err error) (DisconnectInfo, bool) {
	var d *DisconnectedError
	if errors.As(err, &d) && d != nil && d.Info.Reason != "" {
		return d.Info, true
	}
	return DisconnectInfo{}, false
}

// DisconnectReporter is the optional second question a session answers after
// a turn: did the transport go away *while the turn was in flight*? A
// harness that finishes its answer and then exits is the normal case and
// reports nothing; a harness that dies mid-turn reports the death, and the
// caller must not read the silence that follows as an agent answer.
type DisconnectReporter interface {
	Disconnect() (DisconnectInfo, bool)
}

// StderrObserver is the optional third question a session answers after a
// turn: what did the harness write to its stderr? The transport records only
// *that* a process died; a CLI killed by a model-gateway 5xx usually says so
// on stderr first, and the ledger is the only place the next reader of a
// failed attempt will look. A live ACP handle keeps a bounded ring of the
// process's stderr; a session that cannot answer reports the honest nothing.
type StderrObserver interface {
	Stderr() string
}

var (
	_ DisconnectReporter = (*handle)(nil)
	_ StderrObserver     = (*handle)(nil)
	_ error              = (*DisconnectedError)(nil)
)

// StderrTail reads the session's last stderr, keeping the TAIL bounded to
// maxBytes (cut on a rune boundary): the newest words are the ones that name
// the death. A session that cannot answer (a test double, a non-ACP adapter)
// reports "" — no observation, no claim.
func StderrTail(sess domain.AgentSession, maxBytes int) string {
	o, ok := sess.(StderrObserver)
	if !ok {
		return ""
	}
	s := strings.TrimSpace(o.Stderr())
	if s == "" {
		return ""
	}
	if maxBytes > 0 && len(s) > maxBytes {
		s = s[len(s)-maxBytes:]
		for i := 0; i < utf8.UTFMax && len(s) > 0 && !utf8.RuneStart(s[0]); i++ {
			s = s[1:]
		}
	}
	return s
}

// SessionDisconnect asks a live session for its mid-turn disconnect. A
// session that cannot answer (a test double, a non-ACP adapter) reports
// nothing, which is the honest absence: no observation, no claim.
func SessionDisconnect(sess domain.AgentSession) (DisconnectInfo, bool) {
	r, ok := sess.(DisconnectReporter)
	if !ok {
		return DisconnectInfo{}, false
	}
	info, dead := r.Disconnect()
	if !dead || info.Reason == "" {
		return DisconnectInfo{}, false
	}
	return info, true
}

// transportDeathSignatures are the substrings the ACP SDK and the OS put on
// a closed stdio connection. The SDK answers an in-flight request with
// {"code":-32603,...,"error":"peer disconnected before response"} when its
// receive loop ends (connection.go waitForResponse), which is what a dying
// harness looks like from the client side.
var transportDeathSignatures = []string{
	"peer disconnected",
	"peer connection closed",
	"connection closed",
	"broken pipe",
	"process exited",
	"signal: killed",
	"exit status",
}

// disconnectFromError classifies a prompt error as a transport death. A
// cancellation is NOT one: the attempt loop owns those arms and names the
// terminal itself (deadline, cancel-requested, drain), so an error whose
// cause is the caller's context keeps travelling unclassified.
func disconnectFromError(err error) (DisconnectInfo, bool) {
	if err == nil {
		return DisconnectInfo{}, false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return DisconnectInfo{}, false
	}
	closed := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, io.ErrClosedPipe)
	msg := strings.ToLower(err.Error())
	if !closed {
		for _, sig := range transportDeathSignatures {
			if strings.Contains(msg, sig) {
				closed = true
				break
			}
		}
	}
	if !closed {
		return DisconnectInfo{}, false
	}
	reason := DisconnectReasonConnectionClosed
	if strings.Contains(msg, "process exited") || strings.Contains(msg, "signal") ||
		strings.Contains(msg, "exit status") {
		reason = DisconnectReasonProcessExited
	}
	return DisconnectInfo{Reason: reason, Detail: err.Error()}, true
}
