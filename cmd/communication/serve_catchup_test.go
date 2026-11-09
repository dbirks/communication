package main

// Tests for the catch-up tour generator's tunable knobs
// (COMMUNICATION_CATCHUP_GEN_COOLDOWN, COMMUNICATION_CATCHUP_GEN_PER_10M).
// The rule these knobs ship with is that they are the ONLY serve durations
// that never refuse startup: unset, negative and unparseable all land on the
// generator's own defaults, because they guard a model from a page-load
// storm rather than deciding any behaviour an operator depends on. The cap's
// one meaningful literal is 0 — that is the deployment saying "generate
// nothing at all". Hermetic: no pool, no goroutine, just the parsers and the
// stack fields they feed.

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/assistant"
	"github.com/dbirks/communication/internal/store/postgres"
)

func TestServeCatchUpGenCooldownParse(t *testing.T) {
	env := func(value string) func(string) string {
		return func(name string) string {
			if name != envCatchUpGenCooldown {
				return ""
			}
			return value
		}
	}
	for _, tt := range []struct {
		raw  string
		want time.Duration
	}{
		{"", assistant.CatchUpGenCooldown},            // unset: the 10 min default
		{"   ", assistant.CatchUpGenCooldown},         // whitespace is unset
		{"20s", 20 * time.Second},                     // the lab's value
		{"90s", 90 * time.Second},                     // any positive duration
		{"1h30m", 90 * time.Minute},                   // compound spelling
		{"0", assistant.CatchUpGenCooldown},           // 0 falls back, never disables
		{"0s", assistant.CatchUpGenCooldown},          // and so does the duration form
		{"-5s", assistant.CatchUpGenCooldown},         // negative: the default, not a refusal
		{"ten minutes", assistant.CatchUpGenCooldown}, // unparseable: the default
		{"10", assistant.CatchUpGenCooldown},          // a bare number has no unit: the default
		{"10x", assistant.CatchUpGenCooldown},         // a typo'd unit: the default
		{" 30s ", 30 * time.Second},                   // padded but valid
	} {
		if got := serveCatchUpGenCooldown(env(tt.raw)); got != tt.want {
			t.Errorf("%s=%q -> %s, want %s", envCatchUpGenCooldown, tt.raw, got, tt.want)
		}
	}
}

// TestServeCatchUpGenCooldownDefaultsStackField pins the other half of the
// wiring: a stack built without the variable (every existing stack test)
// carries zero, and BuildCatchUpGenerator hands that zero to the generator,
// which resolves it to its own default rather than a no-cooldown hammer.
func TestServeCatchUpGenCooldownDefaultsStackField(t *testing.T) {
	var d serveStackDeps
	if d.CatchUpGenCooldown != 0 {
		t.Fatalf("a zero-value stack asked for %s", d.CatchUpGenCooldown)
	}
	if got := serveCatchUpGenCooldown(func(string) string { return "" }); got != assistant.CatchUpGenCooldown {
		t.Errorf("unset -> %s, want the generator's own %s", got, assistant.CatchUpGenCooldown)
	}
}

func TestServeCatchUpGenPer10MParse(t *testing.T) {
	env := func(value string) func(string) string {
		return func(name string) string {
			if name != envCatchUpGenPer10M {
				return ""
			}
			return value
		}
	}
	for _, tt := range []struct {
		raw  string
		want int
	}{
		{"", assistant.CatchUpGenMaxModelCallsPerWindow},    // unset: the six default
		{"   ", assistant.CatchUpGenMaxModelCallsPerWindow}, // whitespace is unset
		{"6", 6},   // the lab's explicit value
		{"12", 12}, // any positive count
		{"0", 0},   // 0 is the off switch, not the default
		{"00", 0},  // and so is its padded spelling
		{"-1", assistant.CatchUpGenMaxModelCallsPerWindow},  // negative: the default, not off
		{"six", assistant.CatchUpGenMaxModelCallsPerWindow}, // unparseable: the default
		{"10m", assistant.CatchUpGenMaxModelCallsPerWindow}, // a duration is not a count
		{" 3 ", 3}, // padded but valid
		{"1.5", assistant.CatchUpGenMaxModelCallsPerWindow}, // fractional calls are not calls
	} {
		if got := serveCatchUpGenPer10M(env(tt.raw)); got != tt.want {
			t.Errorf("%s=%q -> %d, want %d", envCatchUpGenPer10M, tt.raw, got, tt.want)
		}
	}
}

