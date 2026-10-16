package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
)

// The § 4 step 9 executor's unit layer: real executor, faked byte backend and
// faked fenced row writer, so the behaviours the contract pins are observable
// without a database — one Put per artifact, one fenced row per artifact, the
// scan counted, a stale fence writing nothing further, and a missing seam
// named instead of faked. The integration proof (real Postgres fence, real
// artifact.created) belongs to the wave that wires the writer.

const pubRunID = "0f51cf22-4c2d-7abc-9def-0123456789ab"

// errPubUnused marks the byte-backend methods this executor never calls.
var errPubUnused = errors.New("artifactpublish test: method is not part of the publish path")

type pubPut struct {
	in   artifacts.Input
	body []byte
}

type pubBytesFake struct {
	puts   []pubPut
	putErr error
}

var _ artifacts.Store = (*pubBytesFake)(nil)

func (f *pubBytesFake) Put(_ context.Context, in artifacts.Input) (artifacts.Ref, error) {
	body, err := io.ReadAll(in.Body)
	if err != nil {
		return artifacts.Ref{}, err
	}
	f.puts = append(f.puts, pubPut{in: in, body: body})
	if f.putErr != nil {
		return artifacts.Ref{}, f.putErr
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	return artifacts.Ref{
		ProjectID:      in.ProjectID,
		StorageBackend: "local",
		StorageKey:     "artifacts/" + in.Kind + "/" + digest,
		SHA256:         digest,
		SizeBytes:      int64(len(body)),
		MediaType:      in.MediaType,
	}, nil
}

func (f *pubBytesFake) Open(context.Context, artifacts.Ref) (io.ReadCloser, int64, error) {
	return nil, 0, errPubUnused
}

func (f *pubBytesFake) Stat(context.Context, artifacts.Ref) (artifacts.Ref, error) {
	return artifacts.Ref{}, errPubUnused
}

func (f *pubBytesFake) Delete(context.Context, artifacts.Ref) error { return errPubUnused }

func (f *pubBytesFake) Presign(context.Context, artifacts.Ref, time.Duration, string) (string, time.Time, error) {
	return "", time.Time{}, errPubUnused
}

type pubRowsFake struct {
	calls []AttemptArtifactInput
	id    string
	err   error
}

var _ AttemptArtifactWriter = (*pubRowsFake)(nil)

func (f *pubRowsFake) PublishAttemptArtifact(_ context.Context, in AttemptArtifactInput) (string, error) {
	f.calls = append(f.calls, in)
	if f.err != nil {
		return "", f.err
	}
	if f.id != "" {
		return f.id, nil
	}
	return fmt.Sprintf("artifact-%d", len(f.calls)), nil
}

func pubClaim(cfg map[string]any) AttemptClaim {
	return AttemptClaim{
		AttemptID: "attempt-1", NodeExecutionID: "node-exec-1",
		RunID: pubRunID, ProjectID: "project-1", OrganizationID: "org-1",
		WorkerID: "worker-1", FencingToken: 7,
		NodeID: "publish_verified", NodeInstanceKey: "publish_verified[1]",
		Kind: NodeKindArtifactPublish, AttemptNumber: 1,
		Config: cfg,
	}
}

func pubExecutor(bytes *pubBytesFake, rows *pubRowsFake, redact func(string) (string, int), ws AttemptWorkspaceResolver) *ArtifactPublish {
	p := &ArtifactPublish{Redact: redact, Workspaces: ws}
	// Assigned conditionally so a nil fake stays a nil seam (the executor's
	// "not wired" check is an interface-nil check, not a typed-nil one).
	if bytes != nil {
		p.Bytes = bytes
	}
	if rows != nil {
		p.Rows = rows
	}
	return p
}

func pubOutputs(t *testing.T, res AttemptResult) map[string]any {
	t.Helper()
	out, ok := res.Outputs.(map[string]any)
	if !ok {
		t.Fatalf("outputs are %T, want an object", res.Outputs)
	}
	return out
}

// TestArtifactPublishOutputJSONMarkdown is the exit gate's `review-evidence.md`
// node: one Put of a readable markdown document whose fenced block carries the
// upstream outputs, and exactly one fenced row + event.
func TestArtifactPublishOutputJSONMarkdown(t *testing.T) {
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	p := pubExecutor(bytesFake, rows, nil, nil)
	cfg := map[string]any{
		"name": "review-evidence.md", "kind": "markdown", "sensitivity": "standard",
		"from": map[string]any{"mode": "output_json", "value": map[string]any{
			"approved":               true,
			"implementation_summary": "the build loop reached verified",
		}},
	}
	res, err := p.Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s (%s / %s), want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if res.Outcome != "passed" {
		t.Errorf("outcome = %q, want passed", res.Outcome)
	}
	if len(bytesFake.puts) != 1 {
		t.Fatalf("puts = %d, want exactly 1", len(bytesFake.puts))
	}
	if len(rows.calls) != 1 {
		t.Fatalf("row writes = %d, want exactly 1 (row+event are one fenced transaction)", len(rows.calls))
	}
	got := bytesFake.puts[0]
	if got.in.Kind != artifacts.KindMarkdown || got.in.MediaType != "text/markdown" {
		t.Errorf("kind/media = %s / %s, want markdown / text/markdown", got.in.Kind, got.in.MediaType)
	}
	if got.in.Name != "review-evidence.md" {
		t.Errorf("name = %q", got.in.Name)
	}
	body := string(got.body)
	for _, want := range []string{"# review-evidence", "```json", `"approved": true`,
		"`publish_verified`", "attempt 1"} {
		if !strings.Contains(body, want) {
			t.Errorf("artifact body missing %q:\n%s", want, body)
		}
	}
	if rows.calls[0].Kind != artifacts.KindMarkdown {
		t.Errorf("row kind = %s", rows.calls[0].Kind)
	}
	if rows.calls[0].RedactionCount != 0 {
		t.Errorf("redaction_count = %d with no materialized secrets, want 0", rows.calls[0].RedactionCount)
	}
	if rows.calls[0].RunID != pubRunID || rows.calls[0].AttemptID != "attempt-1" ||
		rows.calls[0].WorkerID != "worker-1" || rows.calls[0].FencingToken != 7 {
		t.Errorf("row lost the run correlation or the lease triple: %+v", rows.calls[0])
	}
	if rows.calls[0].Ref.SHA256 != sha256Hex(bytesFake.puts[0].body) ||
		rows.calls[0].Ref.SizeBytes != int64(len(bytesFake.puts[0].body)) {
		t.Errorf("row names bytes that are not the bytes put: %+v", rows.calls[0].Ref)
	}
	outs := pubOutputs(t, res)
	if outs["artifact_id"] != "artifact-1" {
		t.Errorf("outputs artifact_id = %v, want artifact-1", outs["artifact_id"])
	}
	if outs["digest"] != "sha256:"+rows.calls[0].Ref.SHA256 {
		t.Errorf("outputs digest = %v, want sha256:%s", outs["digest"], rows.calls[0].Ref.SHA256)
	}
	if !strings.HasPrefix(res.OutputsDigest, "sha256:") {
		t.Errorf("outputs_digest = %q, want a sha256-prefixed digest", res.OutputsDigest)
	}
	if len(res.ArtifactRefs) != 1 {
		t.Fatalf("artifact_refs = %d, want the artifact set for step 10's transaction", len(res.ArtifactRefs))
	}
	ref, ok := res.ArtifactRefs[0].(map[string]any)
	if !ok || ref["artifact_id"] != "artifact-1" || ref["sha256"] != rows.calls[0].Ref.SHA256 {
		t.Errorf("artifact_refs[0] = %v", res.ArtifactRefs[0])
	}
}

// TestArtifactPublishOutputJSONIsCanonical proves the `needs-attention.json`
// arm: indented JSON, and the same upstream outputs publish to the same digest
// twice — ADR-0020 D2's dedupe depends on the encoding being canonical rather
// than incidental, and a retry must not be able to double-count storage.
func TestArtifactPublishOutputJSONIsCanonical(t *testing.T) {
	value := map[string]any{"zeta": []any{1, 2}, "alpha": map[string]any{"b": "two", "a": 1}}
	first, second := &pubBytesFake{}, &pubBytesFake{}
	rows := &pubRowsFake{}
	for _, b := range []*pubBytesFake{first, second} {
		cfg := map[string]any{"name": "needs-attention.json", "kind": "json",
			"from": map[string]any{"mode": "output_json", "value": value}}
		res, err := pubExecutor(b, rows, nil, nil).Execute(context.Background(), pubClaim(cfg), nil)
		if err != nil || res.Status != AttemptStatusSucceeded {
			t.Fatalf("execute: status=%s err=%v detail=%s", res.Status, err, res.Detail)
		}
	}
	body := string(first.puts[0].body)
	want, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if body != string(want)+"\n" {
		t.Errorf("body is not canonical indented json:\n%s", body)
	}
	if !json.Valid(first.puts[0].body) {
		t.Error("kind=json payload does not parse")
	}
	if first.puts[0].in.MediaType != "application/json" {
		t.Errorf("media = %q", first.puts[0].in.MediaType)
	}
	if first.puts[0].in.Sensitivity != artifacts.SensitivityStandard {
		t.Errorf("sensitivity = %q, want the standard default", first.puts[0].in.Sensitivity)
	}
	if first.puts[0].in.MaxBytes != artifacts.LimitFor(artifacts.KindJSON) {
		t.Errorf("MaxBytes = %d, want the kind cap so the backend refuses rather than clips", first.puts[0].in.MaxBytes)
	}
	if second.puts[0].in.Name != first.puts[0].in.Name {
		t.Error("a retried attempt renamed the artifact")
	}
	if rows.calls[0].Ref.SHA256 != rows.calls[1].Ref.SHA256 {
		t.Errorf("digests differ for identical outputs: %s vs %s", rows.calls[0].Ref.SHA256, rows.calls[1].Ref.SHA256)
	}
}

// TestArtifactPublishRedactsMaterializedSecret is ADR-0020 D4 plus 12 case 12:
// a value this worker materialized must not reach an artifact, and the count
// that proves the scanner fired lands on the row and in the outputs.
func TestArtifactPublishRedactsMaterializedSecret(t *testing.T) {
	const secret = "ghp_0123456789abcdefABCDEF0123456789"
	redact := func(text string) (string, int) {
		if !strings.Contains(text, secret) {
			return text, 0
		}
		return strings.ReplaceAll(text, secret, "REDACTED"), 1
	}
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	cfg := map[string]any{"name": "leak.json", "kind": "json",
		"from": map[string]any{"mode": "output_json", "value": map[string]any{
			"token": secret, "note": "the token was rotated"}}}
	res, err := pubExecutor(bytesFake, rows, redact, nil).Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s (%s / %s), want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if len(bytesFake.puts) != 1 || len(rows.calls) != 1 {
		t.Fatalf("puts=%d rows=%d, want 1 and 1", len(bytesFake.puts), len(rows.calls))
	}
	if strings.Contains(string(bytesFake.puts[0].body), secret) {
		t.Errorf("the materialized secret reached the artifact bytes: %s", bytesFake.puts[0].body)
	}
	if !strings.Contains(string(bytesFake.puts[0].body), "REDACTED") {
		t.Error("no redaction marker in the artifact bytes")
	}
	if rows.calls[0].RedactionCount != 1 {
		t.Errorf("row redaction_count = %d, want 1 (ADR-0020 D4)", rows.calls[0].RedactionCount)
	}
	if got := pubOutputs(t, res)["redaction_count"]; got != 1 {
		t.Errorf("outputs redaction_count = %v, want 1", got)
	}
}

// TestArtifactPublishJSONStaysParsableOrRefuses covers the case the scan can
// create: a secret that is a bare number or an object key, whose replacement
// would leave kind=json bytes that do not parse. The honest answer is a refusal
// with nothing published — not a broken "evidence" artifact.
func TestArtifactPublishJSONStaysParsableOrRefuses(t *testing.T) {
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	redact := func(text string) (string, int) { return strings.ReplaceAll(text, `"key": "1"`, `"key": 1}}`), 1 }
	cfg := map[string]any{"name": "broken.json", "kind": "json",
		"from": map[string]any{"mode": "output_json", "value": map[string]any{"key": "1"}}}
	res, err := pubExecutor(bytesFake, rows, redact, nil).Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
		t.Fatalf("status/class = %s/%s, want failed/invalid_output (%s)", res.Status, res.ErrorClass, res.Detail)
	}
	if len(bytesFake.puts) != 0 || len(rows.calls) != 0 {
		t.Errorf("an unparseable artifact was written: puts=%d rows=%d", len(bytesFake.puts), len(rows.calls))
	}
}

