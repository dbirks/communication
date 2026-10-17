package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
)

// The § 4 step 8 executor's unit layer: a real HTTP server (httptest) behind
// the real net/http client, so the wire behaviour the contract pins is observed
// rather than asserted against a fake transport — the completion is validated
// against the node's declared schema BEFORE outputs are set, transport reality
// maps onto ADR-0023 § 7's classes, and a body the run's redactor flags is
// refused with zero requests made.

type mcReply struct {
	status  int
	body    string
	dur     time.Duration
	retryAt string
}

// mcServer is the endpoint under test: it records every request and replies
// with whatever the case needs.
type mcServer struct {
	t     *testing.T
	reply chan mcReply
	reqs  atomic.Int64
	body  atomic.Value // []byte
	hdr   atomic.Value // http.Header
	srv   *httptest.Server
}

func newMCServer(t *testing.T) *mcServer {
	s := &mcServer{t: t, reply: make(chan mcReply, 8)}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.reqs.Add(1)
		raw, _ := readAll(r.Body)
		s.body.Store(raw)
		s.hdr.Store(r.Header.Clone())
		if r.URL.Path != "/v1/chat/completions" {
			s.t.Errorf("model.chat posted to %s, want /v1/chat/completions", r.URL.Path)
		}
		rep := <-s.reply
		if rep.dur > 0 {
			select {
			case <-time.After(rep.dur):
			case <-r.Context().Done():
				return
			}
		}
		if rep.retryAt != "" {
			w.Header().Set("Retry-After", rep.retryAt)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rep.status)
		_, _ = w.Write([]byte(rep.body))
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func readAll(r io.Reader) ([]byte, error) { return io.ReadAll(r) }

func (s *mcServer) send(r mcReply) { s.reply <- r }

func (s *mcServer) requests() int64 { return s.reqs.Load() }

func (s *mcServer) lastRequest() map[string]any {
	raw, _ := s.body.Load().([]byte)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		s.t.Fatalf("request body is not json: %v (%s)", err, raw)
	}
	return m
}

func sHdr(s *mcServer) http.Header {
	h, _ := s.hdr.Load().(http.Header)
	return h
}

func mcChatReply(content string) string {
	body, err := json.Marshal(map[string]any{
		"choices": []any{map[string]any{
			"message":       map[string]any{"role": "assistant", "content": content},
			"finish_reason": "stop",
		}},
	})
	if err != nil {
		panic(err)
	}
	return string(body)
}

func mcClaim(cfg map[string]any) AttemptClaim {
	return AttemptClaim{
		AttemptID: "0f51cf22-4c2d-7abc-9def-0123456789ab", RunID: pubRunID,
		ProjectID: "p1", OrganizationID: "o1", WorkerID: "w1", FencingToken: 3,
		NodeID: "review", Kind: NodeKindModelChat, AttemptNumber: 1,
		Config: cfg,
	}
}

const mcAPIKey = "sk-unit-test-token-do-not-echo"

func mcExecutor(base string) *ModelChat {
	// Wired the way cmd/communication wires it (modelchat_boundary_test.go
	// names the seam): a BOUND run workspace plus the capture's read seam.
	// A completion with no boundary is refused by the store's boundary
	// transaction (D-024 is same-volume only), so a fixture that pretends
	// otherwise could not observe the checkpoint the terminal writes.
	m := &ModelChat{
		BaseURL: base + "/v1",
		APIKey:  mcAPIKey,
		Models:  []string{"gpt-test", "reviewer-mini"},
		Timeout: 2 * time.Second,
	}
	m.Checkpoints = mcBoundary()
	m.BoundaryGit = mcBoundaryGit()
	return m
}

func mcConfig() map[string]any {
	return map[string]any{
		"model": "gpt-test",
		"messages": []any{map[string]any{
			"role": "user", "content": "summarize the diff",
		}},
		"responseSchema": map[string]any{
			"type":     "object",
			"required": []any{"verdict"},
			"properties": map[string]any{
				"verdict": map[string]any{"type": "string"},
			},
		},
		"temperature": 0.2,
		"maxTokens":   float64(64),
	}
}

