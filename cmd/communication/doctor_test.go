package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
)

type doctorReport struct {
	Version string        `json:"version"`
	Checks  []CheckResult `json:"checks"`
}

func TestDoctorJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	got := run([]string{"doctor", "--json"}, &stdout, &stderr)
	if got != 0 {
		t.Fatalf("run(doctor --json) = %d, want 0 (stderr: %s)", got, stderr.String())
	}

	var rep doctorReport
	if err := json.Unmarshal(stdout.Bytes(), &rep); err != nil {
		t.Fatalf("unmarshal doctor JSON: %v\noutput: %s", err, stdout.String())
	}
	if len(rep.Checks) == 0 {
		t.Fatalf("checks slice is empty; output: %s", stdout.String())
	}

	byName := map[string]CheckResult{}
	for _, c := range rep.Checks {
		byName[c.Name] = c
	}
	for _, want := range []string{"runtime", "kernel", "landlock-lsm", "tool:git", "sandbox:nono"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("checks missing %q", want)
		}
	}

	valid := map[string]bool{statusOK: true, statusMissing: true, statusWarn: true, statusError: true}
	for _, c := range rep.Checks {
		if !valid[c.Status] {
			t.Errorf("check %q has invalid status %q", c.Name, c.Status)
		}
	}
}

func TestDoctorTextTable(t *testing.T) {
	var stdout, stderr bytes.Buffer
	got := run([]string{"doctor"}, &stdout, &stderr)
	if got != 0 {
		t.Fatalf("run(doctor) = %d, want 0 (stderr: %s)", got, stderr.String())
	}
	for _, want := range []string{"runtime", "kernel", "landlock-lsm", "tool:git"} {
		if !bytes.Contains(stdout.Bytes(), []byte(want)) {
			t.Errorf("text table missing %q; output:\n%s", want, stdout.String())
		}
	}
}

func TestDoctorBadFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	got := run([]string{"doctor", "--bogus"}, &stdout, &stderr)
	if got != 2 {
		t.Fatalf("run(doctor --bogus) = %d, want 2", got)
	}
}

// TestDoctorSandboxNonoNeverOverclaims checks the sandbox check stays a
// probe: verified=false, and no stronger isolation claim leaks into detail.
func TestDoctorSandboxNonoNeverOverclaims(t *testing.T) {
	valid := map[string]bool{statusOK: true, statusMissing: true, statusWarn: true, statusError: true}
	for _, r := range sandboxCheck(context.Background()) {
		if r.Name != "sandbox:nono" {
			t.Fatalf("name = %q, want sandbox:nono", r.Name)
		}
		if !valid[r.Status] {
			t.Errorf("status = %q, want one of ok|missing|warn|error", r.Status)
		}
		if r.Status != statusOK {
			continue
		}
		if !strings.Contains(r.Detail, "verified=false") {
			t.Errorf("detail lacks the verified=false verdict: %q", r.Detail)
		}
		lower := strings.ToLower(r.Detail)
		for _, bad := range []string{"tenant boundary", "verified: true", "enforced"} {
			if strings.Contains(lower, bad) {
				t.Errorf("detail overclaims with %q: %q", bad, r.Detail)
			}
		}
	}
}

func TestDoctorACPUnknownID(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := run([]string{"doctor", "--acp", "nosuch"}, &stdout, &stderr); got != 2 {
		t.Fatalf("run(doctor --acp nosuch) = %d, want 2 (stderr: %s)", got, stderr.String())
	}
	if !strings.Contains(stderr.String(), "unknown --acp launcher id") {
		t.Errorf("stderr lacks the unknown-id message: %q", stderr.String())
	}
}

func TestDoctorACPCmdOverrideMissing(t *testing.T) {
	var stdout, stderr bytes.Buffer
	got := run([]string{"doctor", "--acp", "claude", "--acp-cmd", "/nonexistent/x", "--json"}, &stdout, &stderr)
	if got != 1 {
		t.Fatalf("run(doctor --acp claude --acp-cmd /nonexistent/x --json) = %d, want 1 (stderr: %s)", got, stderr.String())
	}

	var rep doctorReport
	if err := json.Unmarshal(stdout.Bytes(), &rep); err != nil {
		t.Fatalf("unmarshal: %v\noutput: %s", err, stdout.String())
	}
	var res *CheckResult
	for i, c := range rep.Checks {
		if c.Name == "acp:claude" {
			res = &rep.Checks[i]
		}
	}
	if res == nil {
		t.Fatalf("checks lack acp:claude: %s", stdout.String())
	}
	if res.Status != statusMissing && res.Status != statusError {
		t.Errorf("acp:claude status = %q, want missing or error (detail %q)", res.Status, res.Detail)
	}
}

