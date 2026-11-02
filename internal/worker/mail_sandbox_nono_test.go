package worker_test

// The real-kernel half of ADR-0072 § 12. The unit pins in
// mail_sandbox_test.go prove the plan ASKS for `workspace_repo: ro`; this pair
// measures what the child actually gets under nono 0.80.0 on this host's
// Landlock, launched from the plan Unit.Prepare built: with the § 12 mount a
// read inside the repository succeeds and a write into it is refused, and
// without it (an ordinary turn) the same write succeeds. The control leg is
// what makes the refusal § 12's mount rather than a filesystem accident.
//
// This run is also the measurement the § 12 rule rests on for the *cwd*: a
// launch whose working directory is covered only by a read grant keeps that
// working directory — it does not relocate to /, which is probe C-CWD's
// failure for a cwd outside every grant — and simply cannot write there.
// Without that observed fact the asked turn would have to start outside the
// repository it was asked about.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/sandbox/nono"
	wsgit "github.com/dbirks/communication/internal/workspace/git"
)

// mailWriteOutcome is what one sandboxed launch did, as the filesystem says.
type mailWriteOutcome struct {
	read      string // the repository file's content the child copied out
	wrote     bool   // the child created a file in the repository
	refused   bool   // the child's || arm ran: the write was refused
	scratchOK bool   // the child wrote in workspace_scratch
	labels    []string
}

func runRepoWriteUnderNono(t *testing.T, repoAccess string) mailWriteOutcome {
	t.Helper()
	bin := nonoPath(t)
	fx := newUnitFixture(t)
	launcher := &nono.Launcher{Binary: bin, Home: fx.svc.LauncherHome}
	caps, err := launcher.Probe(context.Background())
	if err != nil {
		t.Skipf("nono probe: %v", err)
	}
	if !caps.Filesystem {
		t.Skipf("no observed Landlock filesystem support (%v): nothing may depend on an unproven sandbox", caps.Notes)
	}

	req := fx.request()
	req.RepoAccess = repoAccess
	unit, err := fx.svc.Prepare(context.Background(), req)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := unit.Verify(context.Background(), testLauncher()); err != nil {
		t.Fatalf("verify: %v", err)
	}
	prof, err := nono.WriteProfile(filepath.Join(fx.root, "real-policy"), nono.ProfileAgentTurn)
	if err != nil {
		t.Fatal(err)
	}

	checkout := unit.Repos[0].CheckoutPath
	if err := os.WriteFile(filepath.Join(checkout, "README.mail"), []byte("asked-turn\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	readMarker := filepath.Join(unit.Layout.Scratch, "read-ok")
	wroteMarker := filepath.Join(checkout, "written-by-the-agent")
	scratchWrite := filepath.Join(unit.Layout.Scratch, "scratch-write-ok")
	refused := filepath.Join(unit.Layout.Scratch, "write-refused")

	// Read the repo, try to write the repo, then prove scratch is still
	// writable — three facts, one launch, in the order § 12 states them. The
	// `cd` names the checkout as the working directory: inside a read-only
	// grant is where the asked turn has to work.
	script := "cd " + checkout +
		" && cat README.mail > " + readMarker +
		" && (echo edits > " + wroteMarker + " || echo refused > " + refused + ")" +
		" && echo ok > " + scratchWrite
	handle, res, err := launcher.LaunchPlan(context.Background(), nono.LaunchSpec{
		Profile: prof, Plan: unit.Plan, LauncherHome: fx.svc.LauncherHome,
		AdapterPath: "/bin/sh",
		AdapterArgs: []string{"-c", script},
		AdapterEnv:  []string{"PATH=/usr/local/bin:/usr/bin:/bin", "GIT_TERMINAL_PROMPT=0"},
	})
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	if !res.Verified {
		t.Fatal("launched without a verified chain (ADR-0019 D6)")
	}
	// The child swallows its own write failure, so a non-zero Wait here means
	// the launch could not even do the reads — which is the cwd question.
	if err := handle.Wait(); err != nil {
		t.Fatalf("the sandboxed shell did not complete: %v", err)
	}

	out := mailWriteOutcome{labels: unit.Plan.Labels()}
	if raw, err := os.ReadFile(readMarker); err == nil {
		out.read = strings.TrimSpace(string(raw))
	} else {
		t.Errorf("no read marker (%v): the agent could not read the repository it was asked about", err)
	}
	if _, err := os.Stat(wroteMarker); err == nil {
		out.wrote = true
	}
	if raw, err := os.ReadFile(refused); err == nil {
		out.refused = strings.TrimSpace(string(raw)) == "refused"
	}
	if _, err := os.Stat(scratchWrite); err == nil {
		out.scratchOK = true
	}
	return out
}

func TestAskedTurnUnderRealNonoCannotWriteItsRepo(t *testing.T) {
	got := runRepoWriteUnderNono(t, wsgit.AccessReadOnly)
	if got.read != "asked-turn" {
		t.Errorf("read = %q, want the repository's own content: a read-only mount must still read", got.read)
	}
	if got.wrote {
		t.Error("the child wrote into the repository: the read-only workspace_repo grant did not hold, so § 12's guarantee is the prompt's again and not the kernel's")
	}
	if !got.refused {
		t.Error("the child never reported the write refused (its || arm did not run)")
	}
	if !got.scratchOK {
		t.Error("workspace_scratch is not writable: § 12 narrows the repository, not the agent's ability to generate output")
	}
	// The row an operator quotes: the journal reports the level the kernel held.
	saw := false
	for _, label := range got.labels {
		if label == "workspace_repo:ro" {
			saw = true
		}
	}
	if !saw {
		t.Errorf("sandbox.verified would report %v, with no workspace_repo:ro row to point at", got.labels)
	}
}

// TestOrdinaryTurnUnderRealNonoWritesItsRepo is the control pair: the same
// launch with the access § 12 withholds from an asked turn is what every
// ordinary conversation keeps, and the write lands.
func TestOrdinaryTurnUnderRealNonoWritesItsRepo(t *testing.T) {
	got := runRepoWriteUnderNono(t, "")
	if got.read != "asked-turn" {
		t.Errorf("read = %q, want the repository's content", got.read)
	}
	if !got.wrote {
		t.Errorf("an ordinary turn could NOT write its repository (labels %v): the fixture's rw plan is broken, which would make the read-only control vacuous", got.labels)
	}
	if got.refused {
		t.Error("the refusal arm ran on a read-write plan")
	}
	if !got.scratchOK {
		t.Error("workspace_scratch is not writable on an ordinary plan")
	}
	for _, label := range got.labels {
		if label == "workspace_repo:ro" {
			t.Errorf("an ordinary plan reported %v", label)
		}
	}
}
