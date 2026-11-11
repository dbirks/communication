package worker

import (
	"strings"
	"testing"
	"time"
)

// The operator knob for the human approval window
// (docs/testing/claude-ask-mode-2026-11-11 proposal 3): an unset value takes
// the default, a valid duration passes, and every rejection names
// COMMUNICATION_WORKER_PERMISSION_TTL so a failing worker's log points at the
// knob instead of a mystery.

func TestParsePermissionTTL(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want time.Duration
		err  bool
	}{
		{name: "unset takes the default", raw: "", want: DefaultPermissionTTL},
		{name: "blank takes the default", raw: "   ", want: DefaultPermissionTTL},
		{name: "minutes", raw: "30m", want: 30 * time.Minute},
		{name: "minimum bound", raw: "30s", want: 30 * time.Second},
		{name: "maximum bound", raw: "1h", want: time.Hour},
		{name: "not a duration", raw: "banana", err: true},
		{name: "unitless is not a duration", raw: "600", err: true},
		{name: "below the human floor", raw: "5s", err: true},
		{name: "above the ceiling", raw: "90m", err: true},
		{name: "negative", raw: "-10m", err: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParsePermissionTTL(tc.raw)
			if tc.err {
				if err == nil {
					t.Fatalf("ParsePermissionTTL(%q) = %s, want error", tc.raw, got)
				}
				if !strings.Contains(err.Error(), EnvPermissionTTL) {
					t.Errorf("error %q does not name %s", err, EnvPermissionTTL)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParsePermissionTTL(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Errorf("ParsePermissionTTL(%q) = %s, want %s", tc.raw, got, tc.want)
			}
		})
	}
}

func TestPermissionTTLDefaultIsTenMinutes(t *testing.T) {
	if DefaultPermissionTTL != 10*time.Minute {
		t.Fatalf("DefaultPermissionTTL = %s, want 10m (a two-minute prompt is a machine timeout, not a human window)", DefaultPermissionTTL)
	}
}

// normalise is what NewTurnLoop runs at startup: with a zero PermissionTTL
// the env value is the operator's window, and an invalid one is a startup
// error naming the variable rather than a silent default.
func TestTurnConfigPermissionTTLFromEnv(t *testing.T) {
	t.Setenv(EnvPermissionTTL, "45m")
	cfg, err := (TurnConfig{}).normalise()
	if err != nil {
		t.Fatalf("normalise with %s=45m: %v", EnvPermissionTTL, err)
	}
	if cfg.PermissionTTL != 45*time.Minute {
		t.Errorf("PermissionTTL = %s, want 45m", cfg.PermissionTTL)
	}

	t.Setenv(EnvPermissionTTL, "10s")
	if _, err := (TurnConfig{}).normalise(); err == nil {
		t.Fatalf("normalise with %s=10s succeeded, want a startup error naming the variable", EnvPermissionTTL)
	} else if !strings.Contains(err.Error(), EnvPermissionTTL) {
		t.Errorf("error %q does not name %s", err, EnvPermissionTTL)
	}

	t.Setenv(EnvPermissionTTL, "")
	cfg, err = (TurnConfig{}).normalise()
	if err != nil {
		t.Fatalf("normalise with %s unset: %v", EnvPermissionTTL, err)
	}
	if cfg.PermissionTTL != DefaultPermissionTTL {
		t.Errorf("PermissionTTL = %s, want the default %s", cfg.PermissionTTL, DefaultPermissionTTL)
	}
}

// A programmatically set window is trusted: the expiry tests drive
// sub-second TTLs, and the 30s..1h clamp is a rule for the operator's knob,
// not for the code that has to prove expiry works.
func TestTurnConfigPermissionTTLProgrammaticBypassesEnv(t *testing.T) {
	t.Setenv(EnvPermissionTTL, "1h")
	cfg, err := TurnConfig{PermissionTTL: time.Second}.normalise()
	if err != nil {
		t.Fatalf("normalise(PermissionTTL=1s): %v", err)
	}
	if cfg.PermissionTTL != time.Second {
		t.Errorf("PermissionTTL = %s, want the configured 1s", cfg.PermissionTTL)
	}
}
