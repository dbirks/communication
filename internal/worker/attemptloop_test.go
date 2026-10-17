package worker

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The fake AttemptStore below is shaped by the same sentences as the port's
// doc comments (docs/m4-contract.md § 4): batch = free capacity bounded by
// the wr.active_attempts < wr.capacity predicate, the
// (priority DESC, scheduled_at, id) tie-break, ONE attempt_fencing_seq draw
// per claim, and every fenced write rejecting a stale triple with
// ErrLeaseLost while writing nothing. It is a fake, and the § 7 exit gate is
// a real Postgres run — no quantity of green here substitutes for it.

type fakeAttempt struct {
	id, nodeExecID, runID, kind string
	nodeID, instanceKey         string
	attemptNumber, priority     int
	scheduledAt                 time.Time

	status       string // mirrors the attempts.status CHECK set
	workerID     string
	token        int64
	renews       int
	cancelAt     *time.Time
	outputs      any
	digest       string
	outcome      string
	checkpoint   *AttemptCheckpoint
	errorClass   string
	detail       string
	finishedAt   time.Time
	artifactRefs []any

	// refuseLive is ADR-0016 § 5's takeover: the attempt's terminal was written
	// over the worker's head, so its fenced writes are refused from then on.
	// turnClosed records the paired conversation turn's terminal, which the
	// worker DOES still own (conversation.turn.cancelled).
	refuseLive bool
	turnClosed string

	// cfg exists so an executor under test (process.exec) receives the same
	// shape the real claim hydration gives it.
	cfg map[string]any
}

type fakeAttemptStore struct {
	mu       sync.Mutex
	attempts []*fakeAttempt
	seq      int64

	capacity    int // workers.capacity
	active      int // workers.active_attempts
	maxActive   int
	claims      int
	writes      []string // successful state mutations only, in order
	cancelsSeen int

	// cancelErr/appendErr inject a store-side refusal into the two watch
	// paths (C4c: the store refuses a fenced write after a newer owner drew
	// a greater token) without disturbing the rest of the triple bookkeeping.
	cancelErr error
	appendErr error

	// completeErr injects a NON-fence refusal of the terminal write: the
	// store answered with an honest error that is not a stale fence, the arm
	// TestAttemptNonFenceRefusalFailsTheAttempt exercises.
	completeErr error
}

func newFakeAttemptStore(capacity int) *fakeAttemptStore {
	return &fakeAttemptStore{capacity: capacity}
}

func (s *fakeAttemptStore) queue(id, kind string, priority int, scheduled time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts = append(s.attempts, &fakeAttempt{
		id: id, nodeExecID: "ne-" + id, runID: "run-" + id,
		nodeID: strings.TrimPrefix(id, "a"), instanceKey: "/" + id,
		kind: kind, attemptNumber: 1, priority: priority,
		scheduledAt: scheduled, status: AttemptStatusQueued,
	})
}

// queueExec queues a process.exec attempt with uuid ids and a hydrated
// config — the exact shape claim hydration produces (§ 4 step 2), so the
// executor under test is dispatched against real claim data, not a shortcut.
func (s *fakeAttemptStore) queueExec(attemptID, runID string, cfg map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts = append(s.attempts, &fakeAttempt{
		id: attemptID, nodeExecID: "ne-" + attemptID, runID: runID,
		nodeID: "task", instanceKey: "/task",
		kind: NodeKindProcessExec, attemptNumber: 1,
		scheduledAt: time.Now(), status: AttemptStatusQueued, cfg: cfg,
	})
}

func (s *fakeAttemptStore) find(id string) *fakeAttempt {
	for _, a := range s.attempts {
		if a.id == id {
			return a
		}
	}
	return nil
}

