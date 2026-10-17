package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// runningTurn is one claimed turn in flight. It owns the cancel signal that
// unblocks everything (prompt, renewal, permission bridge) and the flags
// that decide the honest terminal state.
type runningTurn struct {
	loop  *TurnLoop
	claim Claim

	sess    atomic.Pointer[liveSession]
	notes   []string
	sinkRef atomic.Pointer[turnSink]

	// turnOrigin is how this turn met its session — new | resumed | reused
	// (events.SessionOrigin*) — set by sessionFor before BeginTurn. It must
	// never claim `new` for a turn that rode a live session (04 "Session
	// reuse semantics", J7 honesty).
	turnOrigin string

	// cancel ends every goroutine working for this turn. Its parent is a
	// detached context, so only drain, lease loss, remote cancel or a
	// wedged harness reach it.
	cancel func()

	shutdown        atomic.Bool // drain/SIGTERM in progress
	lostLease       atomic.Bool // a fenced write proved this worker is stale
	cancelRequested atomic.Bool // cancel_requested_at observed
	cancelledBy     atomic.Pointer[string]

	// permVoid is closed once the turn's pending permission prompts are
	// moot (a cancel was forwarded, or the turn is winding down). It is
	// separate from the turn context because session/cancel must reach the
	// harness as a protocol notification, not as a dropped JSON-RPC stream:
	// the prompt is still open, but its human answer can no longer matter.
	permVoid chan struct{}
	voidOnce sync.Once
}

func (rt *runningTurn) session(s *liveSession)    { rt.sess.Store(s) }
func (rt *runningTurn) sessionLoad() *liveSession { return rt.sess.Load() }

// voidPermissions releases any bridge still waiting on a human decision.
func (rt *runningTurn) voidPermissions() { rt.voidOnce.Do(func() { close(rt.permVoid) }) }