// TestArtifactPublishWorkspacePathWithoutResolver is the "do not fake it"
// case: the mode needs § 4 step 3's tree, and a worker without the resolver
// says so as infra and names the seam instead of reading a guessed path.
func TestArtifactPublishWorkspacePathWithoutResolver(t *testing.T) {
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	cfg := map[string]any{"name": "report.md", "kind": "markdown",
		"from": map[string]any{"mode": "workspace_path", "path": "work/scratch/report.md"}}
	res, err := pubExecutor(bytesFake, rows, nil, nil).Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status/class = %s/%s, want failed/infra (%s)", res.Status, res.ErrorClass, res.Detail)
	}
	if !strings.Contains(res.Detail, "Workspaces") || !strings.Contains(res.Detail, "step 3") {
		t.Errorf("detail does not name the missing seam: %s", res.Detail)
	}
	if len(bytesFake.puts) != 0 || len(rows.calls) != 0 {
		t.Errorf("a refused publish still wrote: puts=%d rows=%d", len(bytesFake.puts), len(rows.calls))
	}
}

// TestArtifactPublishWorkspacePathReadsRunTree proves the mode works once the
// resolver is wired: the bytes come from the run's own tree.
func TestArtifactPublishWorkspacePathReadsRunTree(t *testing.T) {
	root := procExecScratch(t, "artifactpublish")
	dir := filepath.Join(root, "run", pubRunID, "work", "scratch")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "report.md"), []byte("# done\n\ngreen\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	cfg := map[string]any{"name": "report.md", "kind": "markdown",
		"from": map[string]any{"mode": "workspace_path", "path": "work/scratch/report.md"}}
	res, err := pubExecutor(bytesFake, rows, nil, RunWorkspacePaths{WorkspaceRoot: root}).
		Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s (%s / %s), want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if string(bytesFake.puts[0].body) != "# done\n\ngreen\n" {
		t.Errorf("body = %q, want the file's bytes verbatim", bytesFake.puts[0].body)
	}
}

