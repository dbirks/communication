package worker_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// ---------------------------------------------------------------- fakes

// fakeStore implements worker.TurnStore with scripted outcomes per method.
// Every call is recorded; tests wait on channels the store pings.
type fakeStore struct {
	mu sync.Mutex

	claims  []worker.Claim
	claimed chan struct{} // pinged per successful claim

	renewErr    error
	renewCalls  int
	renewed     chan error // each renewal outcome (nil or the error) delivered
	beginErr    error
	begun       chan worker.Claim
	beginSess   []domain.SessionInfo // SessionInfo passed to each BeginTurn
	appends     []recordedAppend
	appended    chan recordedAppend // agent-message appends stream to wait on
	finished    []worker.TurnOutcome
	finishing   chan worker.TurnOutcome
	cancelAt    map[string]time.Time
	cancelErr   map[string]error
	controller  string
	permOpens   chan worker.PermissionOpen
	permState   map[string]func(calls int) worker.PermissionState
	permClosed  chan closedPerm
	permFinal   map[string]worker.PermissionState
	repos       []worker.Repo
	bindingID   int
	bindingSess []domain.SessionInfo
	bindingConv []string // RecordBinding conversation ids
	resumable   domain.SessionInfo
	resumableOK bool
	closedBinds chan closedBind
	convStatus  chan string
	convEvents  chan worker.TurnEvent
	appendErrOn func(worker.TurnEvent) error
}

type recordedAppend struct {
	claim worker.Claim
	event worker.TurnEvent
}
type closedPerm struct {
	id     string
	status string
}
type closedBind struct {
	conversation, workerID, reason string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		claimed:     make(chan struct{}, 16),
		renewed:     make(chan error, 32),
		begun:       make(chan worker.Claim, 4),
		appended:    make(chan recordedAppend, 256),
		finishing:   make(chan worker.TurnOutcome, 4),
		cancelAt:    map[string]time.Time{},
		cancelErr:   map[string]error{},
		permOpens:   make(chan worker.PermissionOpen, 8),
		permState:   map[string]func(int) worker.PermissionState{},
		permClosed:  make(chan closedPerm, 8),
		permFinal:   map[string]worker.PermissionState{},
		closedBinds: make(chan closedBind, 8),
		convStatus:  make(chan string, 16),
		convEvents:  make(chan worker.TurnEvent, 64),
	}
}

func (f *fakeStore) ClaimTurn(ctx context.Context, workerID string) (worker.Claim, bool, error) {
	f.mu.Lock()
	var c worker.Claim
	var ok bool
	if len(f.claims) > 0 {
		c, ok = f.claims[0], true
		f.claims = f.claims[1:]
		if c.WorkerID == "" {
			c.WorkerID = workerID
		}
	}
	f.mu.Unlock()
	if ok {
		select {
		case f.claimed <- struct{}{}:
		default:
		}
	}
	return c, ok, nil
}

func (f *fakeStore) RenewLease(_ context.Context, _ worker.Claim) error {
	f.mu.Lock()
	f.renewCalls++
	err := f.renewErr
	f.mu.Unlock()
	select {
	case f.renewed <- err:
	default:
	}
	return err
}

func (f *fakeStore) BeginTurn(_ context.Context, c worker.Claim, bindingID string, s domain.SessionInfo) error {
	f.mu.Lock()
	err := f.beginErr
	f.beginSess = append(f.beginSess, s)
	f.mu.Unlock()
	if err != nil {
		return err
	}
	_ = bindingID
	f.begun <- c
	return nil
}

func (f *fakeStore) AppendTurnEvent(_ context.Context, c worker.Claim, ev worker.TurnEvent) error {
	rec := recordedAppend{claim: c, event: ev}
	f.mu.Lock()
	var err error
	if f.appendErrOn != nil {
		err = f.appendErrOn(ev)
	}
	f.appends = append(f.appends, rec)
	f.mu.Unlock()
	if ev.Type == events.TypeConversationMessageAgent || ev.Type == events.TypeConversationToolCall {
		select {
		case f.appended <- rec:
		default:
		}
	}
	return err
}