// verify is the fence: zero rows for a stale triple means ErrLeaseLost and
// nothing written (ADR-0016 § 9 obligation 2).
func (s *fakeAttemptStore) verify(c AttemptClaim) (*fakeAttempt, error) {
	a, err := s.verifyTriple(c)
	if err != nil {
		return nil, err
	}
	if a.refuseLive {
		return nil, ErrLeaseLost // runCheckFence: a terminal attempt owns no live work
	}
	return a, nil
}

// verifyTriple is the fence without the liveness test — the read the cancel
// watch performs, which reports ADR-0016 § 5's takeover honestly instead of a
// bare lease loss (RunStore.CancelRequested's rule).
func (s *fakeAttemptStore) verifyTriple(c AttemptClaim) (*fakeAttempt, error) {
	a := s.find(c.AttemptID)
	if a == nil {
		return nil, ErrLeaseLost
	}
	if a.workerID != c.WorkerID || a.token != c.FencingToken {
		return nil, ErrLeaseLost
	}
	return a, nil
}

// takeOverAttempt is conversation TakeControl's run half (contract § 5.3):
// cancel_requested_at is stamped and attempts.status='interrupted'
// error_class='interrupted' land in the same transaction, while the paired
// turn stays live and owned by this worker.
func (s *fakeAttemptStore) takeOverAttempt(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.find(id)
	if a == nil {
		return
	}
	at := time.Now()
	a.cancelAt = &at
	a.status = AttemptStatusInterrupted
	a.errorClass = ErrorClassInterrupted
	a.detail = InterruptReasonHumanTakeover
	a.finishedAt = at
	a.refuseLive = true
	s.active--
	s.writes = append(s.writes, "takeover "+id)
}

// CloseAttemptTurnCancelled is the worker's own write on the turn's fence: it
// needs a cancel-requested attempt whose terminal was closed over its head.
func (s *fakeAttemptStore) CloseAttemptTurnCancelled(_ context.Context, c AttemptClaim) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verifyTriple(c)
	if err != nil {
		return err
	}
	if !a.refuseLive || a.cancelAt == nil || a.turnClosed != "" {
		return nil // no live cancel-requested turn on this triple: a no-op
	}
	a.turnClosed = "cancelled"
	s.writes = append(s.writes, "turn-cancel "+a.id)
	return nil
}

func (s *fakeAttemptStore) ClaimAttempts(_ context.Context, workerID string, capacity int) ([]AttemptClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	free := min(capacity, s.capacity-s.active)
	if free <= 0 {
		return nil, nil
	}
	var due []*fakeAttempt
	for _, a := range s.attempts {
		if a.status == AttemptStatusQueued && !a.scheduledAt.After(time.Now()) {
			due = append(due, a)
		}
	}
	sort.SliceStable(due, func(i, j int) bool {
		if due[i].priority != due[j].priority {
			return due[i].priority > due[j].priority
		}
		if !due[i].scheduledAt.Equal(due[j].scheduledAt) {
			return due[i].scheduledAt.Before(due[j].scheduledAt)
		}
		return due[i].id < due[j].id
	})
	if len(due) == 0 {
		return nil, nil
	}
	due = due[:min(free, len(due))]
	s.seq++ // ONE draw per claim, shared by the whole batch (§ 4 step 2)
	s.claims++
	token := s.seq
	out := make([]AttemptClaim, 0, len(due))
	for _, a := range due {
		a.status = AttemptStatusLeased
		a.workerID = workerID
		a.token = token
		s.active++
		if s.active > s.maxActive {
			s.maxActive = s.active
		}
		out = append(out, AttemptClaim{
			AttemptID: a.id, NodeExecutionID: a.nodeExecID, RunID: a.runID,
			WorkerID: workerID, FencingToken: token,
			NodeID: a.nodeID, NodeInstanceKey: a.instanceKey,
			Kind: a.kind, AttemptNumber: a.attemptNumber,
			Config: a.cfg,
		})
	}
	s.writes = append(s.writes, "claim "+workerID+" n="+strconv.Itoa(len(due))+" token="+strconv.FormatInt(token, 10))
	return out, nil
}

