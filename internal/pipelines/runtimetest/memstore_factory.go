package runtimetest

import (
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// MemStoreFactory implements Factory over runtime.MemStore — the reference
// Store (store.go:42). The Postgres adapter implements the same Factory so
// the identical suite certifies it (docs/m4-contract.md § 8's integration —
// DB row: "the two-claim race", "advancer idempotence", "approval CAS").
type MemStoreFactory struct{}

// Open implements Factory.
func (MemStoreFactory) Open(t *testing.T, cfg Config) Session {
	t.Helper()
	prog := preparePlan(t, cfg.Pipeline)
	adv := &runtime.Advancer{Prog: prog, Deps: cfg.Deps}
	ms := runtime.NewMemStore(adv)
	var mu sync.Mutex
	now := cfg.Start
	if now.IsZero() {
		now = Epoch
	}
	ms.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	if cfg.Lease > 0 {
		ms.Lease = cfg.Lease
	}
	inputs := cfg.Inputs
	if inputs == nil {
		inputs = defaultInputs()
	}
	run := &runtime.Run{
		ID: "r1", OrganizationID: "org1", ProjectID: "prj1",
		PipelineID: "pipe1", RevisionID: "rev1",
		RevisionDigest: "sha256:" + rep("a", 64),
		PlanDigest:     "sha256:" + rep("b", 64),
		Status:         runtime.RunQueued,
		Inputs:         inputs,
		CreatedAt:      now,
	}
	ms.AddRun(runtime.NewState(run))
	return &memSession{t: t, ms: ms, prog: prog, runID: run.ID, setNow: func(at time.Time) {
		mu.Lock()
		defer mu.Unlock()
		now = at
	}, getNow: ms.Now}
}

type memSession struct {
	t      *testing.T
	ms     *runtime.MemStore
	prog   *runtime.Program
	runID  string
	setNow func(time.Time)
	getNow func() time.Time
}

func (s *memSession) RunID() string              { return s.runID }
func (s *memSession) Store() runtime.Store       { return s.ms }
func (s *memSession) Program() *runtime.Program  { return s.prog }
func (s *memSession) Now() time.Time             { return s.getNow() }
func (s *memSession) SetNow(at time.Time)        { s.setNow(at) }
func (s *memSession) Advance() error             { return s.ms.Advance(s.runID) }
func (s *memSession) NextDue() (time.Time, bool) { return s.ms.NextDue(s.runID) }

func (s *memSession) State(t *testing.T) *runtime.State {
	t.Helper()
	st, ok := s.ms.Peek(s.runID)
	if !ok {
		t.Fatalf("run %s is not registered in the store", s.runID)
	}
	return st
}

func (s *memSession) Events(t *testing.T) []pevents.Record {
	t.Helper()
	return snapshot(s.State(t).Events)
}

func (s *memSession) Claim(workerID string) (*runtime.Attempt, error) {
	return s.ms.Claim(s.runID, workerID)
}

func (s *memSession) Start(attemptID, workerID string, token int64) error {
	return s.ms.Start(s.runID, attemptID, workerID, token)
}

func (s *memSession) Renew(attemptID, workerID string, token int64) error {
	return s.ms.Renew(s.runID, attemptID, workerID, token)
}

func (s *memSession) Complete(attemptID, workerID string, token int64, c Completion) error {
	return s.ms.Complete(s.runID, attemptID, workerID, token,
		c.Outputs, c.OutputsDigest, c.ArtifactRefs, c.Outcome, c.Checkpoint)
}

func (s *memSession) Fail(attemptID, workerID string, token int64, class, detail string) error {
	return s.ms.Fail(s.runID, attemptID, workerID, token, class, detail, nil)
}

func (s *memSession) Interrupt(attemptID, reason string) error {
	return s.ms.Interrupt(s.runID, attemptID, reason)
}

func (s *memSession) ReconcileLeases() error    { return s.ms.ReconcileLeases(s.runID) }
func (s *memSession) ReconcileDeadlines() error { return s.ms.ReconcileDeadlines(s.runID) }

func (s *memSession) Decide(d GateDecision) error {
	return s.ms.Decide(s.runID, d.ApprovalID, d.Decision, d.Comments, d.Decider, d.Version, d.Authorize)
}

func (s *memSession) Retry(requestedBy string, targets []string, overrides map[string]any) error {
	return s.ms.Retry(s.runID, requestedBy, targets, overrides)
}

// preparePlan compiles an embedded fixture the way a publish does (loader →
// canonical schema → compiler): the suite drives real plans, never Go-built
// fakes (harness_test.go's promise, kept here for plugged-in stores).
func preparePlan(t *testing.T, name Pipeline) *runtime.Program {
	t.Helper()
	b := pipelineYAML(name)
	if b == nil {
		t.Fatalf("unknown pipeline %q", name)
	}
	doc, d := loader.Load(b)
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	if d := schema.MustCompile().Validate(doc.Value); !d.Valid() {
		t.Fatalf("schema: %v", d)
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("compiler: %v", d)
	}
	prog, d := runtime.PreparePlan(plan)
	if !d.Valid() {
		t.Fatalf("PreparePlan: %v", d)
	}
	return prog
}