func (f *fakeStore) AppendConversationEvent(_ context.Context, _ string, ev worker.TurnEvent) error {
	f.convEvents <- ev
	return nil
}

func (f *fakeStore) CancelRequested(_ context.Context, c worker.Claim) (time.Time, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, bad := f.cancelErr[c.TurnID]; bad {
		return time.Time{}, false, err
	}
	at, ok := f.cancelAt[c.TurnID]
	return at, ok, nil
}

func (f *fakeStore) ControllerUser(_ context.Context, _ string) (string, bool, error) {
	return f.controller, f.controller != "", nil
}

func (f *fakeStore) FinishTurn(_ context.Context, _ worker.Claim, o worker.TurnOutcome) error {
	f.mu.Lock()
	f.finished = append(f.finished, o)
	f.mu.Unlock()
	f.finishing <- o
	return nil
}

func (f *fakeStore) OpenPermission(_ context.Context, _ worker.Claim, p worker.PermissionOpen) (string, error) {
	id := "perm-" + p.ACPRequestID
	f.permState[p.ACPRequestID] = nil
	f.permOpens <- p
	return id, nil
}

func (f *fakeStore) PermissionState(_ context.Context, id string) (worker.PermissionState, error) {
	key := strings.TrimPrefix(id, "perm-")
	f.mu.Lock()
	fn := f.permState[key]
	f.mu.Unlock()
	if fn == nil {
		return worker.PermissionState{Status: events.PermissionStatusPending}, nil
	}
	return fn(0), nil
}

func (f *fakeStore) ClosePermission(_ context.Context, _ worker.Claim, id, status string) (worker.PermissionState, bool, error) {
	key := strings.TrimPrefix(id, "perm-")
	f.mu.Lock()
	final, had := f.permFinal[key]
	f.mu.Unlock()
	if had && final.Status != events.PermissionStatusPending {
		return final, false, nil
	}
	f.permClosed <- closedPerm{id: id, status: status}
	return worker.PermissionState{Status: status}, true, nil
}

func (f *fakeStore) ProjectRepos(_ context.Context, _ string) ([]worker.Repo, error) {
	return f.repos, nil
}

func (f *fakeStore) RecordBinding(_ context.Context, c worker.Claim, s domain.SessionInfo) (string, []string, error) {
	f.mu.Lock()
	f.bindingID++
	id := "binding-1"
	if f.bindingID > 1 {
		id = "binding-n"
	}
	f.bindingSess = append(f.bindingSess, s)
	f.bindingConv = append(f.bindingConv, c.ConversationID)
	f.mu.Unlock()
	return id, nil, nil
}

func (f *fakeStore) ResumableSession(_ context.Context, _, _ string) (domain.SessionInfo, bool, error) {
	return f.resumable, f.resumableOK, nil
}

func (f *fakeStore) CloseBinding(_ context.Context, conversationID, workerID, reason string) ([]string, error) {
	f.closedBinds <- closedBind{conversation: conversationID, workerID: workerID, reason: reason}
	return []string{"binding-1"}, nil
}

func (f *fakeStore) SetConversationStatus(_ context.Context, _, status string) error {
	f.convStatus <- status
	return nil
}

func (f *fakeStore) snapshotAppends() []worker.TurnEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]worker.TurnEvent, 0, len(f.appends))
	for _, r := range f.appends {
		out = append(out, r.event)
	}
	return out
}

// fakeSession is a domain.AgentSession driven by the tests.
type fakeSession struct {
	events chan domain.ConversationEvent
	info   domain.SessionInfo

	promptFn func(ctx context.Context, s *fakeSession) (domain.StopReason, error)

	decider domain.PermissionDecider

	cancels  atomic.Int32
	closed   atomic.Bool
	closedCh chan struct{}
	sendMu   sync.Mutex
	sendCh   chan domain.ConversationEvent
}