func (s *fakeAttemptStore) RenewAttempt(_ context.Context, c AttemptClaim) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	a.renews++
	s.writes = append(s.writes, "renew "+a.id)
	return nil
}

func (s *fakeAttemptStore) BeginAttempt(_ context.Context, c AttemptClaim) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	a.status = AttemptStatusRunning
	s.writes = append(s.writes, "begin "+a.id)
	return nil
}

func (s *fakeAttemptStore) AppendAttemptEvent(_ context.Context, c AttemptClaim, ev AttemptEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	if s.appendErr != nil {
		return s.appendErr
	}
	s.writes = append(s.writes, "event "+a.id+" "+ev.Type)
	return nil
}

func (s *fakeAttemptStore) CancelRequestedAttempt(_ context.Context, c AttemptClaim) (time.Time, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verifyTriple(c)
	if err != nil {
		return time.Time{}, false, err
	}
	if s.cancelErr != nil {
		return time.Time{}, false, s.cancelErr
	}
	s.cancelsSeen++
	switch a.status {
	case AttemptStatusLeased, AttemptStatusRunning:
	case AttemptStatusInterrupted:
		// ADR-0016 § 5's takeover arm: interrupted WITH the flag set is the
		// human's take-control, and is reported as the cancel it is.
		if a.cancelAt == nil {
			return time.Time{}, false, ErrLeaseLost
		}
		return *a.cancelAt, true, nil
	default:
		return time.Time{}, false, ErrLeaseLost
	}
	if a.cancelAt == nil {
		return time.Time{}, false, nil
	}
	return *a.cancelAt, true, nil
}

func (s *fakeAttemptStore) CompleteAttempt(_ context.Context, c AttemptClaim,
	outputs any, outputsDigest string, artifactRefs []any, outcome string, ckpt AttemptCheckpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	if s.completeErr != nil {
		return s.completeErr
	}
	// attempts_succeeded_has_outputs (01 invariant 4) and the volume
	// requirement (D-024) are real CHECKs; the fake refuses them too.
	if outputs == nil {
		return errFake("fake: succeeded attempt requires outputs (possibly {})")
	}
	if ckpt.VolumeID == "" {
		return errFake("fake: checkpoint volume_id is required")
	}
	a.status = AttemptStatusSucceeded
	a.outputs = outputs
	a.digest = outputsDigest
	a.artifactRefs = artifactRefs
	a.outcome = outcome
	cp := ckpt
	cp.WorkerID = c.WorkerID
	a.checkpoint = &cp
	a.finishedAt = time.Now()
	s.active--
	s.writes = append(s.writes, "complete "+a.id)
	return nil
}

func (s *fakeAttemptStore) FailAttempt(_ context.Context, c AttemptClaim, class, detail string, _ []any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	a.status = AttemptStatusFailed
	a.errorClass = class
	a.detail = detail
	a.finishedAt = time.Now()
	s.active--
	s.writes = append(s.writes, "fail "+a.id+" "+class)
	return nil
}

func (s *fakeAttemptStore) InterruptAttemptOwn(_ context.Context, c AttemptClaim, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	a.status = AttemptStatusInterrupted
	a.detail = reason
	a.finishedAt = time.Now()
	s.active--
	s.writes = append(s.writes, "interrupt "+a.id+" "+reason)
	return nil
}

func (s *fakeAttemptStore) CancelAttemptOwn(_ context.Context, c AttemptClaim, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.verify(c)
	if err != nil {
		return err
	}
	a.status = AttemptStatusCancelled
	a.errorClass = ErrorClassCancelled
	a.detail = reason
	a.finishedAt = time.Now()
	s.active--
	s.writes = append(s.writes, "cancel "+a.id+" "+reason)
	return nil
}

// Test hooks (never called by the loop):