func TestModelChatHappyPath(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"approve","notes":"clean"}`)})
	res, err := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(mcConfig()), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s class=%s detail=%s, want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	out, ok := res.Outputs.(map[string]any)
	if !ok {
		t.Fatalf("outputs = %#v, want an object", res.Outputs)
	}
	if out["text"] != `{"verdict":"approve","notes":"clean"}` {
		t.Errorf("outputs.text = %v", out["text"])
	}
	if out["model"] != "gpt-test" || out["endpoint"] == "" {
		t.Errorf("outputs must name the model and the egress endpoint (ADR-0024): %#v", out)
	}
	if jsonOf, ok := out["json"].(map[string]any); !ok || jsonOf["verdict"] != "approve" {
		t.Errorf("outputs.json = %#v, want the schema-validated payload", out["json"])
	}
	if !strings.HasPrefix(res.OutputsDigest, "sha256:") {
		t.Errorf("outputs digest = %q", res.OutputsDigest)
	}
	// ADR-0023 § 6: a successful node boundary carries the checkpoint row its
	// terminal transaction writes — the store refuses a completion that names
	// no volume (D-024 is same-volume only), so a completion without one is
	// lost the moment the boundary transaction refuses it.
	if res.Checkpoint.VolumeID != "vol-mc" || res.Checkpoint.WorkspaceID != "ws-mc" ||
		res.Checkpoint.OutputsDigest != res.OutputsDigest {
		t.Errorf("completion must carry the run workspace's boundary: %#v", res.Checkpoint)
	}
	if len(res.Checkpoint.RepoStates) != 1 || res.Checkpoint.RepoStates[0].HeadCommit != "bbbb2222" {
		t.Errorf("boundary states = %#v, want the captured ref, not an un-captured boundary", res.Checkpoint.RepoStates)
	}
	req := srv.lastRequest()
	if req["model"] != "gpt-test" || req["temperature"] != 0.2 {
		t.Errorf("wire request = %#v", req)
	}
	if req["max_tokens"] != float64(64) {
		t.Errorf("max_tokens = %v", req["max_tokens"])
	}
	rf, ok := req["response_format"].(map[string]any)
	if !ok || rf["type"] != "json_schema" {
		t.Fatalf("response_format = %#v, want json_schema (§ 4 step 8)", req["response_format"])
	}
	js, _ := rf["json_schema"].(map[string]any)
	sch, _ := js["schema"].(map[string]any)
	if sch["type"] != "object" {
		t.Errorf("response_format.json_schema.schema = %#v, want the node's declared schema", js["schema"])
	}
	if got := sHdr(srv).Get("Authorization"); got != "Bearer "+mcAPIKey {
		t.Errorf("Authorization header = %q, want the configured bearer token", got)
	}
	if raw, _ := srv.body.Load().([]byte); strings.Contains(string(raw), mcAPIKey) {
		t.Errorf("the api key must never enter the request body: %s", raw)
	}
}

// The completion is checked against the node's declared schema BEFORE outputs
// are set (§ 4 step 8): a wrong-shaped reply is the node's invalid_output, not
// a downstream binding the compiler never promised.
func TestModelChatSchemaMismatch(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":42}`)})
	res, _ := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(mcConfig()), nil)
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
		t.Fatalf("terminal = %s/%s, want failed/invalid_output", res.Status, res.ErrorClass)
	}
	if res.Outputs != nil && len(res.OutputErrors) == 0 {
		t.Fatalf("invalid_output with no evidence: %#v", res)
	}
	if !strings.Contains(res.Detail, "responseSchema") {
		t.Errorf("detail must name the schema arm: %s", res.Detail)
	}
	if res.Outputs != nil {
		t.Errorf("outputs must stay empty on a schema mismatch: %#v", res.Outputs)
	}
	srv.send(mcReply{status: 200, body: mcChatReply("not json at all")})
	res2, _ := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(mcConfig()), nil)
	if res2.Status != AttemptStatusFailed || res2.ErrorClass != ErrorClassInvalidOutput {
		t.Fatalf("non-json reply = %s/%s, want failed/invalid_output", res2.Status, res2.ErrorClass)
	}
}