func newFakeSession(info domain.SessionInfo) *fakeSession {
	if info.ACPSessionID == "" {
		info.ACPSessionID = "acp-fake-1"
	}
	if info.Origin == "" {
		info.Origin = events.SessionOriginNew
	}
	s := &fakeSession{
		events:   make(chan domain.ConversationEvent, 128),
		info:     info,
		closedCh: make(chan struct{}),
	}
	s.sendCh = s.events
	return s
}

func (s *fakeSession) Info() domain.SessionInfo { return s.info }

func (s *fakeSession) Prompt(ctx context.Context, _ string) (domain.StopReason, error) {
	if s.promptFn != nil {
		return s.promptFn(ctx, s)
	}
	<-ctx.Done()
	return "", ctx.Err()
}

func (s *fakeSession) Cancel(context.Context) error {
	s.cancels.Add(1)
	return nil
}

func (s *fakeSession) Events() <-chan domain.ConversationEvent { return s.events }

func (s *fakeSession) Close() error {
	if s.closed.Swap(true) == false {
		close(s.closedCh)
		s.sendMu.Lock()
		defer s.sendMu.Unlock()
		close(s.sendCh)
	}
	return nil
}

// send pushes an event unless closed; tests call it from prompt bodies.
func (s *fakeSession) send(ev domain.ConversationEvent) {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	if s.closed.Load() {
		return
	}
	s.sendCh <- ev
}

// fakeFactory records launch requests and hands back queued sessions.
type fakeFactory struct {
	mu       sync.Mutex
	requests []domain.SessionRequest
	sessions []*fakeSession
	launched int
	err      error
}

func (f *fakeFactory) NewSession(_ context.Context, req domain.SessionRequest) (domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.launched++
	if f.err != nil {
		return nil, f.err
	}
	var s *fakeSession
	if len(f.sessions) > 0 {
		s = f.sessions[0]
		f.sessions = f.sessions[1:]
	} else {
		s = newFakeSession(domain.SessionInfo{LauncherID: req.LauncherID})
	}
	s.decider = req.Decider
	f.requests = append(f.requests, req)
	return s, nil
}

func (f *fakeFactory) request(i int) domain.SessionRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[i]
}

func (f *fakeFactory) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.launched
}

// fakeWork is a trivial WorkspacePrep.
type fakeWork struct {
	dir   string
	notes []string
	err   error
}

func (w *fakeWork) Prepare(_ context.Context, _ string, _ []worker.Repo) (string, []string, error) {
	return w.dir, w.notes, w.err
}

// ------------------------------------------------------------- fixtures

func testClaim() worker.Claim {
	return worker.Claim{
		TurnID: "turn-1", ConversationID: "conv-1", ProjectID: "proj-1",
		OrganizationID: "org-1", WorkerID: "worker-1", FencingToken: 41,
		Prompt: "hello agent", SubmittedBy: "user-1",
		LauncherID: "claude", PermissionMode: "ask",
	}
}

// fastCfg shrinks every cadence so tests run in milliseconds.
func fastCfg() worker.TurnConfig {
	return worker.TurnConfig{
		LeaseTTL:        time.Second,
		RenewInterval:   20 * time.Millisecond,
		ClaimInterval:   5 * time.Millisecond,
		CancelPoll:      5 * time.Millisecond,
		IdleFlush:       15 * time.Millisecond,
		Quiesce:         10 * time.Millisecond,
		PermissionTTL:   2 * time.Second,
		PermissionPoll:  5 * time.Millisecond,
		MaxChunkBytes:   1024,
		MaxPreviewBytes: 64,
		AskModeID: func(id string) string {
			if id == "claude" {
				return "default"
			}
			return ""
		},
	}
}

