package k8s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dbirks/communication/internal/agent/acp"
)

// Verdict is the ONE JSON line `communication pod-verify` prints inside an
// attempt pod, and the only thing the worker will credit as "this pod enforced
// something" before an ACP session starts (ADR-0082 Decision 3).
//
// It is deliberately not the full nono VerificationResult: the per-unit N-a…N-d
// chain belongs to the plan the worker already verified and journalled, and a
// second copy of it written by a pod would be a second source of truth for the
// same launch. What the pod can honestly report — and what the local worker's
// own startup gate reports — is the pair of *observed enforcement* facts: the
// Landlock ABI the kernel offers, whether a real child was denied a write, and
// whether a real TCP connect completed under the agent profile.
type Verdict struct {
	Verified bool `json:"verified"`
	// LandlockABI is the kernel's Landlock ABI version as nono reported it
	// (`nono setup --check-only -v`), 0 when nono never said.
	LandlockABI int `json:"landlock_abi"`
	// TCP is the agent-turn TCP-reachability probe: true only on the measured
	// `ok` classification, never on an unmeasured shape.
	TCP bool `json:"tcp"`
	// Detail is a short human sentence: the refusal reason when Verified is
	// false, the observed shape when true. It never carries a credential or a
	// grant path.
	Detail string `json:"detail"`
}

// MinLandlockABI is the floor an attempt pod must report to host an agent turn.
// It is nono's own floor for TCP mediation, not a preference: below V4 the
// agent profile's AF_UNIX pathname mediation cannot inspect a connect, which is
// the failure `docs/compatibility/SANDBOX.md` records on ptrace_scope=2 hosts.
const MinLandlockABI = 4

// String renders the verdict for a log line without a struct dump.
func (v Verdict) String() string {
	return fmt.Sprintf("verified=%t landlock_abi=%d tcp=%t detail=%q", v.Verified, v.LandlockABI, v.TCP, v.Detail)
}

// ParseVerdict reads the verdict from the exec's stdout. It takes the LAST
// non-empty line so a backend that prints a banner ahead of the JSON cannot
// hide the verdict, and refuses anything that is not exactly one object with
// those fields: an unparseable stream is "no verdict", which ADR-0019 D6 says is
// a refusal, not a warning.
func ParseVerdict(out []byte) (Verdict, error) {
	var last []byte
	for _, line := range bytes.Split(out, []byte("\n")) {
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			last = trimmed
		}
	}
	if last == nil {
		return Verdict{}, fmt.Errorf("sandbox/k8s: pod-verify printed no verdict")
	}
	dec := json.NewDecoder(bytes.NewReader(last))
	dec.DisallowUnknownFields()
	var v Verdict
	if err := dec.Decode(&v); err != nil {
		return Verdict{}, fmt.Errorf("sandbox/k8s: pod-verify verdict is not the expected JSON object: %v", err)
	}
	if dec.More() {
		return Verdict{}, fmt.Errorf("sandbox/k8s: pod-verify printed trailing garbage after the verdict")
	}
	return v, nil
}

// Check is the fail-closed half: it turns a verdict that does not say
// "enforced" into the error shape the turn loop journals as
// sandbox.enforcement_failed.
func (v Verdict) Check() error {
	switch {
	case !v.Verified:
		return denial(acp.StagePodVerify, "not_verified", v.Detail)
	case v.LandlockABI < MinLandlockABI:
		return denial(acp.StagePodVerify, "landlock_abi_below_v4",
			fmt.Sprintf("the attempt pod reported Landlock ABI %d; agent turns need at least V4 (%s)", v.LandlockABI, v.Detail))
	case !v.TCP:
		return denial(acp.StagePodVerify, "tcp_unreachable",
			"the attempt pod's agent-turn TCP-reachability probe did not report ok ("+v.Detail+")")
	}
	return nil
}

// denial is the acp.Denial the worker maps onto sandbox.enforcement_failed
// (internal/agent/acp/sandbox.go). ChildStarted is false: a refused verification
// means no agent process ever ran, which is exactly the distinction ADR-0019 D6's
// event exists to draw.
func denial(stage, reason, message string) *acp.Denial {
	if strings.TrimSpace(message) == "" {
		message = "no detail reported"
	}
	return &acp.Denial{
		Stage:        stage,
		Reason:       reason,
		Message:      message,
		Backend:      "nono",
		ChildStarted: false,
	}
}

// MarshalVerdict renders the one line `communication pod-verify` prints.
func MarshalVerdict(v Verdict) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// A Verdict is a struct of scalars; marshalling cannot fail. If it ever
		// grows a field that can, the pod must refuse rather than print nothing:
		// silence is already a refusal on the worker side, and this keeps the
		// reason attached to it.
		b, _ = json.Marshal(Verdict{Detail: "verdict could not be encoded"})
	}
	return append(b, '\n')
}
