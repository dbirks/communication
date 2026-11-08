package main

// Tests for the catch-up tour generator's tunable per-run cooldown
// (COMMUNICATION_CATCHUP_GEN_COOLDOWN). The rule this knob ships with is that
// it is the ONLY serve duration that never refuses startup: unset, 0, negative
// and unparseable all land on assistant.CatchUpGenCooldown, because the
// cooldown guards a model from a page-load storm rather than deciding any
// behaviour an operator depends on. Hermetic: no pool, no goroutine, just the
// parser and the stack field it feeds.

import (
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
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