func startLoop(t *testing.T, l *worker.TurnLoop) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel() })
	go func() { _ = l.Start(ctx) }()
}

func newLoop(t *testing.T, cfg worker.TurnConfig, st *fakeStore, ff *fakeFactory) *worker.TurnLoop {
	t.Helper()
	l, err := worker.NewTurnLoop(cfg, st, ff, &fakeWork{dir: t.TempDir()}, func() string { return "worker-1" })
	if err != nil {
		t.Fatalf("NewTurnLoop: %v", err)
	}
	return l
}

func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

// recvConvEvent drains conversation events until one of the wanted type
// arrives (the connected event legitimately precedes it).
func recvConvEvent(t *testing.T, ch <-chan worker.TurnEvent, wantType, what string) worker.TurnEvent {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type == wantType {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
			return worker.TurnEvent{}
		}
	}
}

func recvStatus(t *testing.T, ch <-chan string, want, what string) string {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s := <-ch:
			if s == want {
				return s
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
			return ""
		}
	}
}

// ------------------------------------------------------------------ tests

// TestHappyPathCoalescesChunks proves claim → begin → coalesced transcript →
// fenced terminal write, including: text chunks merge into one readable
// row, a tool event flushes pending text first, and the completed turn's
// final flush carries final=true.
func TestHappyPathCoalescesChunks(t *testing.T) {
	st := newFakeStore()
	claim := testClaim()
	claim.PermissionMode = "deny"
	st.claims = []worker.Claim{claim}

	sess := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-1", Origin: "new", LauncherID: "claude"})
	sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
		s.send(domain.ConversationEvent{Kind: "message_chunk", Text: "Hello "})
		s.send(domain.ConversationEvent{Kind: "message_chunk", Text: "world"})
		s.send(domain.ConversationEvent{Kind: "tool_call", ToolCallID: "t1", Text: "write file", ToolKind: "edit", ToolStatus: "pending", Input: "some input"})
		s.send(domain.ConversationEvent{Kind: "message_chunk", Text: "done"})
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)

	recv(t, st.begun, "BeginTurn")
	recv(t, st.appended, "tool append")
	out := recv(t, st.finishing, "FinishTurn")

	if out.Status != events.TurnStatusCompleted || out.StopReason != "end_turn" {
		t.Fatalf("outcome = %+v, want completed/end_turn", out)
	}
	var msgs []events.MessageAgentPayload
	var tools []events.ToolCallPayload
	for _, ev := range st.snapshotAppends() {
		switch p := ev.Payload.(type) {
		case events.MessageAgentPayload:
			msgs = append(msgs, p)
		case events.ToolCallPayload:
			tools = append(tools, p)
		}
	}
	if len(msgs) != 2 || len(tools) != 1 {
		t.Fatalf("transcript = %d msgs %v, %d tools %v; want 2 msgs, 1 tool", len(msgs), msgs, len(tools), tools)
	}
	if msgs[0].Text != "Hello world" || msgs[0].ChunkSeq != 1 || msgs[0].Final {
		t.Errorf("first chunk = %+v, want coalesced 'Hello world' seq 1 not final", msgs[0])
	}
	if msgs[1].Text != "done" || msgs[1].ChunkSeq != 2 || !msgs[1].Final {
		t.Errorf("final chunk = %+v, want 'done' seq 2 final", msgs[1])
	}
	if tools[0].Title != "write file" || tools[0].Kind != "edit" || tools[0].InputPreview != "some input" {
		t.Errorf("tool payload = %+v", tools[0])
	}
	if got := ff.request(0); got.ModeID != "" || got.LauncherID != "claude" {
		t.Errorf("launch request = %+v, want no mode for deny policy", got)
	}
}

