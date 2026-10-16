package worker_test

// The conversation path's launch marker: the entry in the child's argv that
// lets a finished turn read ITS OWN nono egress audit (ADR-0035's evidence rule,
// and the coverage row docs/compatibility/SANDBOX.md § "Egress allowlist lab
// evaluation" recorded as FAIL because only the pipeline attempt carried one).

import (
	"context"
	"strings"
	"testing"
)

// TestConversationLaunchCarriesTheTurnMarker is the argv half of that fix. It
// reads the argv `Unit.Verify` actually hands the runtime — not a re-render of a
// spec — because that argv (via the launcher's `env` hop) is what
// `nono audit list --json` records, and a marker that never reaches it leaves the
// turn's egress claim unattributable: the adapter would cite some other run's
// denials or, fail-closed, none at all.
func TestConversationLaunchCarriesTheTurnMarker(t *testing.T) {
	fx := newUnitFixture(t)
	unit := fx.preparedUnit(t)
	plan, err := unit.Verify(context.Background(), testLauncher())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	turnID := fx.request().TurnID
	want := "COMMUNICATION_TURN_ID=" + turnID
	inArgv, inEnv := false, false
	for _, a := range plan.Args {
		if a == want {
			inArgv = true
		}
		if a == "HOME=/nonexistent" {
			t.Fatal("the caller's HOME leaked into the argv the sandbox is launched with (probe C-H1)")
		}
	}
	sx := fx.sandbox
	sx.mu.Lock()
	if len(sx.specs) == 0 {
		sx.mu.Unlock()
		t.Fatal("the sandbox saw no launch spec: nothing was verified, so nothing can be attributed")
	}
	spec := sx.specs[len(sx.specs)-1]
	sx.mu.Unlock()
	for _, kv := range spec.AdapterEnv {
		if kv == want {
			inEnv = true
		}
		if !strings.Contains(kv, "=") {
			t.Fatalf("adapter env entry %q is not KEY=VALUE: the argv builder refuses the whole launch for one malformed entry", kv)
		}
	}
	if !inEnv {
		t.Fatalf("the launch spec's adapter env has no %q: nothing can attribute this turn's egress audit to this turn", want)
	}
	if !inArgv {
		t.Fatalf("the verified argv has no whole %q entry — it reaches the child but not the audit journal: %v", want, plan.Args)
	}
	if unit.TurnID != turnID {
		t.Fatalf("unit.TurnID = %q, want the requesting turn %q: the turn-end hook matches on it to decide whether this turn launched this unit", unit.TurnID, turnID)
	}
}