// steal simulates a newer owner taking the attempt: a strictly greater
// fencing token, drawn from the same sequence (§ 4 step 2, `12` case 3).
func (s *fakeAttemptStore) steal(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.find(id)
	s.seq++
	a.token = s.seq
	a.workerID = "worker-thief"
	s.active--
	s.writes = append(s.writes, "steal "+id)
}

func (s *fakeAttemptStore) setCancel(id string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.find(id)
	a.cancelAt = &at
}

func (s *fakeAttemptStore) snapshot(id string) fakeAttempt {
	s.mu.Lock()
	defer s.mu.Unlock()
	return *s.find(id)
}

func (s *fakeAttemptStore) writeLog() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.writes...)
}

func (s *fakeAttemptStore) counts() (claims, active, maxActive int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.claims, s.active, s.maxActive
}

type errFake string

func (e errFake) Error() string { return string(e) }

// ------------------------------------------------------------- test helpers

// execFn adapts a function to AttemptExecutor.
type execFn func(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error)

func (f execFn) Execute(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
	return f(ctx, c, sink)
}

func okResult() AttemptResult {
	digest := "sha256:" + strings.Repeat("a", 64)
	return AttemptResult{
		Status:        AttemptStatusSucceeded,
		Outputs:       map[string]any{"ok": true},
		OutputsDigest: digest,
		Outcome:       "passed",
		Checkpoint: AttemptCheckpoint{
			InputsDigest: digest, OutputsDigest: digest,
			WorkspaceID: "ws-1", VolumeID: "vol-a", PlanDigest: digest,
		},
	}
}

// stoppable executor: finishes honestly the moment drain asks.
func finishingExecutor(res AttemptResult) execFn {
	return func(_ context.Context, _ AttemptClaim, sink AttemptSink) (AttemptResult, error) {
		<-sink.Stopping()
		return res, nil
	}
}

// parked executor: does not return until its context is cancelled, then it
// reports nothing honest (the loop's flags decide).
func parkedExecutor() execFn {
	return func(ctx context.Context, _ AttemptClaim, _ AttemptSink) (AttemptResult, error) {
		<-ctx.Done()
		return AttemptResult{}, nil
	}
}

func fastAttemptConfig(capacity int) AttemptConfig {
	return AttemptConfig{
		Capacity:      capacity,
		ClaimInterval: 2 * time.Millisecond,
		RenewInterval: 2 * time.Millisecond,
		CancelPoll:    2 * time.Millisecond,
		DrainGrace:    5 * time.Second,
	}
}

func startLoop(t *testing.T, l *AttemptLoop) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- l.Start(ctx) }()
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dcancel()
		if err := l.Drain(dctx); err != nil {
			t.Errorf("drain in cleanup: %v", err)
		}
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Start: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("attempt loop did not exit")
		}
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("condition not met: %s", what)
}

