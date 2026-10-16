package worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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
	return &ModelChat{
		BaseURL: base + "/v1",
		APIKey:  mcAPIKey,
		Models:  []string{"gpt-test", "reviewer-mini"},
		Timeout: 2 * time.Second,
	}
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
	if res.Checkpoint.OutputsDigest != "" {
		t.Errorf("model.chat owns no checkpoint: %#v", res.Checkpoint)
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
