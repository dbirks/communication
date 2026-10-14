package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
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
	for _, want := range []string{"runtime", "kernel", "landlock-lsm", "tool:git"} {
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