// TestServeCatchUpGenPer10MStackField pins the wiring: the zero-value stack
// (every existing stack test) carries a nil pointer — "nobody said
// anything", which BuildCatchUpGenerator hands on as the generator's own
// default — while runServe always resolves the variable to an int and hands
// its address, so an explicit 0 reaches the generator as 0.
func TestServeCatchUpGenPer10MStackField(t *testing.T) {
	var d serveStackDeps
	if d.CatchUpGenPer10M != nil {
		t.Fatalf("a zero-value stack said %d, want nil (the generator's default)", *d.CatchUpGenPer10M)
	}
	if got := serveCatchUpGenPer10M(func(string) string { return "" }); got != assistant.CatchUpGenMaxModelCallsPerWindow {
		t.Errorf("unset -> %d, want the generator's own %d", got, assistant.CatchUpGenMaxModelCallsPerWindow)
	}
	if got := serveCatchUpGenPer10M(func(string) string { return "0" }); got != 0 {
		t.Errorf("0 -> %d, want 0 (generation disabled)", got)
	}
}

// --- the completion sweep (ADR-0078 § Trigger) ---------------------------

func TestServeCatchUpGenSweepParse(t *testing.T) {
	env := func(value string) func(string) string {
		return func(name string) string {
			if name != envCatchUpGenSweep {
				return ""
			}
			return value
		}
	}
	for _, tt := range []struct {
		raw  string
		want time.Duration
	}{
		{"", 2 * time.Minute},       // unset: the 2m default
		{"   ", 2 * time.Minute},    // whitespace is unset
		{"30s", 30 * time.Second},   // the lab's cadence
		{"0", 0},                    // 0 disables the sweep, visits still generate
		{"0s", 0},                   // and so does the duration spelling
		{" 5m ", 5 * time.Minute},   // padded but valid
		{"-5s", 2 * time.Minute},    // negative: the default, not a refusal
		{"hourly", 2 * time.Minute}, // unparseable: the default
		{"10", 2 * time.Minute},     // a bare number has no unit: the default
	} {
		if got := serveCatchUpGenSweep(env(tt.raw)); got != tt.want {
			t.Errorf("%s=%q -> %s, want %s", envCatchUpGenSweep, tt.raw, got, tt.want)
		}
	}
}

// A zero-value stack never sweeps: every existing stack test carries the
// zero, and runServe resolves the default (or the explicit 0) BEFORE building
// the stack — the purge tick's rule, reused because the reason is the same
// (no surprise timer against a pool a test cannot reach).
func TestServeCatchUpGenSweepDefaultsStackField(t *testing.T) {
	var d serveStackDeps
	if d.CatchUpGenSweep != 0 {
		t.Fatalf("a zero-value stack asked for %s", d.CatchUpGenSweep)
	}
	if got := serveCatchUpGenSweep(func(string) string { return "" }); got != defaultCatchUpGenSweepT {
		t.Errorf("unset -> %s, want the 2m default", got)
	}
	var stdout, stderr bytes.Buffer
	if got := runServe(context.Background(), []string{"--help"}, &stdout, &stderr); got != 0 {
		t.Fatalf("runServe(--help) = %d, want 0", got)
	}
	if !strings.Contains(stdout.String(), envCatchUpGenSweep) {
		t.Errorf("usage text does not document %s", envCatchUpGenSweep)
	}
}