// TestAskModeSelectionAndRefusal proves the ask mode id is applied for ask
// profiles, and that a launcher without a verified prompting mode fails the
// turn honestly instead of running the adapter's auto-approving default.
func TestAskModeSelectionAndRefusal(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim()} // mode ask, launcher claude, AskModeID → default
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(context.Context, *fakeSession) (domain.StopReason, error) {
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)
	recv(t, st.finishing, "first finish")
	if got := ff.request(0).ModeID; got != "default" {
		t.Fatalf("ModeID = %q, want the claude ask mode 'default'", got)
	}

	// A launcher with no verified prompting mode: failed turn, no launch.
	st2 := newFakeStore()
	c2 := testClaim()
	c2.LauncherID = "gemini"
	st2.claims = []worker.Claim{c2}
	ff2 := &fakeFactory{}
	l2 := newLoop(t, fastCfg(), st2, ff2)
	startLoop(t, l2)
	out := recv(t, st2.finishing, "second finish")
	if out.Status != events.TurnStatusFailed || !strings.Contains(out.Message, "prompting mode") {
		t.Fatalf("outcome = %+v, want failed mentioning the missing prompting mode", out)
	}
	if ff2.count() != 0 {
		t.Fatalf("launched %d sessions on an unsupported launcher, want 0", ff2.count())
	}
}

// TestStaleAppendAbortsWrites proves fail-closed behaviour: when a fenced
// append reports ErrLeaseLost, the turn stops writing entirely — no terminal
// event from us (the new owner speaks) — and the session is retired.
func TestStaleAppendAbortsWrites(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "deny")}
	st.appendErrOn = func(ev worker.TurnEvent) error {
		if ev.Type == events.TypeConversationToolCall {
			return worker.ErrLeaseLost
		}
		return nil
	}
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
		s.send(domain.ConversationEvent{Kind: "tool_call", ToolCallID: "t1", Text: "boom"})
		<-ctx.Done() // the sink's onLost must cancel the turn
		return "", ctx.Err()
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)

	recv(t, st.appended, "failed append attempt")
	select {
	case o := <-st.finishing:
		t.Fatalf("stale worker wrote a terminal outcome: %+v", o)
	case <-time.After(300 * time.Millisecond):
	}
	// The abandoned session's process is reaped asynchronously by abandon().
	deadline := time.Now().Add(2 * time.Second)
	for !sess.closed.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !sess.closed.Load() {
		t.Fatal("stale worker left its agent process attached")
	}
}

func testClaim2(t *testing.T, mode string) worker.Claim {
	t.Helper()
	c := testClaim()
	c.PermissionMode = mode
	return c
}

// TestStaleRenewAbortsTurn is the same fail-closed proof through the lease
// renewal path (ADR-0016 §3: renewal rejection means "stop writing").
func TestStaleRenewAbortsTurn(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "deny")}
	st.renewErr = worker.ErrLeaseLost
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(ctx context.Context, _ *fakeSession) (domain.StopReason, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)

	recv(t, st.renewed, "first renewal")
	select {
	case o := <-st.finishing:
		t.Fatalf("stale worker wrote a terminal outcome: %+v", o)
	case <-time.After(300 * time.Millisecond):
	}
	if sess.cancels.Load() == 0 {
		t.Error("stale worker did not cancel its in-flight ACP prompt")
	}
}

// TestCancelPropagation proves the cancel_requested watch: the worker sees
// the flag within its poll budget, forwards ACP session/cancel, and closes
// the turn cancelled with the current controller as the requester.
func TestCancelPropagation(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "deny")}
	st.controller = "user-2" // took control, which set cancel_requested
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
		for {
			if s.cancels.Load() > 0 {
				return domain.StopCancelled, nil
			}
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Millisecond):
			}
		}
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)
	recv(t, st.begun, "begin")

	st.mu.Lock()
	st.cancelAt["turn-1"] = time.Now()
	st.mu.Unlock()

	out := recv(t, st.finishing, "finish")
	if out.Status != events.TurnStatusCancelled {
		t.Fatalf("outcome = %+v, want cancelled", out)
	}
	if out.RequestedBy != "user-2" {
		t.Errorf("RequestedBy = %q, want the controller who requested the stop", out.RequestedBy)
	}
	if sess.cancels.Load() == 0 {
		t.Error("ACP session/cancel was never sent")
	}
}