// Transport reality → ADR-0023 § 7's classes, verbatim from § 4 step 8's
// honesty rule: a 5xx is the endpoint's fault (infra), a 429 carries the
// Retry-After the endpoint offered, and a deadline is timeout.
func TestModelChatEndpointFailures(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 503, body: `{"error":{"message":"upstream blew up"}}`})
	res, _ := mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(mcConfig()), nil)
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("5xx = %s/%s, want failed/infra", res.Status, res.ErrorClass)
	}
	if !strings.Contains(res.Detail, "503") {
		t.Errorf("detail should name the status: %s", res.Detail)
	}

	srv.send(mcReply{status: 429, body: `{}`, retryAt: "17"})
	res, _ = mcExecutor(srv.srv.URL).Execute(context.Background(), mcClaim(mcConfig()), nil)
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("429 = %s/%s, want failed/infra", res.Status, res.ErrorClass)
	}
	if !strings.Contains(res.Detail, "Retry-After: 17") {
		t.Errorf("429 detail must carry Retry-After, got %q", res.Detail)
	}

	// Slow server past the node's deadline arm: the attempt's own timeout wins.
	srv.send(mcReply{status: 200, body: mcChatReply(`{"verdict":"late"}`), dur: 3 * time.Second})
	c := mcClaim(mcConfig())
	c.DeadlineAt = time.Now().Add(150 * time.Millisecond)
	res, _ = mcExecutor(srv.srv.URL).Execute(context.Background(), c, nil)
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassTimeout {
		t.Fatalf("slow endpoint = %s/%s (%s), want failed/timeout", res.Status, res.ErrorClass, res.Detail)
	}
	if srv.requests() != 3 {
		t.Errorf("requests = %d, want one per case", srv.requests())
	}
}

// ADR-0018's rule, applied to this kind by § 4 step 8: the request body is
// redaction-scanned like an artifact, and a body that interpolates a value the
// run materialized is refused BEFORE any HTTP call. Zero requests is the point
// of the test — a redact-and-send implementation would pass every other case.
func TestModelChatRefusesSecretInRequestBody(t *testing.T) {
	srv := newMCServer(t)
	chat := mcExecutor(srv.srv.URL)
	const token = "s3cr3t-materialized-value"
	chat.Redact = func(text string) (string, int) {
		n := strings.Count(text, token)
		if n == 0 {
			return text, 0
		}
		return strings.ReplaceAll(text, token, "[REDACTED]"), n
	}
	cfg := mcConfig()
	cfg["messages"] = []any{map[string]any{"role": "user", "content": "the deploy token is " + token}}
	res, err := chat.Execute(context.Background(), mcClaim(cfg), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
		t.Fatalf("secret body = %s/%s, want failed/invalid_output", res.Status, res.ErrorClass)
	}
	if !strings.Contains(res.Detail, "NO request was sent") {
		t.Errorf("detail must state nothing left the process: %s", res.Detail)
	}
	if strings.Contains(res.Detail, token) {
		t.Errorf("the detail must not echo the secret value: %s", res.Detail)
	}
	if len(res.OutputErrors) != 1 {
		t.Fatalf("output_errors = %#v, want one entry naming %s", res.OutputErrors, ModelChatCodeSecretScan)
	}
	entry, _ := res.OutputErrors[0].(map[string]any)
	if entry["code"] != ModelChatCodeSecretScan {
		t.Errorf("output_errors = %#v, want code %s", res.OutputErrors, ModelChatCodeSecretScan)
	}
	if got := srv.requests(); got != 0 {
		t.Fatalf("endpoint received %d requests; the scan must fire before the call", got)
	}
}

