package k8s

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/agent/acp"
)

func TestParseVerdictReadsTheOneLine(t *testing.T) {
	out := []byte("nono: starting\n" + `{"verified":true,"landlock_abi":6,"tcp":true,"detail":"ok"}` + "\n")
	v, err := ParseVerdict(out)
	if err != nil {
		t.Fatalf("ParseVerdict: %v", err)
	}
	if v != (Verdict{Verified: true, LandlockABI: 6, TCP: true, Detail: "ok"}) {
		t.Errorf("verdict = %+v", v)
	}
	if err := v.Check(); err != nil {
		t.Errorf("a verified V6/TCP verdict must credit the launch: %v", err)
	}
}

func TestParseVerdictRefusesEveryShapeThatIsNotAVerdict(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", "no verdict"},
		{"blank lines", "\n \n\t\n", "no verdict"},
		{"plain text", "sandbox looks fine to me\n", "not the expected JSON object"},
		{"json array", `[{"verified":true}]`, "not the expected JSON object"},
		{"unknown field", `{"verified":true,"landlock_abi":6,"tcp":true,"detail":"ok","extra":1}`, "not the expected JSON object"},
		{"two objects on one line", `{"verified":true} {"verified":true}`, "trailing garbage"},
		{"an object then noise", `{"verified":true} and then the shell complained`, "trailing garbage"},
	} {
		_, err := ParseVerdict([]byte(tc.in))
		if err == nil {
			t.Errorf("%s: ParseVerdict accepted %q", tc.name, tc.in)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q does not mention %q", tc.name, err, tc.want)
		}
	}
	// A partial object parses — and must then be refused by Check, not by the
	// parser: `{"verified":true}` claims enforcement it never named an ABI for.
	v, err := ParseVerdict([]byte(`{"verified":true}`))
	if err != nil {
		t.Fatalf("a partial verdict must parse so Check can refuse it by name: %v", err)
	}
	if v.LandlockABI != 0 || v.TCP {
		t.Errorf("partial verdict = %+v", v)
	}
	if err := v.Check(); err == nil {
		t.Error("Check must refuse a verdict that reports no Landlock ABI and no TCP probe")
	}
}

func TestVerdictCheckRefusalsAreDenials(t *testing.T) {
	for _, tc := range []struct {
		name       string
		v          Verdict
		wantReason string
	}{
		{"not verified", Verdict{Detail: "no landlock"}, "not_verified"},
		{"abi below v4", Verdict{Verified: true, LandlockABI: 3, TCP: true}, "landlock_abi_below_v4"},
		{"no abi reported", Verdict{Verified: true, TCP: true}, "landlock_abi_below_v4"},
		{"tcp withheld", Verdict{Verified: true, LandlockABI: 4, Detail: "EPERM"}, "tcp_unreachable"},
	} {
		err := tc.v.Check()
		if err == nil {
			t.Errorf("%s: Check returned no error", tc.name)
			continue
		}
		var d *acp.Denial
		if !errors.As(err, &d) {
			t.Errorf("%s: error %v is not an *acp.Denial", tc.name, err)
			continue
		}
		if d.Reason != tc.wantReason {
			t.Errorf("%s: reason = %q, want %q", tc.name, d.Reason, tc.wantReason)
		}
		if d.Stage != "pod_verify" {
			t.Errorf("%s: stage = %q, want pod_verify", tc.name, d.Stage)
		}
		if d.ChildStarted {
			t.Errorf("%s: no agent process started, so ChildStarted must be false (ADR-0019 D6's distinction)", tc.name)
		}
	}
	if err := (Verdict{Verified: true, LandlockABI: MinLandlockABI, TCP: true}).Check(); err != nil {
		t.Errorf("the floor case (V4, tcp ok) must be credited: %v", err)
	}
}

func TestMarshalVerdictIsOneJSONLine(t *testing.T) {
	out := MarshalVerdict(Verdict{Verified: true, LandlockABI: 6, TCP: true, Detail: "nono 0.80.0"})
	if strings.Count(string(out), "\n") != 1 || !strings.HasSuffix(string(out), "\n") {
		t.Fatalf("not one line: %q", out)
	}
	if !json.Valid(out) {
		t.Fatalf("not valid JSON: %q", out)
	}
	back, err := ParseVerdict(out)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if back.Detail != "nono 0.80.0" || !back.Verified {
		t.Errorf("round trip = %+v", back)
	}
}