// TestArtifactPublishWorkspacePathRefusesEscape is the path-discipline half of
// the same mode: a pipeline document does not get to read outside the run tree.
// The candidate is cleaned *into* the tree before it is opened, so the walk-up
// resolves to a file the run does not have — the honest terminal is
// invalid_output, and the host file's bytes never reach the backend.
func TestArtifactPublishWorkspacePathRefusesEscape(t *testing.T) {
	root := procExecScratch(t, "artifactpublish")
	if err := os.WriteFile(root+".outside", []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(root + ".outside") }()
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	cfg := map[string]any{"name": "stolen.md", "kind": "markdown",
		"from": map[string]any{"mode": "workspace_path", "path": "../" + filepath.Base(root) + ".outside"}}
	res, err := pubExecutor(bytesFake, rows, nil, RunWorkspacePaths{WorkspaceRoot: root}).
		Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status == AttemptStatusSucceeded {
		t.Fatalf("a path outside the run tree published: %s", bytesFake.puts[0].body)
	}
	if res.ErrorClass != ErrorClassInvalidOutput {
		t.Errorf("class = %s, want invalid_output (%s)", res.ErrorClass, res.Detail)
	}
	for _, put := range bytesFake.puts {
		if strings.Contains(string(put.body), "host secret") {
			t.Fatalf("the escape read the host file: %s", put.body)
		}
	}
	if len(rows.calls) != 0 {
		t.Errorf("row writes = %d, want 0", len(rows.calls))
	}
}