// The endpoint and the allowlist are worker configuration, never pipeline
// content: an unconfigured worker must not send anything anywhere, and a model
// the operator did not list is refused by name.
func TestModelChatConfigurationDoor(t *testing.T) {
	srv := newMCServer(t)
	chat := mcExecutor(srv.srv.URL)
	chat.BaseURL = ""
	res, _ := chat.Execute(context.Background(), mcClaim(mcConfig()), nil)
	if res.ErrorClass != ErrorClassInfra || !strings.Contains(res.Detail, "COMMUNICATION_MODEL_CHAT_BASE_URL") {
		t.Fatalf("no-endpoint = %s/%s %q", res.Status, res.ErrorClass, res.Detail)
	}
	chat.BaseURL = srv.srv.URL + "/v1"
	cfg := mcConfig()
	cfg["model"] = "gpt-anything-goes"
	res, _ = chat.Execute(context.Background(), mcClaim(cfg), nil)
	if res.ErrorClass != ErrorClassBindingError {
		t.Fatalf("off-allowlist model = %s, want binding_error", res.ErrorClass)
	}
	if len(res.OutputErrors) == 0 || !strings.Contains(res.Detail, "COMMUNICATION_MODEL_CHAT_MODELS") {
		t.Errorf("refusal must name the allowlist: %#v", res)
	}
	if got := srv.requests(); got != 0 {
		t.Fatalf("allowlist refusal made %d requests", got)
	}
	// An unresolved binding stays the advancer's bug to name (§ 4 step 14).
	cfg = mcConfig()
	cfg["model"] = map[string]any{"expression": "nodes.pick.outputs.model"}
	res, _ = chat.Execute(context.Background(), mcClaim(cfg), nil)
	if res.ErrorClass != ErrorClassBindingError {
		t.Fatalf("unresolved model binding = %s/%s, want binding_error", res.Status, res.ErrorClass)
	}
}

// The live pass-34 refusal: the canonical document carries an integer
// (int64) for temperature: 0, and the executor's type check only accepted
// float64/int/json.Number, so an in-range value was refused before the model
// was ever called. The numeric reads must accept every JSON-number shape —
// and the ranges the schema declares (0…2, integer 1…200000) must actually
// be checked, not merely the shape.
func TestModelChatNumericConfig(t *testing.T) {
	temps := []struct {
		name  string
		value any
		want  float64
		ok    bool
	}{
		{"int64 zero", int64(0), 0, true},
		{"float zero", 0.0, 0, true},
		{"int one", 1, 1, true},
		{"int64 two", int64(2), 2, true},
		{"float 0.5", 0.5, 0.5, true},
		{"number 0", json.Number("0"), 0, true},
		{"too high", 2.5, 0, false},
		{"negative", int64(-1), 0, false},
		{"quoted number", "1", 0, false},
	}
	for _, tc := range temps {
		t.Run("temperature "+tc.name, func(t *testing.T) {
			cfg := mcConfig()
			cfg["temperature"] = tc.value
			spec, bad := parseModelChat(mcClaim(cfg))
			if tc.ok {
				if bad != nil || spec == nil {
					t.Fatalf("temperature %v (type %T) refused: %v", tc.value, tc.value, bad)
				}
				if spec.temperature == nil || *spec.temperature != tc.want {
					t.Fatalf("temperature = %v, want %v", spec.temperature, tc.want)
				}
				return
			}
			if bad == nil || bad.ErrorClass != ErrorClassInvalidOutput || !strings.Contains(bad.Detail, "between 0 and 2") {
				t.Fatalf("temperature %v (type %T) was not refused with the range named: %+v", tc.value, tc.value, bad)
			}
		})
	}
	maxTokens := []struct {
		name  string
		value any
		want  int
		ok    bool
	}{
		{"int64", int64(200), 200, true},
		{"float64", float64(64), 64, true},
		{"json number", json.Number("1000"), 1000, true},
		{"zero", int64(0), 0, false},
		{"fractional", 1.5, 0, false},
		{"quoted number", "100", 0, false},
		{"over the cap", int64(200001), 0, false},
	}
	for _, tc := range maxTokens {
		t.Run("maxTokens "+tc.name, func(t *testing.T) {
			cfg := mcConfig()
			cfg["maxTokens"] = tc.value
			spec, bad := parseModelChat(mcClaim(cfg))
			if tc.ok {
				if bad != nil || spec == nil {
					t.Fatalf("maxTokens %v (type %T) refused: %v", tc.value, tc.value, bad)
				}
				if spec.maxTokens == nil || *spec.maxTokens != tc.want {
					t.Fatalf("maxTokens = %v, want %v", spec.maxTokens, tc.want)
				}
				return
			}
			if bad == nil || bad.ErrorClass != ErrorClassInvalidOutput || !strings.Contains(bad.Detail, "integer between 1 and 200000") {
				t.Fatalf("maxTokens %v (type %T) was not refused with the range named: %+v", tc.value, tc.value, bad)
			}
		})
	}
}

