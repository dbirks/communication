package assistant

// The broker's per-completion deadline (deployed finding F-4,
// docs/testing/assistant-exercise-2026-11-11.md): the 30 s floor armed ONE
// completion, and a fan-out turn that owes five or six tool calls lost its last
// one and took the turn with it — prompt 5's refusal at 33 s, while the same ask
// retried in 13 s. These tests pin the doubled floor and the operator's knob
// above it.

import (
	"testing"
	"time"
)

func TestDefaultTimeoutIsSixtySeconds(t *testing.T) {
	if DefaultTimeout != 60*time.Second {
		t.Errorf("DefaultTimeout = %s, want 60s (F-4: a fan-out turn's last completion must not die at 30s)",
			DefaultTimeout)
	}
	// The zero-config broker arms the default, so the floor is the constant a
	// deployment sees when it sets nothing.
	b, err := New(Config{BaseURL: "https://models.example.invalid/v1"}, newFakeStore())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := b.timeout(); got != DefaultTimeout {
		t.Errorf("unset Config.Timeout -> %s, want the %s default", got, DefaultTimeout)
	}
	// An operator's setting still wins: the lab runs 180s and a slower model may
	// need more, which is the whole point of there being a knob (serve.go's
	// COMMUNICATION_ASSISTANT_TIMEOUT reaches this field).
	b, err = New(Config{BaseURL: "https://models.example.invalid/v1", Timeout: 180 * time.Second}, newFakeStore())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := b.timeout(); got != 180*time.Second {
		t.Errorf("Config.Timeout=180s -> %s, want 180s", got)
	}
}