func newLoop(t *testing.T, store *fakeAttemptStore, execs AttemptExecutors, capacity int) *AttemptLoop {
	t.Helper()
	l, err := NewAttemptLoop(fastAttemptConfig(capacity), store, execs,
		func() string { return "worker-1" },
		WithAttemptLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
	if err != nil {
		t.Fatalf("NewAttemptLoop: %v", err)
	}
	return l
}

// -------------------------------------------------------------- the tests

// TestAttemptClaimBatchHonoursCapacity: batch = free capacity, one fencing
// draw per claim, a strictly greater token for the next claim, and no
// attempt claimed while every slot is busy (§ 4 steps 1–2).
func TestAttemptClaimBatchHonoursCapacity(t *testing.T) {
	store := newFakeAttemptStore(2)
	now := time.Now()
	store.queue("a1", "process.exec", 0, now)
	store.queue("a2", "process.exec", 5, now)
	store.queue("a3", "process.exec", 0, now.Add(time.Millisecond))

	release := make(chan struct{})
	var mu sync.Mutex
	started := map[string]bool{}
	exec := execFn(func(ctx context.Context, c AttemptClaim, _ AttemptSink) (AttemptResult, error) {
		mu.Lock()
		started[c.AttemptID] = true
		mu.Unlock()
		select {
		case <-release:
		case <-ctx.Done():
			return AttemptResult{}, nil
		}
		return okResult(), nil
	})

	l := newLoop(t, store, AttemptExecutors{"process.exec": exec}, 2)
	startLoop(t, l)

	waitFor(t, "two attempts in flight", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(started) == 2
	})
	time.Sleep(30 * time.Millisecond) // a few ticks
	if a := store.snapshot("a3"); a.status != AttemptStatusQueued {
		t.Fatalf("a3 left the queue while capacity was full: %+v", a)
	}
	if _, active, maxActive := store.counts(); active != 2 || maxActive > 2 {
		t.Fatalf("active=%d maxActive=%d, want 2/<=2", active, maxActive)
	}

	// The batch shared ONE token, drawn from one sequence step.
	first := store.snapshot("a1")
	second := store.snapshot("a2")
	if first.token != second.token {
		t.Fatalf("batch tokens differ (%d vs %d): the sequence must be drawn once per claim", first.token, second.token)
	}
	if claims, _, _ := store.counts(); claims != 1 {
		t.Fatalf("claims=%d, want 1 for one batch", claims)
	}

	close(release)
	waitFor(t, "first batch terminal", func() bool { return l.attemptsCompleted() >= 2 })

	// Freed slots attract the remaining attempt with a NEW, greater token.
	waitFor(t, "a3 terminal", func() bool { return store.snapshot("a3").finishedAt.Nanosecond() != 0 })
	third := store.snapshot("a3")
	if third.token <= first.token {
		t.Fatalf("replacement claim token %d not greater than %d", third.token, first.token)
	}
	for _, a := range []fakeAttempt{store.snapshot("a1"), store.snapshot("a2"), third} {
		if a.status != AttemptStatusSucceeded {
			t.Fatalf("attempt %s status %s, want succeeded", a.id, a.status)
		}
	}
	if _, active, _ := store.counts(); active != 0 {
		t.Fatalf("active_attempts=%d after terminals, want 0 (decrement only after terminal commits)", active)
	}
}

// TestAttemptRenewThenComplete exercises the happy path: begin fenced, the
// per-attempt renew tick live for the whole body, and the boundary
// transaction (outputs, digest, outcome, checkpoint) as the single terminal
// write (§ 4 steps 6 and 10).
func TestAttemptRenewThenComplete(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queue("a1", "process.exec", 0, time.Now())

	exec := execFn(func(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
		// Run at least two full renew ticks before speaking, and use the
		// sink for one fenced journal append on the way.
		for store.snapshot(c.AttemptID).renews < 2 {
			select {
			case <-ctx.Done():
				return AttemptResult{}, ctx.Err()
			case <-time.After(time.Millisecond):
			}
		}
		if err := sink.AppendEvent(ctx, AttemptEvent{
			Type: "node.attempt.progress", ActorKind: "worker", ActorID: "worker-1",
		}); err != nil {
			return AttemptResult{}, err
		}
		return okResult(), nil
	})

	l := newLoop(t, store, AttemptExecutors{"process.exec": exec}, 1)
	startLoop(t, l)
	waitFor(t, "attempt terminal", func() bool { return l.attemptsCompleted() >= 1 })

	a := store.snapshot("a1")
	if a.status != AttemptStatusSucceeded {
		t.Fatalf("status %s, want succeeded (detail %q class %q)", a.status, a.detail, a.errorClass)
	}
	if a.renews < 2 {
		t.Fatalf("renews=%d, want >=2", a.renews)
	}
	if a.digest == "" || a.checkpoint == nil || a.checkpoint.VolumeID != "vol-a" {
		t.Fatalf("boundary transaction incomplete: digest=%q checkpoint=%+v", a.digest, a.checkpoint)
	}
	if a.outcome != "passed" {
		t.Fatalf("outcome %q, want passed", a.outcome)
	}

	log := store.writeLog()
	// begin → renews (+ the fenced event) → exactly ONE terminal write.
	if log[0] != "claim worker-1 n=1 token=1" || !strings.HasPrefix(log[1], "begin ") {
		t.Fatalf("claim/begin not first: %v", log)
	}
	terminals := 0
	for _, e := range log {
		if strings.HasPrefix(e, "complete ") || strings.HasPrefix(e, "fail ") ||
			strings.HasPrefix(e, "cancel ") || strings.HasPrefix(e, "interrupt ") {
			terminals++
		}
	}
	if terminals != 1 || !strings.HasPrefix(log[len(log)-1], "complete ") {
		t.Fatalf("want exactly one terminal write, last: %v", log)
	}
	if !strings.Contains(strings.Join(log, "\n"), "event a1 node.attempt.progress") {
		t.Fatalf("fenced journal append missing: %v", log)
	}
}