// ------------------------------------------------- § 4 step 8's over-cap spill

// mcSpillConfig is a schema the big reply below satisfies.
func mcSpillConfig() map[string]any {
	return map[string]any{
		"model": "gpt-test",
		"messages": []any{map[string]any{
			"role": "user", "content": "summarize the diff",
		}},
		"responseSchema": map[string]any{
			"type":     "object",
			"required": []any{"verdict"},
			"properties": map[string]any{
				"verdict": map[string]any{"type": "string"},
				"notes":   map[string]any{"type": "string"},
			},
		},
	}
}

// mcBigReply is a schema-valid completion whose text envelope is well over the
// 32 KiB inline cap, and which carries a value the run's redactor knows.
func mcBigReply() string {
	return `{"verdict":"approve","notes":"` + strings.Repeat("a", 40_000) +
		` TOPSECRETVALUE ` + strings.Repeat("b", 20_000) + `"}`
}

func mcSpillClaim() AttemptClaim {
	c := mcClaim(mcSpillConfig())
	c.NodeExecutionID = "node-exec-1"
	c.NodeID = "review"
	c.NodeInstanceKey = "review[1]"
	return c
}

func mcSpillExecutor(base string, bytes *pubBytesFake, rows *pubRowsFake) *ModelChat {
	m := mcExecutor(base)
	// Conditionally assigned so a nil fake stays a nil seam — the executor's
	// "backend not wired" check is an interface-nil check, not a typed-nil one.
	if bytes != nil {
		m.Bytes = bytes
	}
	if rows != nil {
		m.Rows = rows
	}
	if bytes != nil {
		// The same run-secret seam the request gate uses: it replaces the one
		// value this run materialized wherever it appears.
		m.Redact = func(text string) (string, int) {
			n := strings.Count(text, "TOPSECRETVALUE")
			if n == 0 {
				return text, 0
			}
			return strings.ReplaceAll(text, "TOPSECRETVALUE", "[REDACTED]"), n
		}
	}
	return m
}