// TestPermissionBridge covers the three durable outcomes of an ask prompt:
// the controller's decision, a deadline nobody answered, and a turn cancel
// that voids the request.
func TestPermissionBridge(t *testing.T) {
	t.Run("decided", func(t *testing.T) {
		st := newFakeStore()
		st.claims = []worker.Claim{testClaim2(t, "deny")}
		sess := newFakeSession(domain.SessionInfo{})
		result := make(chan domain.PermissionChoice, 1)
		perr := make(chan error, 1)
		sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
			wait := make(chan struct{})
			go func() {
				defer close(wait)
				choice, err := s.decider(ctx, domain.PermissionPrompt{
					ToolCallID: "tc-1", Title: "Write allowed.txt", Kind: "edit",
					Options: []domain.PermissionOption{
						{OptionID: "allow-once", Label: "Yes", Kind: "allow_once"},
						{OptionID: "reject", Label: "No", Kind: "reject_once"},
					},
				})
				result <- choice
				_ = err
				perr <- err
			}()
			<-wait
			return domain.StopEndTurn, nil
		}
		ff := &fakeFactory{sessions: []*fakeSession{sess}}
		l := newLoop(t, fastCfg(), st, ff)
		startLoop(t, l)
		recv(t, st.begun, "begin")

		open := recv(t, st.permOpens, "permission row")
		if open.Title != "Write allowed.txt" || len(open.Options) != 2 || open.Deadline.IsZero() {
			t.Fatalf("permission open = %+v", open)
		}
		st.mu.Lock()
		st.permState[open.ACPRequestID] = func(int) worker.PermissionState {
			return worker.PermissionState{Status: events.PermissionStatusDecided, OptionID: "allow-once", DecidedBy: "user-1"}
		}
		st.mu.Unlock()

		choice := recv(t, result, "decider return")
		if choice.OptionID != "allow-once" {
			t.Fatalf("choice = %+v, want the decided option echoed", choice)
		}
		if err := <-perr; err != nil {
			t.Fatalf("decider error: %v", err)
		}
		recv(t, st.finishing, "finish")
	})

	t.Run("deadline", func(t *testing.T) {
		st := newFakeStore()
		st.claims = []worker.Claim{testClaim2(t, "deny")}
		cfg := fastCfg()
		cfg.PermissionTTL = 40 * time.Millisecond
		sess := newFakeSession(domain.SessionInfo{})
		result := make(chan domain.PermissionChoice, 1)
		sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
			wait := make(chan struct{})
			go func() {
				defer close(wait)
				choice, _ := s.decider(ctx, domain.PermissionPrompt{ToolCallID: "tc-2", Title: "x", Options: nil})
				result <- choice
			}()
			<-wait
			return domain.StopEndTurn, nil
		}
		ff := &fakeFactory{sessions: []*fakeSession{sess}}
		l := newLoop(t, cfg, st, ff)
		startLoop(t, l)
		recv(t, st.begun, "begin")
		recv(t, st.permOpens, "permission row")

		closed := recv(t, st.permClosed, "expiry close")
		if closed.status != events.PermissionStatusExpired {
			t.Fatalf("closed as %q, want expired", closed.status)
		}
		choice := recv(t, result, "decider return")
		if choice.OptionID != "" {
			t.Fatalf("expired prompt answered with %q; nobody said yes", choice.OptionID)
		}
	})

	t.Run("cancel-while-pending", func(t *testing.T) {
		st := newFakeStore()
		st.claims = []worker.Claim{testClaim2(t, "deny")}
		sess := newFakeSession(domain.SessionInfo{})
		result := make(chan error, 1)
		sess.promptFn = func(ctx context.Context, s *fakeSession) (domain.StopReason, error) {
			notify := make(chan error, 1)
			go func() {
				_, err := s.decider(ctx, domain.PermissionPrompt{ToolCallID: "tc-3", Title: "y", Options: nil})
				result <- err
				notify <- err
			}()
			err := <-notify
			if err != nil {
				return domain.StopCancelled, nil
			}
			return domain.StopEndTurn, nil
		}
		ff := &fakeFactory{sessions: []*fakeSession{sess}}
		l := newLoop(t, fastCfg(), st, ff)
		startLoop(t, l)
		recv(t, st.begun, "begin")
		recv(t, st.permOpens, "permission row")

		st.mu.Lock()
		st.cancelAt["turn-1"] = time.Now()
		st.mu.Unlock()

		if err := recv(t, result, "decider cancellation"); err == nil {
			t.Fatal("decider returned success although the turn was cancelled")
		}
		closed := recv(t, st.permClosed, "cancel close")
		if closed.status != events.PermissionStatusCancelled {
			t.Fatalf("closed as %q, want cancelled", closed.status)
		}
		out := recv(t, st.finishing, "finish")
		if out.Status != events.TurnStatusCancelled {
			t.Fatalf("outcome = %+v, want cancelled", out)
		}
	})
}

