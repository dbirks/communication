package worker

// The same race, watched from the call sites. internal/sandbox/nono's
// profile_slot_test.go proves the mechanism (a slot is private; a shared policy
// file is adopted or refused, never replaced); this file proves the WORKER uses
// it: two attempts on one worker each launch under a policy file that belongs to
// the attempt whose argv names it, and the file is gone when the attempt is.
//
// The barrier in pairSandbox is the point. It forces the lab's exact window —
// every concurrent unit has written its policy, and only then does any of them
// assert the bytes — so the test cannot pass by an accident of scheduling. A
// foreign writer is planted at the legacy shared name while the units sit at the
// barrier: that is the other turn, or the doctor, or a worker booted with a
// different COMMUNICATION_AGENT_EGRESS_ALLOW, which used to break them.

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

const (
	raceAttemptA = "aaaaaaaa-1111-4111-8111-111111111111"
	raceAttemptB = "bbbbbbbb-2222-4222-8222-222222222222"
	raceRunA     = "cccccccc-3333-4333-8333-333333333333"
	raceRunB     = "dddddddd-4444-4444-8444-444444444444"
)

func raceLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// pairSandbox is the AgentSandbox seam with a barrier for n concurrent units.
// Each unit arrives here AFTER its profile has been materialized (openUnitProfile
// runs before Verify in every executor), waits until all n have written, then
// asserts its own bytes and answers the way the real launcher would.
type pairSandbox struct {
	n       int32
	count   atomic.Int32
	arrived chan struct{}
	release chan struct{}
	onLast  func()

	mu sync.Mutex
	// obs records one entry per verified launch, with its spec, the argv built
	// from it and its assertion result in ONE append: three parallel slices
	// appended at three different moments do not stay paired when two attempts
	// interleave, and a test that mismatched them would read the other
	// attempt's argv back to it.
	obs []launchObservation
}

// launchObservation is one unit's whole view of its own launch.
type launchObservation struct {
	spec      nono.LaunchSpec
	argv      string
	assertErr error
}

func newPairSandbox(n int32, onLast func()) *pairSandbox {
	return &pairSandbox{
		n:       n,
		arrived: make(chan struct{}, n),
		release: make(chan struct{}),
		onLast:  onLast,
	}
}

func (s *pairSandbox) Verify(_ context.Context, spec nono.LaunchSpec) (*nono.VerificationResult, error) {
	s.arrived <- struct{}{}
	if s.count.Add(1) == s.n {
		if s.onLast != nil {
			s.onLast()
		}
		close(s.release)
	}
	<-s.release
	// Every concurrent unit has now written its policy. This is the assertion
	// that failed on the lab, and the argv is built here for the same reason: a
	// unit's policy file is gone once the unit is over, so an argv built later
	// would be measuring a file that no longer exists.
	err := spec.Profile.AssertOwnBytes()
	argv, argvErr := spec.BuildLaunchArgv()
	joined := strings.Join(argv, " ")
	if argvErr != nil {
		joined = "argv-error: " + argvErr.Error()
	}
	s.mu.Lock()
	s.obs = append(s.obs, launchObservation{spec: spec, argv: joined, assertErr: err})
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &nono.VerificationResult{
		Backend: "nono", Version: nono.PinnedVersion, PolicyDigest: spec.Profile.Digest,
		PolicyRef: spec.Profile.Kind, AfUnixMediation: "pathname",
		NetworkEnforced: spec.Profile.NetworkEnforced, Verified: true,
	}, nil
}

func (s *pairSandbox) Probe(context.Context) (domain.SandboxCapabilities, error) {
	return domain.SandboxCapabilities{Backend: "nono", Filesystem: true, Network: true, Verified: true}, nil
}

func (s *pairSandbox) snapshot() []launchObservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]launchObservation(nil), s.obs...)
}

// syncSink is an attempt sink two concurrent attempts may write to
// (recordingSink's slice is not, and a racing test fake is a false finding).
type syncSink struct {
	mu     sync.Mutex
	events []AttemptEvent
}