// TestAttemptStaleTokenStopsImmediately is `12` case 3 at the loop level: a
// renew rejected on the fence is the authoritative word that we are stale —
// the attempt stops writing entirely (no terminal, no event, nothing after
// the steal).
func TestAttemptStaleTokenStopsImmediately(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queue("a1", "process.exec", 0, time.Now())

	l := newLoop(t, store, AttemptExecutors{"process.exec": parkedExecutor()}, 1)
	startLoop(t, l)

	waitFor(t, "attempt live and renewing", func() bool { return store.snapshot("a1").renews >= 1 })
	store.steal("a1")
	waitFor(t, "stale attempt stops", func() bool { return l.attemptsCompleted() >= 1 })
	time.Sleep(30 * time.Millisecond) // a few ticks: nothing more may land

	log := store.writeLog()
	stealAt := -1
	for i, e := range log {
		if strings.HasPrefix(e, "steal ") {
			stealAt = i
		}
	}
	if stealAt < 0 {
		t.Fatalf("steal not logged: %v", log)
	}
	for _, e := range log[stealAt+1:] {
		if strings.Contains(e, "a1") {
			t.Fatalf("write %q landed after the fence rejected us: %v", e, log)
		}
	}
	if a := store.snapshot("a1"); a.workerID != "worker-thief" ||
		strings.HasPrefix(a.status, "succe") || a.finishedAt.Nanosecond() != 0 {
		t.Fatalf("stale worker wrote a terminal or disturbed the new owner: %+v", a)
	}
}

// lockedBuf collects slog output that a loop goroutine may still be writing
// while the test reads it.
type lockedBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// fenceRefusalLine returns the ONE warn line C4c demands — the stale owner
// observing its own fenced write refused — or "" when absent. The words are
// what the lab driver greps for (e2e/m4 FENCE_REFUSAL_RE:
// 'stale (owner|token)|fenc|lease lost').
func fenceRefusalLine(logs string) string {
	for _, ln := range strings.Split(logs, "\n") {
		low := strings.ToLower(ln)
		if strings.Contains(low, "fenced write refused") {
			return ln
		}
	}
	return ""
}

func assertC4cRefusalLine(t *testing.T, logs string) {
	t.Helper()
	ln := fenceRefusalLine(logs)
	if ln == "" {
		t.Fatalf("no fence-refusal line in the worker's own log:\n%s", logs)
	}
	for _, want := range []string{"attempt_id=a1", "fencing_token=", "stale owner", "lease lost"} {
		if !strings.Contains(ln, want) {
			t.Fatalf("refusal line %q lacks %q", ln, want)
		}
	}
}