// runTurn executes one claimed turn end to end and always tries to write an
// honest terminal state — unless the fencing token proved us stale, in which
// case writing nothing IS the honest answer (ADR-0016 §9 obligation 2).
func (l *TurnLoop) runTurn(ctx context.Context, c Claim) {
	base := context.WithoutCancel(ctx)
	tctx, tcancel := context.WithCancel(base)
	defer tcancel()

	rt := &runningTurn{loop: l, claim: c, cancel: tcancel, permVoid: make(chan struct{})}
	defer rt.voidPermissions()
	l.cur.Store(rt)
	defer l.cur.Store(nil)

	sess, err := l.sessionFor(base, c, rt)
	if err != nil {
		l.log.Error("session unavailable",
			slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
		l.finish(base, c, rt, TurnOutcome{Status: events.TurnStatusFailed, Message: bounded(err.Error(), 512)}, false)
		return
	}

	beginInfo := sess.info
	beginInfo.Origin = rt.turnOrigin
	if err := l.store.BeginTurn(tctx, c, sess.bindingID, beginInfo); err != nil {
		l.log.Error("begin turn failed", slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
		if errors.Is(err, ErrLeaseLost) {
			rt.lostLease.Store(true)
			l.abandon(c)
			return
		}
		l.finish(base, c, rt, TurnOutcome{Status: events.TurnStatusFailed, Message: bounded(err.Error(), 512)}, false)
		return
	}

	// Transcript sink: coalesces agent text, writes tool events, all fenced.
	// It writes under the turn context — a terminal write (sink finish at
	// drain) must survive that cancellation, so the finish flush runs on a
	// detached context instead.
	snk := l.newSink(c, tctx, func() {
		// A fenced append failed while the turn was live: we are stale.
		rt.lostLease.Store(true)
		sess.cancelACP(base)
		tcancel()
	})
	rt.sinkRef.Store(snk)
	sess.mu.Lock()
	sess.route = snk.emit
	sess.turn = rt
	sess.mu.Unlock()
	for _, n := range rt.notes {
		snk.note(n)
	}

	// Lease renewal: every RenewInterval, fenced. Zero rows = lost.
	go l.renewLoop(tctx, base, c, rt)
	// Cancel watch: ≤ CancelPoll plus optional journal wake-ups.
	wake := l.turnWake(tctx)
	go l.cancelWatch(tctx, base, c, rt, wake)

	reason, promptErr := sess.handle.Prompt(tctx, c.Prompt)

	// Let trailing stream updates arrive — still routed to the sink —
	// before the transcript closes; updates racing the turn result would
	// otherwise be dropped.
	<-l.clock.After(l.cfg.Quiesce)
	sess.mu.Lock()
	sess.route = nil
	sess.turn = nil
	sess.mu.Unlock()

	outcome := l.mapOutcome(rt, reason, promptErr)
	finctx, fincancel := context.WithTimeout(context.WithoutCancel(tctx), 15*time.Second)
	snk.finish(finctx, outcome.Status == events.TurnStatusCompleted)
	fincancel()
	l.finish(base, c, rt, outcome, errors.Is(promptErr, context.Canceled) || rt.lostLease.Load())

	if rt.lostLease.Load() {
		l.abandon(c)
		return
	}
	if outcome.Status == events.TurnStatusFailed || rt.shutdown.Load() {
		// The process is being retired either way (drain) or may be wedged
		// (failure): do not leave a live instance bound.
		l.closeSession(base, sess, outcomeReasonForSession(outcome))
	}
}

// mapOutcome picks the honest terminal status from the turn's flags and the
// harness answer.
func (l *TurnLoop) mapOutcome(rt *runningTurn, reason domain.StopReason, promptErr error) TurnOutcome {
	switch {
	case rt.lostLease.Load():
		return TurnOutcome{} // nothing is ours to write any more
	case rt.shutdown.Load():
		// ACP may answer anything when we initiated the stop; the honest
		// word is "interrupted" — we are leaving, outcome unknown (J7).
		return TurnOutcome{Status: events.TurnStatusInterrupted, Reason: events.InterruptShutdown}
	case promptErr != nil:
		return TurnOutcome{Status: events.TurnStatusFailed, Message: bounded(promptErr.Error(), 512)}
	case rt.cancelRequested.Load() || reason == domain.StopCancelled:
		requestedBy := ""
		if p := rt.cancelledBy.Load(); p != nil {
			requestedBy = *p
		}
		stop := string(reason)
		if reason == domain.StopEndTurn {
			stop = "cancelled" // the cancel is why this turn stopped, not the harness
		}
		return TurnOutcome{Status: events.TurnStatusCancelled, StopReason: stop, RequestedBy: requestedBy}
	default:
		return TurnOutcome{Status: events.TurnStatusCompleted, StopReason: string(reason)}
	}
}

// finish writes the terminal state + event. The write is fenced; ErrLeaseLost
// here means a newer owner already spoke for this turn, so we log and stop.
func (l *TurnLoop) finish(base context.Context, c Claim, rt *runningTurn, o TurnOutcome, forceInterruptedOnCtxErr bool) {
	if rt != nil && rt.lostLease.Load() {
		return
	}
	if o.Status == "" {
		return
	}
	ctx, cancel := context.WithTimeout(base, 10*time.Second)
	defer cancel()
	if err := l.store.FinishTurn(ctx, c, o); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			l.log.Warn("terminal write rejected: lease lost", slog.String("turn_id", c.TurnID))
			rt.lostLease.Store(true)
			return
		}
		l.log.Error("terminal write failed", slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
	}
	// The M3 unit boundary. It runs *after* the terminal write and never
	// interferes with it: contract deviation D9 says an M3 failure loses
	// artifacts, not edits, and the edits are durable in the run ref the moment
	// the turn is. Cleanup itself is unconditional — the secret-removal assertion
	// does not care whether the turn completed, failed or was cancelled.
	if l.units != nil {
		l.captureAndRelease(base, c)
	}
}

// abandon drops a session whose worker no longer owns the turn: never write
// for the turn again, and retire the process without touching bindings
// (the new owner's recordBinding closes ours honestly).
func (l *TurnLoop) abandon(c Claim) {
	l.mu.Lock()
	s := l.live[c.ConversationID]
	if s != nil {
		delete(l.live, c.ConversationID)
	}
	l.mu.Unlock()
	if s != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			s.cancelACP(ctx)
			_ = s.handle.Close()
		}()
	}
}