// recordingSweeper is the catchUpSweeper double: it counts sweeps, can panic
// on schedule, and signals each call.
type recordingSweeper struct {
	mu      sync.Mutex
	calls   int
	panics  map[int]bool
	called  chan struct{}
	lastCtx context.Context
}

func (r *recordingSweeper) CatchUpCompletionSweep(ctx context.Context) {
	r.mu.Lock()
	r.calls++
	n := r.calls
	r.lastCtx = ctx
	p := r.panics[n]
	r.mu.Unlock()
	select {
	case r.called <- struct{}{}:
	default:
	}
	if p {
		panic("sweep exploded")
	}
}

func (r *recordingSweeper) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// --- the patch-artifact source (ADR-0078 § Patch artifacts wiring) ------

// TestServeCatchUpPatchSourceNeedsAnArtifactBackend pins the serve wiring call
// site: the tour generator's diff reader is built from the SAME artifact list
// store the routes use and the process's artifact byte backend. With a
// backend mounted the generator gets a non-nil source (the tour may cite
// diffs); with none it gets nil — the honest "this deployment records no
// patches", never a tour that invents a hunk.
func TestServeCatchUpPatchSourceNeedsAnArtifactBackend(t *testing.T) {
	// The backend refuses an agent-writable $TMPDIR root (ADR-0019 P9), so the
	// test root lives in the same lab scratch the workspace git fixtures use.
	scratch := os.Getenv("COMMUNICATION_LAB_SCRATCH")
	if scratch == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("no home directory for lab scratch: %v", err)
		}
		scratch = filepath.Join(home, ".cache", "communication-lab", "go-test")
	}
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(scratch, t.Name()+"-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	local, err := artifacts.NewLocal(artifacts.LocalConfig{Root: root, ReadOnly: true})
	if err != nil {
		t.Fatalf("local artifact backend: %v", err)
	}
	// The zero-value store is enough to prove the call's shape: the wiring
	// compiles against the same concrete type runServe builds (postgres.
	// APIArtifactStore) and the seam accepts it.
	var store postgres.APIArtifactStore
	var src api.CatchUpPatchSource = catchUpPatchSource(store, local)
	if src == nil {
		t.Fatal("a configured artifact backend produced a nil patch source")
	}
	var none artifacts.Store
	if src := catchUpPatchSource(store, none); src != nil {
		t.Fatalf("a deployment with no artifact byte backend got a patch source (%v), want nil", src)
	}
}

// TestRunCatchUpGenSweeperKeepsTickingThroughPanics: the loop's whole contract

// against a recorder — it beats, it survives a panicking pass, and ctx
// cancellation ends it cleanly. A sweep loop that died quietly is the T13 bug
// wearing new clothes: finished runs silently never get stories.
func TestRunCatchUpGenSweeperKeepsTickingThroughPanics(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	sw := &recordingSweeper{panics: map[int]bool{2: true}, called: make(chan struct{}, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runCatchUpGenSweeper(ctx, sw, 5*time.Millisecond, log) }()
	for i := 0; i < 3; i++ {
		select {
		case <-sw.called:
		case <-time.After(2 * time.Second):
			t.Fatalf("sweep %d never happened (calls=%d)", i+1, sw.count())
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runCatchUpGenSweeper after cancel = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runCatchUpGenSweeper did not return after cancel")
	}
	if !strings.Contains(logs.String(), "catch-up sweep panicked") {
		t.Errorf("the panic was not logged:\n%s", logs.String())
	}
	if sw.count() < 3 {
		t.Errorf("sweeps = %d, want the loop to tick past the panic", sw.count())
	}
	if err := runCatchUpGenSweeper(context.Background(), nil, time.Minute, nil); err == nil ||
		!strings.Contains(err.Error(), "no generator") {
		t.Fatalf("runCatchUpGenSweeper(nil) = %v, want a refusal naming the missing generator", err)
	}
}