// TestAttemptFencedCancelWatchRefusalIsLogged is C4c at the loop level on
// the path the live pause/unpause actually takes: the wake-up's next fenced
// read (the cancel watch) is refused by the store, and the refusal must be
// OBSERVED in the worker's own log — never a silent stop (contract § 7.1
// C4c, `12` case 3).
func TestAttemptFencedCancelWatchRefusalIsLogged(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queue("a1", "process.exec", 0, time.Now())

	var logs lockedBuf
	l, err := NewAttemptLoop(fastAttemptConfig(1), store,
		AttemptExecutors{"process.exec": parkedExecutor()},
		func() string { return "worker-1" },
		WithAttemptLogger(slog.New(slog.NewTextHandler(&logs, nil))))
	if err != nil {
		t.Fatalf("NewAttemptLoop: %v", err)
	}
	startLoop(t, l)

	waitFor(t, "attempt began", func() bool { return store.snapshot("a1").status == AttemptStatusRunning })
	store.mu.Lock()
	store.cancelErr = ErrLeaseLost // a newer owner has drawn a greater token
	store.mu.Unlock()
	waitFor(t, "fenced watch stops the attempt", func() bool { return l.attemptsCompleted() >= 1 })

	assertC4cRefusalLine(t, logs.String())
	if a := store.snapshot("a1"); a.finishedAt.Nanosecond() != 0 || a.outputs != nil {
		t.Fatalf("stale worker wrote a terminal after the refusal: %+v", a)
	}
}

// TestAttemptFencedAppendRefusalIsLogged covers the second silent
// observation point: a live journal append refused by the fence (contract
// § 4 step 6's sink rule) must log the refusal and stop the body.
func TestAttemptFencedAppendRefusalIsLogged(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queue("a1", "process.exec", 0, time.Now())
	store.mu.Lock()
	store.appendErr = ErrLeaseLost
	store.mu.Unlock()

	exec := execFn(func(ctx context.Context, _ AttemptClaim, sink AttemptSink) (AttemptResult, error) {
		if err := sink.AppendEvent(ctx, AttemptEvent{Type: "node.scope.progress"}); !errors.Is(err, ErrLeaseLost) {
			t.Errorf("AppendEvent under a refused fence: %v", err)
		}
		<-ctx.Done() // the sink's refusal must stop the body
		return AttemptResult{}, nil
	})

	var logs lockedBuf
	l, err := NewAttemptLoop(fastAttemptConfig(1), store,
		AttemptExecutors{"process.exec": exec},
		func() string { return "worker-1" },
		WithAttemptLogger(slog.New(slog.NewTextHandler(&logs, nil))))
	if err != nil {
		t.Fatalf("NewAttemptLoop: %v", err)
	}
	startLoop(t, l)
	waitFor(t, "refused append stops the attempt", func() bool { return l.attemptsCompleted() >= 1 })

	assertC4cRefusalLine(t, logs.String())
	if a := store.snapshot("a1"); a.finishedAt.Nanosecond() != 0 {
		t.Fatalf("stale worker wrote a terminal after the refusal: %+v", a)
	}
}

// TestAttemptCancelRequestedClosesCancelled is § 4 step 11's honest close:
// the flag is observed on the watch tick, the body is stopped, and the
// attempt is terminalised cancelled (never silently dropped).
func TestAttemptCancelRequestedClosesCancelled(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queue("a1", "process.exec", 0, time.Now())

	l := newLoop(t, store, AttemptExecutors{"process.exec": parkedExecutor()}, 1)
	startLoop(t, l)

	waitFor(t, "attempt began", func() bool { return store.snapshot("a1").status == AttemptStatusRunning })
	store.setCancel("a1", time.Now())
	waitFor(t, "attempt cancelled", func() bool { return l.attemptsCompleted() >= 1 })

	a := store.snapshot("a1")
	if a.status != AttemptStatusCancelled {
		t.Fatalf("status %s, want cancelled", a.status)
	}
	if a.errorClass != ErrorClassCancelled || a.detail != CancelReasonACPAck {
		t.Fatalf("class %q reason %q, want cancelled/acp_cancel_ack", a.errorClass, a.detail)
	}
	if _, active, _ := store.counts(); active != 0 {
		t.Fatalf("active slot not released after cancel terminal: %v", store.writeLog())
	}
}