// renewLoop renews the lease every RenewInterval; a rejected renewal is the
// authoritative word that we are stale.
func (l *TurnLoop) renewLoop(tctx, base context.Context, c Claim, rt *runningTurn) {
	for {
		select {
		case <-tctx.Done():
			return
		case <-l.clock.After(l.cfg.RenewInterval):
		}
		ctx, cancel := context.WithTimeout(base, l.cfg.RenewInterval)
		err := l.store.RenewLease(ctx, c)
		cancel()
		if errors.Is(err, ErrLeaseLost) {
			l.log.Warn("lease lost; stopping all writes for the turn", slog.String("turn_id", c.TurnID))
			rt.lostLease.Store(true)
			if s := rt.sessionLoad(); s != nil {
				s.cancelACP(base)
			}
			rt.cancel()
			return
		}
		if err != nil {
			l.log.Warn("lease renewal failed (retrying next tick)",
				slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
		}
	}
}

// cancelWatch re-reads this turn's cancel flag on a ≤1 s tick and on journal
// wake-ups, and forwards the first sighting into ACP session/cancel.
func (l *TurnLoop) cancelWatch(tctx, base context.Context, c Claim, rt *runningTurn, wake <-chan struct{}) {
	for {
		at, ok, err := l.store.CancelRequested(tctx, c)
		switch {
		case errors.Is(err, ErrLeaseLost):
			rt.lostLease.Store(true)
			if s := rt.sessionLoad(); s != nil {
				s.cancelACP(base)
			}
			rt.cancel()
			return
		case err != nil:
			if tctx.Err() != nil {
				return
			}
		case ok && !at.IsZero():
			if !rt.cancelRequested.Swap(true) {
				l.log.Info("cancel requested; forwarding session/cancel",
					slog.String("turn_id", c.TurnID), slog.String("requested_at", at.UTC().Format(time.RFC3339)))
				// Attribute the cancel to whoever holds the control lock now:
				// both /cancel and a takeover route through it (ADR-0016 §5),
				// and the transfer happens before the worker can observe the
				// flag.
				if uid, found, err := l.store.ControllerUser(base, c.ConversationID); err == nil && found && uid != "" {
					rt.cancelledBy.Store(&uid)
				}
				if s := rt.sessionLoad(); s != nil {
					s.cancelACP(base)
				}
				// The controller said stop; a human decision still pending on
				// this turn's prompt is moot the moment we forward the cancel.
				rt.voidPermissions()
			}
			// Keep watching: a second sighting adds nothing, and the
			// harness closing the turn ends Prompt().
		}
		select {
		case <-tctx.Done():
			return
		case <-wake:
		case <-l.clock.After(l.cfg.CancelPoll):
		}
	}
}

// turnWake subscribes to journal notifications for one turn's lifetime.
func (l *TurnLoop) turnWake(ctx context.Context) <-chan struct{} {
	if l.wake == nil {
		return nil
	}
	ch, stop, err := l.wake(ctx)
	if err != nil {
		return nil
	}
	go func() {
		<-ctx.Done()
		stop()
	}()
	return ch
}

// decidePermission is the durable bridge for one permission prompt. Under
// `ask` it is the human bridge: insert + event, wait for the controller's
// decision (wake/poll), and close honestly on deadline or turn cancel. Only
// this worker ever speaks ACP, so the DB row is the handoff point.
//
// Under `deny` (and, defensively, any mode that reaches here without a human
// owner) the answer is policy, not a person: the request is still opened — so
// conversation.permission.requested is journaled and the refusal is visible —
// and then closed immediately as cancelled. Nobody is ever asked, so the turn
// must not sit pending until expiry waiting for a controller who was never
// consulted (that is how a deny became an ask in a live run).
func (rt *runningTurn) decidePermission(ctx context.Context, p domain.PermissionPrompt) (domain.PermissionChoice, error) {
	l := rt.loop
	c := rt.claim
	options := make([]events.PermissionOption, 0, len(p.Options))
	for _, o := range p.Options {
		options = append(options, events.PermissionOption{OptionID: o.OptionID, Label: o.Label, Kind: o.Kind})
	}
	deadline := l.now().Add(l.cfg.PermissionTTL)
	requestID, err := l.store.OpenPermission(ctx, c, PermissionOpen{
		// The ACP JSON-RPC request id never reaches the client handler, so
		// the durable row invents one: unique per prompt by construction
		// (UNIQUE (turn_id, acp_request_id) is the backstop).
		ACPRequestID: fmt.Sprintf("%s-%d", safeKey(p.ToolCallID), l.now().UnixNano()),
		ToolCallID:   p.ToolCallID,
		Title:        bounded(p.Title, 200),
		Kind:         p.Kind,
		Options:      options,
		Deadline:     deadline,
	})
	if err != nil {
		return domain.PermissionChoice{}, err
	}

	if c.PermissionMode != "ask" {
		// Answered by policy. `decided` is not available here:
		// permission_requests.decided_by is a user uuid, so no policy can own a
		// decided row — `cancelled` with no option is the honest close (same
		// reasoning as AgentTurn.permissionBridge in agentturn.go, and
		// docs/design/attempt-permissions.md). The agent sees the ACP cancelled
		// outcome: a refusal it can act on, and no waiting or polling.
		//
		// preapproved_within_sandbox should never arrive (the turnloop keeps it
		// on the harness's auto mode where no prompt is sent); if it somehow
		// does, failing closed like deny is safer than routing it to a human.
		_, _, cerr := l.store.ClosePermission(ctx, c, requestID, events.PermissionStatusCancelled)
		if cerr != nil {
			l.log.Warn("closing policy-denied permission failed",
				slog.String("request_id", requestID),
				slog.String("permission_mode", c.PermissionMode),
				slog.String("error", cerr.Error()))
		}
		return domain.PermissionChoice{}, nil
	}

	wake := l.turnWake(ctx)
	tick := l.clock.After(l.cfg.PermissionPoll)
	for {
		state, err := l.store.PermissionState(ctx, requestID)
		if err != nil && ctx.Err() == nil {
			l.log.Warn("permission state read failed; retrying", slog.String("request_id", requestID), slog.String("error", err.Error()))
		}
		if err == nil && state.Status != events.PermissionStatusPending {
			switch state.Status {
			case events.PermissionStatusDecided:
				return domain.PermissionChoice{OptionID: state.OptionID}, nil
			default: // expired/closed by someone else: nobody will answer
				return domain.PermissionChoice{}, nil
			}
		}

		expired := l.now().After(deadline)
		var moot bool
		select {
		case <-ctx.Done():
			moot = true
		case <-rt.permVoid:
			moot = true
		case <-wake:
		case <-tick:
			expired = expired || l.now().After(deadline)
		}
		if moot {
			// Turn cancelled or ending while the prompt was open: close it
			// as cancelled with a detached write (ADR-0016 §5).
			dctx, dcancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer dcancel()
			final, _, cerr := l.store.ClosePermission(dctx, c, requestID, events.PermissionStatusCancelled)
			if cerr != nil {
				l.log.Warn("closing pending permission failed", slog.String("request_id", requestID), slog.String("error", cerr.Error()))
			} else if final.Status == events.PermissionStatusDecided {
				return domain.PermissionChoice{OptionID: final.OptionID}, nil
			}
			return domain.PermissionChoice{}, errors.New("worker: permission prompt cancelled with the turn")
		}
		if expired {
			dctx, dcancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			final, closed, cerr := l.store.ClosePermission(dctx, c, requestID, events.PermissionStatusExpired)
			dcancel()
			if cerr != nil {
				l.log.Warn("expiring permission failed", slog.String("request_id", requestID), slog.String("error", cerr.Error()))
			}
			if final.Status == events.PermissionStatusDecided {
				return domain.PermissionChoice{OptionID: final.OptionID}, nil
			}
			_ = closed
			// Expired → offer the agent a rejection it can act on rather
			// than a fabricated option: the cancelled outcome is the honest
			// "nobody said yes".
			return domain.PermissionChoice{}, nil
		}
		tick = l.clock.After(l.cfg.PermissionPoll)
	}
}

// now is clock-adjacent: durations come from Clock.After, instants for
// deadlines from the wall clock (tests pin TTLs, not times).
func (l *TurnLoop) now() time.Time { return time.Now() }

func safeKey(s string) string {
	if s == "" {
		return "request"
	}
	return s
}

func bounded(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// --------------------------------------------------------- event builders

func sessionConnectedEvent(c Claim, bindingID string, info domain.SessionInfo) TurnEvent {
	return TurnEvent{
		Type:      events.TypeAgentSessionConnected,
		ActorKind: events.ActorKindWorker,
		ActorID:   c.WorkerID,
		Payload: events.SessionConnectedPayload{
			ConversationID:    c.ConversationID,
			BindingID:         bindingID,
			WorkerID:          c.WorkerID,
			ACPSessionID:      info.ACPSessionID,
			ProtocolVersion:   info.ProtocolVersion,
			LauncherID:        info.LauncherID,
			LauncherVersion:   info.LauncherVersion,
			SessionOrigin:     info.Origin,
			AgentCapabilities: info.AgentCapabilities,
		},
	}
}

func sessionDisconnectedEvent(conversationID, bindingID, workerID, acpSessionID, reason string) TurnEvent {
	return TurnEvent{
		Type:      events.TypeAgentSessionDisconnected,
		ActorKind: events.ActorKindWorker,
		ActorID:   workerID,
		Payload: events.SessionDisconnectedPayload{
			ConversationID: conversationID,
			BindingID:      bindingID,
			WorkerID:       workerID,
			ACPSessionID:   acpSessionID,
			Reason:         reason,
		},
	}
}

func outcomeReasonForSession(o TurnOutcome) string {
	switch o.Status {
	case events.TurnStatusInterrupted:
		return events.InterruptShutdown
	default:
		return "process_exited"
	}
}