// TestDrainWritesHonestTerminal is ADR-0016 §9 obligation 2 from the
// inside: SIGTERM-equivalent drain cancels the running turn, writes
// interrupted{shutdown} (never completed), closes the binding with a
// disconnected event, and parks the conversation at idle.
func TestDrainWritesHonestTerminal(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "deny")}
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(ctx context.Context, _ *fakeSession) (domain.StopReason, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)
	recv(t, st.begun, "begin")

	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	if err := l.Drain(dctx); err != nil {
		t.Fatalf("Drain: %v", err)
	}

	st.mu.Lock()
	finished := append([]worker.TurnOutcome(nil), st.finished...)
	st.mu.Unlock()
	if len(finished) != 1 {
		t.Fatalf("finished = %+v, want exactly one terminal write", finished)
	}
	out := finished[0]
	if out.Status != events.TurnStatusInterrupted || out.Reason != events.InterruptShutdown {
		t.Fatalf("drain outcome = %+v, want interrupted/shutdown", out)
	}
	if bind := recv(t, st.closedBinds, "binding close"); bind.reason != events.InterruptShutdown {
		t.Errorf("binding closed with reason %q, want shutdown", bind.reason)
	}
	// The journal sees agent.session.connected first (at launch); the drain
	// must also have appended the honest disconnect.
	ev := recvConvEvent(t, st.convEvents, events.TypeAgentSessionDisconnected, "session disconnected event")
	if p, ok := ev.Payload.(events.SessionDisconnectedPayload); !ok || p.Reason != events.InterruptShutdown {
		t.Errorf("disconnected event payload = %#v", ev.Payload)
	}
	status := recvStatus(t, st.convStatus, "idle", "conversation idle status")
	if status != "idle" {
		t.Errorf("conversation status = %q, want idle", status)
	}
	if !sess.closed.Load() {
		t.Error("agent process left running after drain")
	}
}