// TestAttemptDrainStopsClaimingFinishesInFlight is § 4 step 12's first half:
// claims stop, attempts already under way get the graceful ask and are
// allowed to land HONEST terminals (succeeded, not interrupted) inside the
// grace window; the queued attempt is never claimed.
func TestAttemptDrainStopsClaimingFinishesInFlight(t *testing.T) {
	store := newFakeAttemptStore(2)
	now := time.Now()
	store.queue("a1", "process.exec", 0, now)
	store.queue("a2", "process.exec", 0, now)
	store.queue("a3", "process.exec", 0, now)

	l := newLoop(t, store, AttemptExecutors{"process.exec": finishingExecutor(okResult())}, 2)
	startLoop(t, l)

	waitFor(t, "both slots busy", func() bool {
		_, active, _ := store.counts()
		return active == 2
	})

	dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dcancel()
	drainErr := make(chan error, 1)
	go func() { drainErr <- l.Drain(dctx) }()

	// Drain must stop claims while we wait: give the claim tick time to
	// (not) fire.
	time.Sleep(30 * time.Millisecond)
	if err := <-drainErr; err != nil {
		t.Fatalf("drain: %v", err)
	}
	if claims, _, _ := store.counts(); claims != 1 {
		t.Fatalf("claims=%d, want 1 (no claiming after drain)", claims)
	}
	if a := store.snapshot("a3"); a.status != AttemptStatusQueued {
		t.Fatalf("a3 status %s, still queued across drain", a.status)
	}
	for _, id := range []string{"a1", "a2"} {
		if a := store.snapshot(id); a.status != AttemptStatusSucceeded {
			t.Fatalf("%s status %s, want an honest succeeded inside the grace window", id, a.status)
		}
	}
}

// TestAttemptNonFenceRefusalFailsTheAttempt is the lab-pass-35 arm at loop
// level: a terminal write the store refuses for a NON-fence reason (an honest
// error, not a stale triple) must not be left to the reconciler's lease arm
// to become an interrupted/lease_expired a 30s later. The worker is standing
// here, so the worker speaks the honest word: the attempt fails (infra)
// with the store's bounded message, at once.
func TestAttemptNonFenceRefusalFailsTheAttempt(t *testing.T) {
	store := newFakeAttemptStore(1)
	store.queue("a1", "process.exec", 0, time.Now())
	store.completeErr = errFake("postgres: the boundary transaction lost a row lock")

	exec := execFn(func(ctx context.Context, c AttemptClaim, sink AttemptSink) (AttemptResult, error) {
		return okResult(), nil
	})
	l := newLoop(t, store, AttemptExecutors{"process.exec": exec}, 1)
	startLoop(t, l)
	waitFor(t, "honest fail terminal", func() bool {
		a := store.snapshot("a1")
		return a.status == AttemptStatusSucceeded || a.status == AttemptStatusFailed
	})

	a := store.snapshot("a1")
	if a.status != AttemptStatusFailed || a.errorClass != ErrorClassInfra {
		t.Fatalf("attempt = %s/%s, want failed/infra (a non-fence refusal is a live failure, not a 30s interruption)",
			a.status, a.errorClass)
	}
	if !strings.Contains(a.detail, "lost a row lock") {
		t.Fatalf("detail %q must carry the store's bounded message, so the run sees WHY", a.detail)
	}
	log := store.writeLog()
	if len(log) == 0 || !strings.HasPrefix(log[len(log)-1], "fail a1 infra") {
		t.Fatalf("the honest fail must be the LAST write (the refused complete never lands), log: %v", log)
	}
	// The slot came back in the terminal write, not the reconciler's arm.
	if _, active, _ := store.counts(); active != 0 {
		t.Fatalf("active_attempts=%d after the honest fail, want 0", active)
	}
}
