package runtime

import (
	"math"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/pipelines/compiler"
)

// ADR-0023 § 7: min(maxSeconds, baseSeconds * multiplier^attemptNumber) with
// ±20 % jitter. These are the numbers the persisted retry_scheduled row must
// keep honest.
func TestBackoffDelayFormula(t *testing.T) {
	r := compiler.Retry{MaxAttempts: 6, BaseSeconds: 2, Multiplier: 2, MaxSeconds: 10}
	cases := []struct {
		attempt int
		want    time.Duration // unraveled center (jitter is ±20 % of this)
	}{
		{1, 4 * time.Second},  // 2·2^1
		{2, 8 * time.Second},  // 2·2^2
		{3, 10 * time.Second}, // clamped by maxSeconds
		{4, 10 * time.Second}, // stays clamped
	}
	for _, c := range cases {
		got := backoffDelay(r, "ne-x", c.attempt)
		lo := time.Duration(float64(c.want) * 0.79)
		hi := time.Duration(float64(c.want) * 1.21)
		if got < lo || got > hi+time.Millisecond {
			t.Errorf("attempt %d: %v outside [%v, %v] (±20%% of %v)", c.attempt, got, lo, hi, c.want)
		}
	}
}

func TestBackoffJitterIsBoundedAndDeterministic(t *testing.T) {
	r := compiler.Retry{BaseSeconds: 30, Multiplier: 2, Jitter: true}
	seenMin, seenMax := time.Hour, time.Duration(0)
	for i := 0; i < 50; i++ {
		id := "ne" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		d := backoffDelay(r, id, 1)
		center := 60 * time.Second
		lo, hi := time.Duration(float64(center)*0.8), time.Duration(float64(center)*1.2)
		if d < lo || d > hi {
			t.Fatalf("jitter %v outside [48s, 72s]", d)
		}
		if backoffDelay(r, id, 1) != d {
			t.Fatalf("jitter must be a pure function of (nodeExec, attempt) — restart mid-backoff must not move a persisted scheduled_at's original value")
		}
		seenMin, seenMax = min(seenMin, d), max(seenMax, d)
	}
	if seenMax == seenMin {
		t.Error("jitter spread produced identical delays across 50 nodes")
	}
	if math.IsNaN(float64(seenMax)) || seenMax <= 0 {
		t.Errorf("spread %+v", [2]time.Duration{seenMin, seenMax})
	}
}

func TestRetriableSetRespectsADR0023(t *testing.T) {
	r := compiler.Retry{RetriableErrors: []string{ErrInfra, ErrInterrupted, ErrTimeout, ErrWorkspaceLost}}
	for _, class := range r.RetriableErrors {
		// workspace_lost is the exception, and the exception is the rule:
		// ADR-0023 § 7 makes it non-retriable BY DEFINITION, so a hand-built
		// (or old pinned) plan that lists it still gets no retry. The compiler
		// refuses it in retriableErrors (§ 9.3's sample fixed exactly that
		// authored bug); this function refuses it too, because the run's plan
		// snapshot is immutable and predates that guard if it predates the guard.
		if class == ErrWorkspaceLost {
			if retriable(r, class) {
				t.Errorf("plan-listed %s retried: a lost workspace is never retried automatically (contract § 7.1 C6e)", class)
			}
			continue
		}
		if !retriable(r, class) {
			t.Errorf("plan-listed class %s must retry", class)
		}
	}
	for _, class := range []string{ErrAgentError, ErrInvalidOutput, ErrPredicate, ErrCancelled, ErrApprovalExpired, ErrSandboxEnforcementFailed, ErrBinding} {
		if retriable(r, class) {
			t.Errorf("class %s is not in this plan's retriableErrors and must not retry", class)
		}
	}
	if retriable(compiler.Retry{}, ErrInfra) {
		t.Error("the default plan retries nothing — attempt budgets are authored, not implied")
	}
}
