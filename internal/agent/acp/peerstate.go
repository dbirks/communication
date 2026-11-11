package acp

import (
	"github.com/dbirks/communication/internal/domain"
)

// PeerStateReporter is the question a live session answers before it is
// ridden into a NEW turn: is the transport still there? A harness that
// finishes its turn and then exits is common (the lab's pi-acp exits after
// every answer); the live-session maps keep the instance across turns, and
// a session whose process is gone must be retired — honestly, with its
// binding closed and the conversation moved to idle — before the next turn
// rides it, not discovered mid-turn as a dead connection (worker-stall-2,
// lab run 41921504494: the peer closed 32 ms after the turn's terminal and
// the worker kept the corpse in its live map).
//
// The answer is a transport fact, observed in one place: the SDK's
// connection Done (the receive loop ended — the peer's stdio is gone) or the
// process's own reap. A session that cannot answer (a test double, an
// adapter without a process) reports false: no observation, no claim, the
// old behaviour stands.
type PeerStateReporter interface {
	// PeerGone reports whether the session's transport is gone: the agent
	// process has exited, or its stdio connection closed.
	PeerGone() bool
}

// PeerGone asks a live session whether its transport is still there. A
// session that cannot answer reports not-gone — the honest absence, the
// caller keeps the session exactly as before this check existed.
func PeerGone(sess domain.AgentSession) bool {
	r, ok := sess.(PeerStateReporter)
	if !ok {
		return false
	}
	return r.PeerGone()
}

var _ PeerStateReporter = (*handle)(nil)

// PeerGone answers from the two observers only: the SDK connection's Done
// (the receive loop ended — the peer's stdout is gone, process or no
// process) and the process reap. Both are non-blocking reads, so this is
// safe to ask under the loop's live-map lock and in any order with Prompt.
// A process-less handle (in-test) reports not-gone: without a transport
// there is nothing to observe, and claiming a death no one observed is the
// lie this check exists to prevent.
func (h *handle) PeerGone() bool {
	if h == nil {
		return false
	}
	if h.conn != nil {
		select {
		case <-h.conn.Done():
			return true
		default:
		}
	}
	if h.transport != nil && h.exited != nil {
		select {
		case <-h.exited:
			return true
		default:
		}
	}
	return false
}
