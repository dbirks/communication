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