// TestArtifactPublishStaleFenceWritesOnce is ADR-0016 § 9.2's worker half: the
// fence refuses the row, and "stop writing" means exactly that — one Put, one
// attempted row, no retry, no event, and an honest infra failure.
func TestArtifactPublishStaleFenceWritesOnce(t *testing.T) {
	bytesFake := &pubBytesFake{}
	rows := &pubRowsFake{err: fmt.Errorf("postgres: publish artifact on a stolen lease: %w", ErrLeaseLost)}
	cfg := map[string]any{"name": "evidence.json", "kind": "json",
		"from": map[string]any{"mode": "output_json", "value": map[string]any{"approved": true}}}
	res, err := pubExecutor(bytesFake, rows, nil, nil).Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status/class = %s/%s, want failed/infra (%s)", res.Status, res.ErrorClass, res.Detail)
	}
	if !strings.Contains(res.Detail, "stale") {
		t.Errorf("detail does not name the stale fence: %s", res.Detail)
	}
	if len(bytesFake.puts) != 1 {
		t.Errorf("puts = %d, want 1 (no retry after the fence refused)", len(bytesFake.puts))
	}
	if len(rows.calls) != 1 {
		t.Errorf("row writes = %d, want 1", len(rows.calls))
	}
}

// TestArtifactPublishRequiresBothSeams keeps the wiring failure honest too: a
// half-wired executor reports infra and publishes nothing rather than writing
// bytes nobody can read.
func TestArtifactPublishRequiresBothSeams(t *testing.T) {
	cfg := map[string]any{"from": map[string]any{"mode": "output_json", "value": map[string]any{"a": 1}}}
	bytesFake := &pubBytesFake{}
	res, err := pubExecutor(bytesFake, nil, nil, nil).Execute(context.Background(), pubClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status/class = %s/%s, want failed/infra", res.Status, res.ErrorClass)
	}
	if len(bytesFake.puts) != 0 {
		t.Errorf("puts = %d, want 0 without a row writer", len(bytesFake.puts))
	}
}

