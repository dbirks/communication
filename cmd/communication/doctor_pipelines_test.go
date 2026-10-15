package main

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/expr"
)

// digestRe is the shape pipeline_revisions.cel_env_digest is CHECKed against
// in migration 00005 (contract § 1).
var digestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func TestDoctorPipelineLaneAllPass(t *testing.T) {
	results := pipelineChecks(context.Background())
	if len(results) == 0 {
		t.Fatal("pipelineChecks returned no results")
	}
	byName := map[string]CheckResult{}
	for _, r := range results {
		byName[r.Name] = r
		if r.Status != statusOK {
			t.Errorf("check %q = %s: %s", r.Name, r.Status, r.Detail)
		}
	}
	for _, want := range []string{"pipeline:schema", "pipeline:cel_env_digest"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("lane missing %q", want)
		}
	}
	// One probe line per allowlisted name (contract § 6.2).
	for _, name := range expr.AllowedFunctions() {
		if _, ok := byName["pipeline:cel:"+name]; !ok {
			t.Errorf("lane missing probe check for allowlisted name %q", name)
		}
	}
}

// TestDoctorPipelineProbeTableMatchesAllowlist pins the § 6.2 requirement in
// both directions: no allowlisted name without a probe, no probe for a name
// the subset no longer allows.
func TestDoctorPipelineProbeTableMatchesAllowlist(t *testing.T) {
	allowed := map[string]bool{}
	for _, n := range expr.AllowedFunctions() {
		allowed[n] = true
	}
	for _, n := range expr.AllowedFunctions() {
		if _, ok := celLivenessProbes[n]; !ok {
			t.Errorf("allowlisted name %q has no liveness probe", n)
		}
	}
	for n := range celLivenessProbes {
		if !allowed[n] {
			t.Errorf("probe for %q is outside the allowlist", n)
		}
	}
}

// TestDoctorPipelineProbeRejectsUnknownName is the fail-closed half: an
// expression using a name outside the CEL subset must report an error, not a
// silent pass.
func TestDoctorPipelineProbeRejectsUnknownName(t *testing.T) {
	res := runCELProbe(context.Background(), "now", celProbe{src: "now() == 0", want: true})
	if res.Name != "pipeline:cel:now" {
		t.Errorf("name = %q", res.Name)
	}
	if res.Status != statusError {
		t.Errorf("status = %q, want %q (detail %q)", res.Status, statusError, res.Detail)
	}
	if !strings.Contains(res.Detail, "refused at compile") {
		t.Errorf("detail lacks the compile refusal: %q", res.Detail)
	}
}

// TestDoctorPipelineProbeValueMismatchFails pins that a changed operator
// spelling (the `@in` precedent) turns the check red rather than green.
func TestDoctorPipelineProbeValueMismatchFails(t *testing.T) {
	res := runCELProbe(context.Background(), "_==_", celProbe{src: "1 == 1", want: false})
	if res.Status != statusError {
		t.Errorf("status = %q, want %q (detail %q)", res.Status, statusError, res.Detail)
	}
}

func TestDoctorPipelineDigestStable(t *testing.T) {
	first := celEnvDigestCheck()
	second := celEnvDigestCheck()
	if first.Status != statusOK || second.Status != statusOK {
		t.Fatalf("digest check = %s/%s: %s | %s", first.Status, second.Status, first.Detail, second.Detail)
	}
	if first.Detail != second.Detail {
		t.Errorf("digest detail moved across calls: %q vs %q", first.Detail, second.Detail)
	}
	// The lane must report the exact value a published revision stores.
	digest := strings.TrimPrefix(first.Detail, "cel-go="+expr.CELVersion+" digest=")
	digest = strings.SplitN(digest, " ", 2)[0]
	if digest != compiler.EnvDigest() {
		t.Errorf("lane digest %q != compiler.EnvDigest() %q", digest, compiler.EnvDigest())
	}
	if !digestRe.MatchString(digest) {
		t.Errorf("digest %q does not match the DB CHECK shape", digest)
	}
}

func TestDoctorPipelineSchemaCheck(t *testing.T) {
	res := pipelineSchemaCheck()
	if res.Status != statusOK {
		t.Fatalf("schema compile = %s: %s", res.Status, res.Detail)
	}
	if !strings.Contains(res.Detail, "santhosh-tekuri/jsonschema") || !strings.Contains(res.Detail, "sha256:") {
		t.Errorf("detail lacks the pinned validator or schema digest: %q", res.Detail)
	}
}

func TestDoctorPipelinesFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	got := run([]string{"doctor", "--pipelines", "--json"}, &stdout, &stderr)
	if got != 0 {
		t.Fatalf("run(doctor --pipelines --json) = %d, want 0 (stderr: %s)", got, stderr.String())
	}
	var rep doctorReport
	if err := json.Unmarshal(stdout.Bytes(), &rep); err != nil {
		t.Fatalf("unmarshal doctor JSON: %v\noutput: %s", err, stdout.String())
	}
	var n int
	for _, c := range rep.Checks {
		if strings.HasPrefix(c.Name, "pipeline:") {
			n++
		}
	}
	if want := 2 + len(expr.AllowedFunctions()); n != want {
		t.Errorf("lane reported %d pipeline checks, want %d", n, want)
	}
}

func TestDoctorPipelinesNotRequestedByDefault(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := run([]string{"doctor", "--json"}, &stdout, &stderr); got != 0 {
		t.Fatalf("run(doctor --json) = %d, want 0 (stderr: %s)", got, stderr.String())
	}
	if bytes.Contains(stdout.Bytes(), []byte("pipeline:")) {
		t.Error("pipeline lane ran without --pipelines")
	}
}

func TestPipelinesExitCode(t *testing.T) {
	bad := []CheckResult{{Name: "runtime", Status: statusWarn}, {Name: "pipeline:cel:has", Status: statusError}}
	if got := pipelinesExitCode(bad); got != 1 {
		t.Errorf("pipelinesExitCode(failing lane) = %d, want 1", got)
	}
	ok := []CheckResult{{Name: "pipeline:schema", Status: statusOK}}
	if got := pipelinesExitCode(ok); got != 0 {
		t.Errorf("pipelinesExitCode(passing lane) = %d, want 0", got)
	}
}