func TestModelChatSpillToArtifact(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(mcBigReply())})
	bytesFake, rowsFake := &pubBytesFake{}, &pubRowsFake{id: "artifact-spill-1"}
	res, err := mcSpillExecutor(srv.srv.URL, bytesFake, rowsFake).
		Execute(context.Background(), mcSpillClaim(), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusSucceeded {
		t.Fatalf("status = %s class=%s detail=%s, want succeeded", res.Status, res.ErrorClass, res.Detail)
	}
	if srv.requests() != 1 {
		t.Fatalf("requests = %d, want 1", srv.requests())
	}
	if len(bytesFake.puts) != 1 {
		t.Fatalf("byte-backend puts = %d, want exactly 1", len(bytesFake.puts))
	}
	if len(rowsFake.calls) != 1 {
		t.Fatalf("fenced row writes = %d, want exactly 1", len(rowsFake.calls))
	}
	in := bytesFake.puts[0].in
	if in.Kind != artifacts.KindJSON || in.MediaType != "application/json" {
		t.Errorf("spill artifact is %s/%s, want json/application/json", in.Kind, in.MediaType)
	}
	if in.ProjectID != "p1" {
		t.Errorf("spill artifact project = %q, want the claim's project", in.ProjectID)
	}
	if !json.Valid(bytesFake.puts[0].body) {
		t.Errorf("kind=json spill artifact does not parse (%d bytes)", len(bytesFake.puts[0].body))
	}
	if strings.Contains(string(bytesFake.puts[0].body), "TOPSECRETVALUE") {
		t.Error("the spill artifact was published unscanned — the run's secret value is in its bytes")
	}
	row := rowsFake.calls[0]
	if row.AttemptID != "0f51cf22-4c2d-7abc-9def-0123456789ab" || row.FencingToken != 3 ||
		row.RunID != pubRunID || row.NodeExecutionID != "node-exec-1" ||
		row.WorkerID != "w1" || row.OrganizationID != "o1" || row.ProjectID != "p1" {
		t.Errorf("row write carries the wrong lease triple: %+v", row)
	}
	// The value appears twice in the payload (the raw text and the parsed
	// json copy), and the scan counts what it replaced (ADR-0020 D4).
	if row.Kind != artifacts.KindJSON || row.RedactionCount != 2 {
		t.Errorf("row kind=%s redactions=%d, want json/2", row.Kind, row.RedactionCount)
	}
	out, ok := res.Outputs.(map[string]any)
	if !ok {
		t.Fatalf("outputs are %T, want an object", res.Outputs)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal outputs: %v", err)
	}
	if len(raw) > modelChatInlineOutput {
		t.Errorf("inline outputs are %d bytes, over the 32 KiB cap the spill exists to respect", len(raw))
	}
	if out["artifact_id"] != "artifact-spill-1" || out["truncated"] != true {
		t.Errorf("outputs do not name the spill artifact: %v", out["artifact_id"])
	}
	if _, full := out["text"]; full {
		t.Error("outputs carry the full text as well as the artifact — the payload must travel as the ref")
	}
	preview, _ := out["text_preview"].(string)
	if preview == "" || len(preview) > modelChatPreviewMax || !strings.HasSuffix(preview, "…") {
		t.Errorf("text_preview is %d bytes, want a bounded …-terminated head", len(preview))
	}
	refs := res.ArtifactRefs
	if len(refs) != 1 {
		t.Fatalf("artifact_refs = %#v, want exactly one entry", res.ArtifactRefs)
	}
	ref, _ := refs[0].(map[string]any)
	if ref["artifact_id"] != "artifact-spill-1" || ref["kind"] != artifacts.KindJSON ||
		ref["sha256"] == "" || ref["storage_key"] == "" {
		t.Errorf("artifact_refs entry = %v, want the published artifact's identity", ref)
	}
	if out["digest"] != "sha256:"+ref["sha256"].(string) {
		t.Errorf("outputs digest %v does not match the artifact ref %v", out["digest"], ref["sha256"])
	}
	if res.OutputsDigest != "sha256:"+sha256Hex(raw) {
		t.Errorf("outputs_digest %q is not the digest of the inline envelope", res.OutputsDigest)
	}
}