// TestSessionReuseAcrossTurns proves one live agent instance per
// conversation: two sequential turns on one conversation launch exactly one
// session and record exactly one binding.
func TestSessionReuseAcrossTurns(t *testing.T) {
	st := newFakeStore()
	c1, c2 := testClaim2(t, "deny"), testClaim2(t, "deny")
	c2.TurnID = "turn-2"
	st.claims = []worker.Claim{c1, c2}
	mk := func() *fakeSession {
		s := newFakeSession(domain.SessionInfo{})
		s.promptFn = func(context.Context, *fakeSession) (domain.StopReason, error) {
			return domain.StopEndTurn, nil
		}
		return s
	}
	ff := &fakeFactory{sessions: []*fakeSession{mk()}} // only one session available
	l := newLoop(t, fastCfg(), st, ff)
	startLoop(t, l)
	recv(t, st.finishing, "first finish")
	recv(t, st.finishing, "second finish")

	if ff.count() != 1 {
		t.Fatalf("launched %d sessions, want the conversation's single live instance reused", ff.count())
	}
	st.mu.Lock()
	bindings := append([]string(nil), st.bindingConv...)
	origins := make([]string, 0, len(st.beginSess))
	for _, s := range st.beginSess {
		origins = append(origins, s.Origin)
	}
	st.mu.Unlock()
	if len(bindings) != 1 {
		t.Fatalf("recorded %d bindings, want exactly one across both turns", len(bindings))
	}
	// turn.started must tell the truth about how *this turn* met its
	// session: the first turn created it (new), the second rode the live
	// process (reused) — never a blanket "new".
	if len(origins) != 2 || origins[0] != events.SessionOriginNew || origins[1] != events.SessionOriginReused {
		t.Fatalf("turn.started session origins = %v, want [new reused]", origins)
	}
	for _, o := range origins {
		if !events.ValidTurnSessionOrigin(o) {
			t.Errorf("origin %q is not a legal turn session origin", o)
		}
	}
}

// TestWorkspaceNotesLandInTranscript proves clone failures are reported on
// the transcript (as bounded agent text), not fatal.
func TestWorkspaceNotesLandInTranscript(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "deny")}
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(context.Context, *fakeSession) (domain.StopReason, error) {
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l, err := worker.NewTurnLoop(fastCfg(), st, ff, &fakeWork{dir: t.TempDir(), notes: []string{"clone of x failed: boom"}},
		func() string { return "worker-1" })
	if err != nil {
		t.Fatal(err)
	}
	startLoop(t, l)
	recv(t, st.finishing, "finish")
	found := false
	for _, ev := range st.snapshotAppends() {
		if p, ok := ev.Payload.(events.MessageAgentPayload); ok && strings.Contains(p.Text, "clone of x failed") {
			found = true
		}
	}
	if !found {
		t.Error("workspace clone failure never reached the transcript")
	}
}

// TestClaimFailureKeepsLoopAlive: a database blip during claim must not end
// the loop; the next tick claims normally.
func TestClaimFailureKeepsLoopAlive(t *testing.T) {
	st := newFakeStore()
	st.claims = []worker.Claim{testClaim2(t, "deny")}
	sess := newFakeSession(domain.SessionInfo{})
	sess.promptFn = func(context.Context, *fakeSession) (domain.StopReason, error) {
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	flaky := &flakyClaimStore{TurnStore: st, failing: new(atomic.Bool)}
	flaky.failing.Store(true)
	l, err := worker.NewTurnLoop(fastCfg(), flaky, ff, &fakeWork{dir: t.TempDir()},
		func() string { return "worker-1" })
	if err != nil {
		t.Fatal(err)
	}
	startLoop(t, l)

	// The loop must survive the failures; once they stop, the claim runs.
	time.Sleep(30 * time.Millisecond)
	flaky.failing.Store(false)
	recv(t, st.finishing, "finish after transient claim failure")
}

// flakyClaimStore fails claims while its flag is set — the database blip
// the loop has to absorb without exiting (worker.Heartbeat's blip rule
// applies to claims too).
type flakyClaimStore struct {
	worker.TurnStore
	failing *atomic.Bool
}

func (f *flakyClaimStore) ClaimTurn(ctx context.Context, workerID string) (worker.Claim, bool, error) {
	if f.failing.Load() {
		return worker.Claim{}, false, errors.New("transient database blip")
	}
	return f.TurnStore.ClaimTurn(ctx, workerID)
}