func (s *syncSink) AppendEvent(_ context.Context, ev AttemptEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, ev)
	return nil
}

func (s *syncSink) Stopping() <-chan struct{} { return make(chan struct{}) }

func (s *syncSink) saw(typ string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.events {
		if e.Type == typ {
			return true
		}
	}
	return false
}

// TestConcurrentUnitProfilesOnOneWorkerArePrivate is the mechanism every
// executor uses (openUnitProfile), run for two attempts with two DIFFERENT
// policies in one worker's policy directory — the shape that produced the lab's
// digest mismatch.
func TestConcurrentUnitProfilesOnOneWorkerArePrivate(t *testing.T) {
	policyDir := t.TempDir()
	attempts := []struct {
		id    string
		hosts []string
	}{
		{raceAttemptA, []string{"api.anthropic.com"}},
		{raceAttemptB, []string{"api.openai.com"}},
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	type outcome struct {
		id  string
		up  *unitProfile
		err error
	}
	out := make(chan outcome, len(attempts))
	for _, a := range attempts {
		wg.Add(1)
		go func(a struct {
			id    string
			hosts []string
		}) {
			defer wg.Done()
			<-start
			up, err := openUnitProfile(policyDir, a.id, nono.ProfileAgentTurn, nono.NetworkAllowlisted, a.hosts)
			out <- outcome{id: a.id, up: up, err: err}
		}(a)
	}
	close(start)
	wg.Wait()
	close(out)

	results := map[string]outcome{}
	for o := range out {
		results[o.id] = o
	}
	for _, a := range attempts {
		o, ok := results[a.id]
		if !ok || o.err != nil {
			t.Fatalf("attempt %s could not materialize its policy: %v", a.id, o.err)
		}
	}
	first, second := results[raceAttemptA].up.Profile(), results[raceAttemptB].up.Profile()
	if first.Path == second.Path {
		t.Fatalf("both attempts launched under the same policy file %s", first.Path)
	}
	if filepath.Dir(first.Path) == filepath.Dir(second.Path) {
		t.Errorf("both attempts share the policy directory %s", filepath.Dir(first.Path))
	}
	if first.Digest == second.Digest {
		t.Errorf("two different policies recorded one digest %s", first.Digest)
	}
	for _, pair := range []struct {
		id   string
		prof *nono.Profile
		host string
	}{{raceAttemptA, first, "api.anthropic.com"}, {raceAttemptB, second, "api.openai.com"}} {
		// AssertOwnBytes is unchanged and still runs against the unit's own
		// file: no relaxation, no skipped check.
		if err := pair.prof.AssertOwnBytes(); err != nil {
			t.Errorf("attempt %s: %v", pair.id, err)
		}
		if !strings.Contains(pair.prof.Path, pair.id) {
			t.Errorf("attempt %s's policy path %s does not name the attempt that owns it", pair.id, pair.prof.Path)
		}
		if filepath.Base(pair.prof.Path) != nono.ProfileAgentTurn+".json" {
			t.Errorf("attempt %s lost the per-kind file name: %s", pair.id, pair.prof.Path)
		}
		data, err := os.ReadFile(pair.prof.Path)
		if err != nil {
			t.Fatalf("attempt %s: read its own policy back: %v", pair.id, err)
		}
		if !strings.Contains(string(data), pair.host) {
			t.Errorf("attempt %s's policy file does not carry its own host %q — it holds another unit's policy", pair.id, pair.host)
		}
		st, err := os.Stat(pair.prof.Path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if st.Mode().Perm()&0o222 != 0 {
			t.Errorf("the policy file %s is writable by someone other than its owner (mode %o)", pair.prof.Path, st.Mode().Perm())
		}
		if dir, derr := os.Stat(filepath.Dir(pair.prof.Path)); derr != nil {
			t.Fatalf("stat the slot dir: %v", derr)
		} else if dir.Mode().Perm() != 0o700 {
			t.Errorf("the slot dir %s has mode %o, want 0700 so no other turn (and no sandboxed child) can enter it", filepath.Dir(pair.prof.Path), dir.Mode().Perm())
		}
	}

	// Nothing at the shared per-kind name: the units never touched it, so a
	// second worker process or a doctor run cannot collide with them there.
	if _, err := os.Stat(filepath.Join(policyDir, nono.ProfileAgentTurn+".json")); !os.IsNotExist(err) {
		t.Errorf("an attempt wrote the shared path %s: %v", filepath.Join(policyDir, nono.ProfileAgentTurn+".json"), err)
	}

	for id, o := range results {
		closeUnitProfile(raceLogger(), "test", id, o.up)
	}
	entries, err := os.ReadDir(policyDir)
	if err != nil {
		t.Fatalf("read the policy dir: %v", err)
	}
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("the policy root still holds %v after both attempts closed", names)
	}
}

// TestConcurrentProcessExecAttemptsLaunchUnderTheirOwnPolicy drives two real
// process.exec attempts through ONE ProcExec (one worker) with the barrier in
// between: both policies are on disk before either is asserted, and a foreign
// writer is planted at the legacy shared name while they sit there. Neither
// attempt may notice, neither may write at the shared name, and both must remove
// what they created.
func TestConcurrentProcessExecAttemptsLaunchUnderTheirOwnPolicy(t *testing.T) {
	base := procExecScratch(t, "procexec-profile-race")
	wsRoot := filepath.Join(base, "workspaces")
	policyDir := filepath.Join(base, "policy")
	missingNono := filepath.Join(base, "no-such-nono")

	layouts := map[string]wsgit.Layout{}
	for _, runID := range []string{raceRunA, raceRunB} {
		layout, err := wsgit.LayoutOf(wsRoot, "run", runID)
		if err != nil {
			t.Fatalf("LayoutOf: %v", err)
		}
		if err := layout.Ensure(""); err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		layouts[runID] = layout
	}

	// The foreign writer: a different policy, at the path the adapter used to
	// share between every unit. It is what turn B's write used to be to turn A.
	plant := func() {
		body, err := nono.ProfileJSON(nono.ProfileCommand)
		if err != nil {
			t.Errorf("render the foreign policy: %v", err)
			return
		}
		foreign := append(body, '\n')
		foreign = append(foreign, ' ')
		if err := os.MkdirAll(policyDir, 0o700); err != nil {
			t.Errorf("plant: create the policy dir: %v", err)
			return
		}
		if err := os.WriteFile(filepath.Join(policyDir, nono.ProfileAgentTurn+".json"), foreign, 0o444); err != nil {
			t.Errorf("plant the foreign policy: %v", err)
		}
	}

	sbx := newPairSandbox(2, plant)
	proc := &ProcExec{
		WorkspaceRoot: wsRoot,
		LauncherHome:  filepath.Join(base, "launcher-home"),
		PolicyDir:     policyDir,
		Enforcement:   domain.EnforceRequired,
		Logger:        raceLogger(),
		KillGrace:     500 * time.Millisecond,
		Sandbox:       sbx,
		// The launch itself is not what this test measures (the real-nono test
		// below runs it); an unresolvable binary says so, after the policy was
		// written, verified, asserted and named in argv.
		SandboxPath: missingNono,
	}

	claim := func(attemptID, runID string) AttemptClaim {
		sh, err := exec.LookPath("sh")
		if err != nil {
			t.Fatalf("sh required to be the command: %v", err)
		}
		return AttemptClaim{
			AttemptID: attemptID, NodeExecutionID: "ne-" + attemptID,
			RunID: runID, ProjectID: "p-1", WorkerID: "worker-1", FencingToken: 1,
			NodeID: "review", NodeInstanceKey: "/review", Kind: NodeKindProcessExec,
			AttemptNumber: 1,
			Config: map[string]any{
				"argv": []any{sh, "-c", "echo reviewed"},
				"cwd":  layouts[runID].Scratch,
			},
		}
	}

	sinks := map[string]*syncSink{raceAttemptA: {}, raceAttemptB: {}}
	results := map[string]AttemptResult{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, pair := range [][2]string{{raceAttemptA, raceRunA}, {raceAttemptB, raceRunB}} {
		wg.Add(1)
		go func(attemptID, runID string) {
			defer wg.Done()
			res, err := proc.Execute(context.Background(), claim(attemptID, runID), sinks[attemptID])
			if err != nil {
				t.Errorf("attempt %s Execute: %v", attemptID, err)
			}
			mu.Lock()
			results[attemptID] = res
			mu.Unlock()
		}(pair[0], pair[1])
	}
	wg.Wait()

	obs := sbx.snapshot()
	if len(obs) != 2 {
		t.Fatalf("the worker built %d launches, want one per concurrent attempt", len(obs))
	}
	// THE finding: with a shared per-kind path, one of these was
	// "profile … changed after it was written" and the attempt closed
	// sandbox_enforcement_failed.
	for _, o := range obs {
		if o.assertErr != nil {
			t.Errorf("attempt %s's AssertOwnBytes failed while both policies were on disk: %v",
				filepath.Base(filepath.Dir(o.spec.Profile.Path)), o.assertErr)
		}
	}
	for _, attemptID := range []string{raceAttemptA, raceAttemptB} {
		if sinks[attemptID].saw(events.TypeSandboxEnforcementFailed) {
			t.Errorf("attempt %s journalled sandbox.enforcement_failed: the profile race is still live", attemptID)
		}
		if !sinks[attemptID].saw(events.TypeSandboxVerified) {
			t.Errorf("attempt %s never journalled sandbox.verified: it did not reach the launch with a verified policy", attemptID)
		}
		res := results[attemptID]
		// The attempt then stops at the missing nono binary — an infra fact,
		// stated as one, and never a sandbox refusal wearing infra's clothes.
		if res.Status != AttemptStatusFailed || !strings.Contains(res.Detail, "unable to start") {
			t.Errorf("attempt %s result = %s / %q, want the infra refusal for the missing nono binary", attemptID, res.Status, res.Detail)
		}
	}
	paths := map[string]string{}
	for _, o := range obs {
		spec := o.spec
		if spec.Profile == nil {
			t.Fatal("a launch spec reached the sandbox with no profile: ADR-0009 D4 refuses that")
		}
		owner := filepath.Base(filepath.Dir(spec.Profile.Path))
		if other, ok := paths[spec.Profile.Path]; ok {
			t.Fatalf("attempts %s and %s were handed the same policy file (%s)", other, owner, spec.Profile.Path)
		}
		paths[spec.Profile.Path] = owner
		if filepath.Base(spec.Profile.Path) != nono.ProfileCommand+".json" {
			t.Errorf("spec for %s lost the per-kind file name: %s", owner, spec.Profile.Path)
		}
		if !strings.Contains(spec.Profile.Path, "unit-") {
			t.Errorf("spec for %s is not in a unit-owned directory: %s", owner, spec.Profile.Path)
		}
		// The attempt id is in the path, so an operator reading a journal can
		// say which attempt owned which policy.
		if !strings.Contains(spec.Profile.Path, raceAttemptA) && !strings.Contains(spec.Profile.Path, raceAttemptB) {
			t.Errorf("spec path %s names no attempt, so a leftover could not be attributed", spec.Profile.Path)
		}
		// And this attempt's argv names the very file THIS attempt asserted —
		// a pairing that only means anything at the launch, which is why the
		// argv is recorded there and not rebuilt afterwards.
		if !strings.HasPrefix(o.argv, "run -s -p "+spec.Profile.Path+" ") {
			t.Errorf("attempt %s's argv does not launch under its asserted policy: %s", owner, bounded(o.argv, 240))
		}
	}

	// Both attempts are done, so both slots are gone. The only thing left in the
	// policy root is the file this test planted: no attempt ever wrote at the
	// shared per-kind name, which is why the planted policy — the lab's
	// colliding writer — could not touch either launch.
	entries, err := os.ReadDir(policyDir)
	if err != nil {
		t.Fatalf("read the policy dir: %v", err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 1 || names[0] != nono.ProfileAgentTurn+".json" {
		t.Errorf("the policy root holds %v after both attempts; want only the planted foreign %s.json", names, nono.ProfileAgentTurn)
	}
}

// realPolicyRecorder is the REAL launcher with a memory: it delegates every
// verification and launch, and records the policy file each launch named.
type realPolicyRecorder struct {
	inner *nono.Launcher

	mu    sync.Mutex
	paths []string
}

func (r *realPolicyRecorder) Verify(ctx context.Context, spec nono.LaunchSpec) (*nono.VerificationResult, error) {
	r.mu.Lock()
	r.paths = append(r.paths, spec.Profile.Path)
	r.mu.Unlock()
	return r.inner.Verify(ctx, spec)
}

func (r *realPolicyRecorder) Probe(ctx context.Context) (domain.SandboxCapabilities, error) {
	return r.inner.Probe(ctx)
}

// TestConcurrentRealNonoAttemptsLaunchUnderTheirOwnPolicy is the lab's
// condition on the real backend: two process.exec attempts at once on one
// worker, each under its own policy file, each launched by nono 0.80.0 on this
// host's Landlock. It skips for a missing precondition (no binary, wrong
// version, no observed Landlock), never for an outcome.
func TestConcurrentRealNonoAttemptsLaunchUnderTheirOwnPolicy(t *testing.T) {
	f := realProcExec(t)
	rec := &realPolicyRecorder{inner: f.launcher}
	f.proc.Sandbox = rec

	second := f.claim(shScript("echo the-second-attempt"))
	second.AttemptID = raceAttemptB
	second.NodeExecutionID = "ne-" + raceAttemptB

	results := map[string]AttemptResult{}
	sinks := map[string]*syncSink{fakeAttemptID: {}, raceAttemptB: {}}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, c := range []AttemptClaim{f.claim(shScript("echo the-first-attempt")), second} {
		wg.Add(1)
		go func(c AttemptClaim) {
			defer wg.Done()
			res, err := f.proc.Execute(context.Background(), c, sinks[c.AttemptID])
			if err != nil {
				t.Errorf("attempt %s Execute: %v", c.AttemptID, err)
			}
			mu.Lock()
			results[c.AttemptID] = res
			mu.Unlock()
		}(c)
	}
	wg.Wait()

	for _, attemptID := range []string{fakeAttemptID, raceAttemptB} {
		res := results[attemptID]
		if res.Status != AttemptStatusSucceeded {
			t.Errorf("attempt %s under real nono: %s / %s", attemptID, res.Status, res.Detail)
		}
		if sinks[attemptID].saw(events.TypeSandboxEnforcementFailed) {
			t.Errorf("attempt %s journalled sandbox.enforcement_failed under real nono", attemptID)
		}
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.paths) != 2 {
		t.Fatalf("real nono launched %d attempts, want 2", len(rec.paths))
	}
	if rec.paths[0] == rec.paths[1] {
		t.Errorf("both real launches used the same policy file %s", rec.paths[0])
	}
	for _, p := range rec.paths {
		if filepath.Dir(filepath.Dir(p)) != f.proc.PolicyDir {
			t.Errorf("real launch used %s, outside a unit directory under %s", p, f.proc.PolicyDir)
		}
	}
	// The slots are the attempts', and attempts end: nothing of theirs is left
	// in the worker's policy directory.
	if entries, err := os.ReadDir(f.proc.PolicyDir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "unit-") {
				t.Errorf("the policy root still holds the unit slot %s after both real attempts ended", e.Name())
			}
		}
	}
}