// TestModelChatSpillStaleFencePublishesNothing is § 4 step 10's "I am dead":
// the fenced writer refused, so the attempt fails with no artifact_refs and no
// outputs naming an artifact — the bytes sit in the backend unreferenced for
// the orphan sweep, and this worker does not retry the write.
func TestModelChatSpillStaleFencePublishesNothing(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(mcBigReply())})
	bytesFake := &pubBytesFake{}
	rowsFake := &pubRowsFake{err: ErrLeaseLost}
	res, err := mcSpillExecutor(srv.srv.URL, bytesFake, rowsFake).
		Execute(context.Background(), mcSpillClaim(), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status = %s class = %s detail=%s, want failed/infra", res.Status, res.ErrorClass, res.Detail)
	}
	if !strings.Contains(res.Detail, "stale lease") || !strings.Contains(res.Detail, "unreferenced") {
		t.Errorf("detail does not name the lost fence and the orphaned bytes: %s", res.Detail)
	}
	if len(rowsFake.calls) != 1 {
		t.Fatalf("row writes = %d, want the one refused call", len(rowsFake.calls))
	}
	if len(res.ArtifactRefs) != 0 || res.Outputs != nil {
		t.Errorf("a stale fence published something: refs=%v outputs=%v", res.ArtifactRefs, res.Outputs)
	}
	if srv.requests() != 1 {
		t.Errorf("requests = %d, want 1 (the reply was real, only the row was refused)", srv.requests())
	}
}

// TestModelChatSpillWithoutBackendRefuses is the honest refusal the executor
// shipped with: with no byte backend (or no row writer) wired, an over-cap
// completion fails invalid_output/outputs_too_large rather than publishing a
// half-artifact or clipping the answer silently.
func TestModelChatSpillWithoutBackendRefuses(t *testing.T) {
	for name, tc := range map[string]struct {
		bytes *pubBytesFake
		rows  *pubRowsFake
	}{
		"no byte backend": {bytes: nil, rows: &pubRowsFake{}},
		"no row writer":   {bytes: &pubBytesFake{}, rows: nil},
		"nothing wired":   {bytes: nil, rows: nil},
	} {
		t.Run(name, func(t *testing.T) {
			srv := newMCServer(t)
			srv.send(mcReply{status: 200, body: mcChatReply(mcBigReply())})
			res, err := mcSpillExecutor(srv.srv.URL, tc.bytes, tc.rows).
				Execute(context.Background(), mcSpillClaim(), nil)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
				t.Fatalf("status = %s class = %s detail=%s, want failed/invalid_output", res.Status, res.ErrorClass, res.Detail)
			}
			if !strings.Contains(res.Detail, "outputs_too_large") && !strings.Contains(res.Detail, "inline cap") {
				t.Errorf("detail does not name the inline cap it hit: %s", res.Detail)
			}
			errs, _ := json.Marshal(res.OutputErrors)
			if !strings.Contains(string(errs), ModelChatCodeOutputsLg) {
				t.Errorf("output_errors = %s, want code %s", errs, ModelChatCodeOutputsLg)
			}
			if tc.bytes != nil && len(tc.bytes.puts) != 0 {
				t.Errorf("%d puts against an unwired writer", len(tc.bytes.puts))
			}
			if tc.rows != nil && len(tc.rows.calls) != 0 {
				t.Errorf("%d row writes against an unwired backend", len(tc.rows.calls))
			}
			if len(res.ArtifactRefs) != 0 {
				t.Errorf("refusal carries artifact_refs: %v", res.ArtifactRefs)
			}
		})
	}
}

// TestModelChatSpillPutFailureWritesNoRow keeps the ordering artifactpublish.go
// pins: a byte backend that refuses means no artifact row and no event.
func TestModelChatSpillPutFailureWritesNoRow(t *testing.T) {
	srv := newMCServer(t)
	srv.send(mcReply{status: 200, body: mcChatReply(mcBigReply())})
	bytesFake := &pubBytesFake{putErr: errors.New("disk full")}
	rowsFake := &pubRowsFake{}
	res, err := mcSpillExecutor(srv.srv.URL, bytesFake, rowsFake).
		Execute(context.Background(), mcSpillClaim(), nil)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
		t.Fatalf("status = %s class = %s, want failed/infra", res.Status, res.ErrorClass)
	}
	if len(rowsFake.calls) != 0 {
		t.Errorf("a failed Put still wrote %d artifact rows", len(rowsFake.calls))
	}
}