// TestArtifactPublishRefusesMissingSource checks the config-level refusals that
// must surface as invalid_output (the node's fault) rather than infra.
func TestArtifactPublishRefusesMissingSource(t *testing.T) {
	cases := map[string]map[string]any{
		"no from block":   {"kind": "json"},
		"no mode":         {"from": map[string]any{"value": map[string]any{}}},
		"null value":      {"from": map[string]any{"mode": "output_json", "value": nil}},
		"unknown mode":    {"from": map[string]any{"mode": "workspace_tar", "path": "x"}},
		"kind not json":   {"kind": "archive", "from": map[string]any{"mode": "output_json", "value": map[string]any{}}},
		"kind not a kind": {"kind": "spreadsheet", "from": map[string]any{"mode": "output_json", "value": map[string]any{}}},
	}
	for name, cfg := range cases {
		bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
		res, err := pubExecutor(bytesFake, rows, nil, RunWorkspacePaths{WorkspaceRoot: t.TempDir()}).
			Execute(context.Background(), pubClaim(cfg), nil)
		if err != nil {
			t.Fatalf("%s: execute: %v", name, err)
		}
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Errorf("%s: status/class = %s/%s, want failed/invalid_output (%s)", name, res.Status, res.ErrorClass, res.Detail)
		}
		if len(bytesFake.puts) != 0 || len(rows.calls) != 0 {
			t.Errorf("%s: refused publish wrote puts=%d rows=%d", name, len(bytesFake.puts), len(rows.calls))
		}
		if !strings.HasPrefix(res.Detail, "artifact.publish:") {
			t.Errorf("%s: detail does not name the kind: %s", name, res.Detail)
		}
	}
}

// pubRunValues is how cmd/communication/worker.go wires the § 4 step 9 scan:
// the values are answered per RUN (postgres.RunSecretValues reads
// secret_materializations for every attempt of the run and re-resolves them
// through the keyring), and the hook is built before the publish. internal/worker
// may not import postgres, so the fake is the shape of that seam; the real
// adapter is proven against Postgres in internal/store/postgres/
// run_secret_values_test.go. What this pins is the consumer's half: the
// publishing attempt materialized nothing of its own — the seam that M3 called
// Materialized.Redact is nil here (17ffa32) — and a run-scoped hook is what
// stands between an upstream node echoing a secret and that secret being
// published as evidence.
type pubRunValues struct {
	byRun map[string][][]byte
}