func TestDoctorACPCmdNeedsSingleID(t *testing.T) {
	var stdout, stderr bytes.Buffer
	got := run([]string{"doctor", "--acp", "claude,codex", "--acp-cmd", "/usr/bin/true"}, &stdout, &stderr)
	if got != 2 {
		t.Fatalf("run(two --acp ids with --acp-cmd) = %d, want 2 (stderr: %s)", got, stderr.String())
	}
	if !strings.Contains(stderr.String(), "--acp-cmd") {
		t.Errorf("stderr lacks the flag-complaint: %q", stderr.String())
	}
}

func TestACPExitCode(t *testing.T) {
	results := []CheckResult{{Name: "runtime", Status: statusWarn}, {Name: "acp:codex", Status: statusMissing}}
	if got := acpExitCode(results, nil); got != 0 {
		t.Errorf("acpExitCode(unrequested) = %d, want 0", got)
	}
	if got := acpExitCode(results, []string{"codex"}); got != 1 {
		t.Errorf("acpExitCode(requested, missing) = %d, want 1", got)
	}
	ok := []CheckResult{{Name: "acp:codex", Status: statusOK}}
	if got := acpExitCode(ok, []string{"codex"}); got != 0 {
		t.Errorf("acpExitCode(requested, ok) = %d, want 0", got)
	}
}

func TestResolveACPIDs(t *testing.T) {
	var stderr bytes.Buffer
	ids, bad := resolveACPIDs(stringListFlag{"claude", "claude", "codex"}, "", &stderr)
	if bad {
		t.Fatalf("resolveACPIDs() bad = true (%s)", stderr.String())
	}
	if want := "[claude codex]"; fmt.Sprint(ids) != want {
		t.Errorf("resolveACPIDs() = %v, want %s", ids, want)
	}
	if _, bad := resolveACPIDs(stringListFlag{"gemini"}, "", &stderr); !bad {
		t.Error("resolveACPIDs(gemini) bad = false, want true")
	}
}

func TestStringListFlag(t *testing.T) {
	var got stringListFlag
	for _, v := range []string{" claude ", "claude, codex", "", ",,"} {
		if err := got.Set(v); err != nil {
			t.Fatalf("Set(%q): %v", v, err)
		}
	}
	if got.String() != "claude,claude,codex" {
		t.Errorf("String() = %q, want %q", got.String(), "claude,claude,codex")
	}
}

func TestStderrTail(t *testing.T) {
	if got := stderrTail("line one\nline two\n", 300); got != "line one line two" {
		t.Errorf("stderrTail = %q", got)
	}
	long := strings.Repeat("a", 400) + " b"
	if got := stderrTail(long, 4); got != "aa b" || len(got) != 4 {
		t.Errorf("stderrTail(long, 4) = %q, want 4 bytes ending in b", got)
	}
}

func TestACPEventHelpers(t *testing.T) {
	ev := []domain.ConversationEvent{
		{Kind: "tool_call"},
		{Kind: "message_chunk", Text: "SECOND"},
		{Kind: "message_chunk", Text: " "},
		{Kind: "unknown"},
	}
	if got := eventKindCount(ev); got != "message_chunk:2,tool_call:1,unknown:1" {
		t.Errorf("eventKindCount = %q", got)
	}
	if got := eventMessageText(ev); got != "SECOND " {
		t.Errorf("eventMessageText = %q", got)
	}
	if got := countEventKind(ev, "message_chunk"); got != 2 {
		t.Errorf("countEventKind = %d, want 2", got)
	}
	if got := shortSessionID("0123456789abcdef"); got != "01234567" {
		t.Errorf("shortSessionID = %q", got)
	}
	if got := shortSessionID("abc"); got != "abc" {
		t.Errorf("shortSessionID(short) = %q", got)
	}
}

func TestToolCheckMissing(t *testing.T) {
	res := toolCheck(context.Background(), "definitely-not-a-real-binary-xyz")
	if res.Name != "tool:definitely-not-a-real-binary-xyz" {
		t.Errorf("name = %q", res.Name)
	}
	if res.Status != statusMissing {
		t.Errorf("status = %q, want %q", res.Status, statusMissing)
	}
}

func TestFirstNonEmptyLine(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"\n\n  git version 2.50.0\n\nmore", "git version 2.50.0"},
		{"one\ntwo", "one"},
		{"", ""},
		{"   \n\t\n", ""},
	}
	for _, tt := range tests {
		if got := firstNonEmptyLine(tt.in); got != tt.want {
			t.Errorf("firstNonEmptyLine(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