func (p *pubRunValues) redactorFor(runID string) func(string) (string, int) {
	values := p.byRun[runID]
	if len(values) == 0 {
		return nil // the real adapter returns nil for a run holding nothing
	}
	needles := make([]string, 0, len(values))
	for _, v := range values {
		needles = append(needles, string(v))
	}
	return func(text string) (string, int) {
		count := 0
		for _, needle := range needles {
			n := strings.Count(text, needle)
			if n == 0 {
				continue
			}
			text = strings.ReplaceAll(text, needle, "[REDACTED]")
			count += n
		}
		return text, count
	}
}

func TestArtifactPublishRedactsRunSecret(t *testing.T) {
	const (
		secretA = "ghp_runASentinelValue0123456789abcd"
		secretB = "ghp_runBSentinelValue0123456789abcd"
		runB    = "1f51cf22-4c2d-7abc-9def-0123456789ab"
	)
	values := &pubRunValues{byRun: map[string][][]byte{
		pubRunID: {[]byte(secretA)},
		runB:     {[]byte(secretB)},
	}}
	pubCfg := func(leaked string) map[string]any {
		return map[string]any{"name": "review-evidence.json", "kind": "json",
			"from": map[string]any{"mode": "output_json", "value": map[string]any{
				"token": leaked, "note": "the agent echoed its environment"}}}
	}

	// Run A's publish carries run A's secret: marker in the bytes, real count.
	bytesFake, rows := &pubBytesFake{}, &pubRowsFake{}
	res, err := pubExecutor(bytesFake, rows, values.redactorFor(pubRunID), nil).
		Execute(context.Background(), pubClaim(pubCfg(secretA)), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s (%s / %s), want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if len(bytesFake.puts) != 1 || len(rows.calls) != 1 {
		t.Fatalf("puts=%d rows=%d, want 1 and 1", len(bytesFake.puts), len(rows.calls))
	}
	body := string(bytesFake.puts[0].body)
	if strings.Contains(body, secretA) {
		t.Errorf("run A's secret reached published bytes: %s", body)
	}
	if !strings.Contains(body, "[REDACTED]") {
		t.Errorf("no redaction marker in published bytes: %s", body)
	}
	if rows.calls[0].RedactionCount != 1 {
		t.Errorf("row redaction_count = %d, want 1 (ADR-0020 D4: the count is the scan's, not a placeholder)",
			rows.calls[0].RedactionCount)
	}
	if got := pubOutputs(t, res)["redaction_count"]; got != 1 {
		t.Errorf("outputs redaction_count = %v, want 1", got)
	}

	// A different run of the same worker is scanned against its OWN values: run
	// B's payload is clean as far as run A's secret goes, and run B's own value
	// is what gets replaced.
	bytesFake, rows = &pubBytesFake{}, &pubRowsFake{}
	claim := pubClaim(pubCfg(secretB))
	claim.RunID = runB
	if _, err := pubExecutor(bytesFake, rows, values.redactorFor(runB), nil).
		Execute(context.Background(), claim, nil); err != nil {
		t.Fatalf("execute run B: %v", err)
	}
	if strings.Contains(string(bytesFake.puts[0].body), secretB) || rows.calls[0].RedactionCount != 1 {
		t.Errorf("run B's secret survived its own scan (count %d): %s",
			rows.calls[0].RedactionCount, bytesFake.puts[0].body)
	}

	// A run that holds nothing reports zero honestly — the executor does not
	// invent a count, and it does not fail: "the scanner ran and saw nothing"
	// stays distinguishable from "the scanner is broken" (ADR-0020 D4).
	bytesFake, rows = &pubBytesFake{}, &pubRowsFake{}
	clean := pubClaim(pubCfg("nothing-sensitive-here"))
	clean.RunID = runB
	if _, err := pubExecutor(bytesFake, rows, values.redactorFor("2f51cf22-4c2d-7abc-9def-0123456789ab"), nil).
		Execute(context.Background(), clean, nil); err != nil {
		t.Fatalf("execute with no values: %v", err)
	}
	if rows.calls[0].RedactionCount != 0 {
		t.Errorf("redaction_count = %d for a run holding no secret, want 0", rows.calls[0].RedactionCount)
	}
}
