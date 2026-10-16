package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/dbirks/communication/internal/artifacts"
)

// NodeKindModelChat is the § 4 step 8 node kind this executor runs, the
// catalogue name verbatim (attemptport.go's Kind comment). Without an
// executor for it the loop's refusalExecutor answers honestly — that is the
// designed behaviour when the worker has no endpoint configured, and the
// reason cmd/communication registers this kind only behind configuration.
const NodeKindModelChat = "model.chat"

// Caps and defaults for model.chat. The inline figure is § 6's 32 KiB outputs
// envelope that procexec.go enforces with the same named failure; § 4 step 8
// sends an over-cap payload to a kind=json artifact, which this executor does
// when a byte backend and the fenced row writer are wired (Bytes/Rows) and
// refuses with outputs_too_large when they are not — the honest terminal
// rather than a silently clipped answer.
const (
	modelChatInlineOutput = 32 << 10
	// modelChatPreviewMax bounds the inline text preview that travels beside a
	// spill artifact: the reader sees the head of the answer without the 32 KiB
	// envelope having to carry all of it (§ 4 step 8).
	modelChatPreviewMax = 4 << 10
	// modelChatBodyMax bounds how much of an endpoint's response body this
	// worker will buffer — a completion is a JSON object, not a stream.
	modelChatBodyMax = 4 << 20
	// modelChatDefaultTimeout is the request arm when the claim carries no
	// node deadline; a hung endpoint must not hold a lease forever.
	modelChatDefaultTimeout = 120 * time.Second
	// modelChatNameMax keeps a node's model name from inflating a detail.
	modelChatResponseName = "node_outputs"
)

// Named failure codes beside ADR-0023 § 7's closed class enum — the same split
// artifactpublish.go documents: one event, two names.
const (
	ModelChatCodeConfig      = "invalid_model_chat_config"
	ModelChatCodeNotAllowed  = "model_not_allowed"
	ModelChatCodeSecretScan  = "secret_in_request"
	ModelChatCodeSchemaFail  = "response_schema_mismatch"
	ModelChatCodeOutputsLg   = "outputs_too_large"
	ModelChatCodeBadResponse = "malformed_completion"
)

// ModelChat executes model.chat attempts (docs/m4-contract.md § 4 step 8): ONE
// OpenAI-compatible chat completion issued from the worker, JSON-schema
// constrained, no ACP process, no conversation and no transcript row.
//
// Endpoint, model allowlist and API key are WORKER configuration — never
// pipeline content (ADR-0024 Security: this is a new egress path, so the
// operator, not the author, decides where content goes). The request body is
// redaction-scanned like an artifact before a single byte leaves the process:
// ADR-0018's "no secret in a prompt" rule outranks the node's intent, and a
// body the scan flags is refused with zero HTTP requests made.
type ModelChat struct {
	// BaseURL is the OpenAI-compatible server root (e.g.
	// https://api.example.com/v1); the call is POST {BaseURL}/chat/completions.
	BaseURL string
	// APIKey is the bearer token. It is only ever written into a request
	// header: it never enters a detail string, a log line or outputs.
	APIKey string
	// Models is the allowlist. Empty means this worker serves no model, and
	// every node is refused by name — fail closed rather than forward
	// arbitrary model selectors to a credentialed endpoint.
	Models []string
	// Redact replaces every occurrence of a value this run materialized with
	// a marker and reports how many. Nil means nothing was materialized for
	// the run, which is the same shape artifactpublish.go accepts.
	Redact func(text string) (string, int)
	// HTTPClient is injectable for tests; nil uses a client with no own
	// timeout (the per-request deadline from the claim is the arm then).
	HTTPClient *http.Client
	// Timeout overrides modelChatDefaultTimeout for claims with no deadline.
	Timeout time.Duration
	// Bytes is the ADR-0020 artifact byte backend. Optional: it is needed only
	// for § 4 step 8's over-cap spill, where the full reply becomes a
	// kind=json artifact instead of an inline outputs row. Nil keeps the
	// honest outputs_too_large refusal.
	Bytes artifacts.Store
	// Rows is the fenced artifact-row writer (the same AttemptArtifactWriter
	// artifact.publish is given). Optional like Bytes; without it the spilled
	// bytes would be an orphan in the backend with no row and no
	// artifact.created event, which is not a publish.
	Rows AttemptArtifactWriter
	// ArtifactName overrides the spill artifact's name (defaults to
	// model_chat_outputs.json). Injectable for tests.
	ArtifactName string
	Logger       *slog.Logger
}

const modelChatDefaultArtifactName = "model_chat_outputs.json"

var _ AttemptExecutor = (*ModelChat)(nil)

func (m *ModelChat) logger() *slog.Logger {
	if m != nil && m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

// EndpointHost is the host the ops page must name (§ 4 step 8's egress
// honesty). Empty when unconfigured; never includes credentials.
func (m *ModelChat) EndpointHost() string {
	if m == nil || strings.TrimSpace(m.BaseURL) == "" {
		return ""
	}
	u, err := url.Parse(strings.TrimSpace(m.BaseURL))
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Host
}

func (m *ModelChat) allows(model string) bool {
	for _, allowed := range m.Models {
		if strings.TrimSpace(allowed) == model {
			return true
		}
	}
	return false
}

// mcBad is a refusal with its class and code already decided, shaped exactly
// like artifactpublish.go's artBad: bounded detail (FailAttempt's own cap) and
// one output_errors entry carrying this executor's code.
func mcBad(class, code, detail string) *AttemptResult {
	res := AttemptResult{Status: AttemptStatusFailed, ErrorClass: class, Detail: bounded(detail, 512)}
	if code != "" {
		res.OutputErrors = []any{map[string]any{
			"code":    code,
			"message": bounded(detail, 400),
		}}
	}
	return &res
}

// modelChatSpec is the resolved node config (§ 4 step 8's request, and the
// schema branch in pipeline-v1alpha1: model, messages, responseSchema,
// temperature, maxTokens, provider). Bindings are already resolved by the
// advancer (attemptport.go's Config comment) — this executor never evaluates
// an expression, so a value that is still an expression is a binding_error.
type modelChatSpec struct {
	model       string
	provider    string
	messages    []any
	schema      any
	temperature *float64
	maxTokens   *int
}

func modelChatString(v any) (string, bool) {
	s, ok := v.(string)
	return strings.TrimSpace(s), ok
}

// parseModelChat reads the claim's config. Every rejection is a fact about the
// node (invalid_output / binding_error), never about the endpoint.
func parseModelChat(c AttemptClaim) (*modelChatSpec, *AttemptResult) {
	cfg := c.Config
	if cfg == nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: the attempt carries no resolved config, so there is no prompt to send (§ 4 step 8)")
	}
	spec := &modelChatSpec{}
	model, ok := modelChatString(cfg["model"])
	if !ok {
		if _, absent := cfg["model"]; absent {
			return nil, mcBad(ErrorClassBindingError, ModelChatCodeConfig,
				"model.chat: config.model resolved to a non-string; the advancer resolves bindings and the worker never evaluates them (§ 4 step 14)")
		}
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: config.model is required by the schema and is missing from the resolved config")
	}
	spec.model = model
	if v, present := cfg["provider"]; present {
		s, ok := modelChatString(v)
		if !ok {
			return nil, mcBad(ErrorClassBindingError, ModelChatCodeConfig,
				"model.chat: config.provider resolved to a non-string; the worker never evaluates bindings")
		}
		spec.provider = s
	}
	raw, present := cfg["messages"]
	if !present {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: config.messages is required by the schema (1..64 entries) and is missing")
	}
	msgs, ok := raw.([]any)
	if !ok || len(msgs) == 0 {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: config.messages must resolve to a non-empty array of message objects")
	}
	for i, msg := range msgs {
		m, ok := msg.(map[string]any)
		if !ok {
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
				fmt.Sprintf("model.chat: config.messages[%d] is not an object (schema: items are objects with role/content)", i))
		}
		// ADR-0029 makes content a binding position, so a claim whose config this
		// control plane could not hydrate would otherwise POST an unevaluated
		// expression tree to the endpoint. The worker never evaluates (§ 4 step 14):
		// the marker stays a visible binding_error, exactly as agent.acp's prompt.
		if isUnresolved(m) {
			return nil, mcBad(ErrorClassBindingError, ModelChatCodeConfig,
				fmt.Sprintf("model.chat: config.messages[%d] still carries unresolved bindings; claim resolution interpolates message content (ADR-0027/ADR-0029) and the worker never evaluates it (§ 4 step 14)", i))
		}
		role, _ := m["role"].(string)
		switch role {
		case "system", "user", "assistant":
		default:
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
				fmt.Sprintf("model.chat: config.messages[%d].role = %q; the schema admits system, user or assistant (ADR-0029)", i, role))
		}
		content, isStr := m["content"].(string)
		if !isStr {
			if isUnresolved(m["content"]) {
				return nil, mcBad(ErrorClassBindingError, ModelChatCodeConfig,
					fmt.Sprintf("model.chat: config.messages[%d].content still carries unresolved bindings (ADR-0027/ADR-0029)", i))
			}
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
				fmt.Sprintf("model.chat: config.messages[%d].content must be a string after resolution, got %T", i, m["content"]))
		}
		if content == "" {
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
				fmt.Sprintf("model.chat: config.messages[%d].content is empty; the schema's bindingText requires minLength 1", i))
		}
	}
	if len(msgs) > 64 {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			fmt.Sprintf("model.chat: config.messages holds %d entries, over the schema's 64", len(msgs)))
	}
	spec.messages = msgs
	if v, present := cfg["responseSchema"]; present {
		spec.schema = v
	}
	if v, present := cfg["temperature"]; present {
		f, ok := jsonNumber(v)
		if !ok {
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
				"model.chat: config.temperature must be a number between 0 and 2")
		}
		spec.temperature = &f
	}
	if v, present := cfg["maxTokens"]; present {
		f, ok := jsonNumber(v)
		if !ok {
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
				"model.chat: config.maxTokens must be an integer between 1 and 200000")
		}
		n := int(f)
		spec.maxTokens = &n
	}
	return spec, nil
}

func jsonNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// Execute implements AttemptExecutor. Config → allowlist → request body →
// secret scan (before any byte leaves the process) → one POST → schema
// validation → outputs. Nothing is journalled: § 4 step 8 forbids a
// conversation, and the loop owns the attempt's own events.
func (m *ModelChat) Execute(ctx context.Context, c AttemptClaim, _ AttemptSink) (AttemptResult, error) {
	if m == nil {
		return failedResult(ErrorClassInfra,
			"model.chat: executor is not wired (contract § 4 step 8)"), nil
	}
	spec, bad := parseModelChat(c)
	if bad != nil {
		return *bad, nil
	}
	host := m.EndpointHost()
	if host == "" {
		return *mcBad(ErrorClassInfra, ModelChatCodeConfig,
			"model.chat: this worker has no model endpoint configured (COMMUNICATION_MODEL_CHAT_BASE_URL is unset), "+
				"so the node's request cannot leave the host (§ 4 step 8's egress honesty)"), nil
	}
	if !m.allows(spec.model) {
		return *mcBad(ErrorClassBindingError, ModelChatCodeNotAllowed, fmt.Sprintf(
			"model.chat: model %q is not in this worker's allowlist (COMMUNICATION_MODEL_CHAT_MODELS); "+
				"the endpoint is %s and the operator, not the pipeline, chooses which models may be called",
			bounded(spec.model, 120), host)), nil
	}
	body, bad := m.requestBody(spec)
	if bad != nil {
		return *bad, nil
	}
	status, resp, bad := m.post(ctx, c, host, body)
	if bad != nil {
		return *bad, nil
	}
	text, bad := completionText(status, resp)
	if bad != nil {
		return *bad, nil
	}
	var parsed any
	if spec.schema != nil {
		var bad *AttemptResult
		if parsed, bad = validateCompletion(spec, text); bad != nil {
			return *bad, nil
		}
	}
	out, err := m.buildOutputs(ctx, c, spec, host, text, parsed)
	if err != nil {
		return *err, nil
	}
	return out, nil
}

// buildOutputs is § 4 step 8's inline-or-spill rule: the validated reply fits
// in outputs when the 32 KiB envelope (§ 6) allows it, and otherwise travels
// as a kind=json artifact with a bounded preview and the ref left inline.
func (m *ModelChat) buildOutputs(ctx context.Context, c AttemptClaim, spec *modelChatSpec, host, text string, parsed any) (AttemptResult, *AttemptResult) {
	full := map[string]any{"text": text, "model": spec.model, "endpoint": host}
	if parsed != nil {
		full["json"] = parsed
	}
	raw, err := json.Marshal(full)
	if err != nil {
		return AttemptResult{}, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: the validated completion cannot be serialized for outputs: "+bounded(err.Error(), 300))
	}
	if len(raw) <= modelChatInlineOutput {
		return AttemptResult{
			Status:        AttemptStatusSucceeded,
			Outcome:       "passed",
			Outputs:       full,
			OutputsDigest: "sha256:" + sha256Hex(raw),
		}, nil
	}
	if m == nil || m.Bytes == nil || m.Rows == nil {
		res := *mcBad(ErrorClassInvalidOutput, ModelChatCodeOutputsLg, fmt.Sprintf(
			"model.chat: outputs envelope is %d bytes over the 32 KiB inline cap (§ 6); § 4 step 8 sends that "+
				"payload as a kind=json artifact, and this worker has no artifact byte backend/fenced row writer wired, "+
				"so the honest answer is a refusal rather than a clipped answer", len(raw)))
		return AttemptResult{}, &res
	}
	return m.spillOutputs(ctx, c, spec, host, full, len(raw))
}

// requestBody marshals the wire call and runs ADR-0018's gate over it: the
// body is scanned exactly like an artifact, and a body the run's redactor
// flags is refused with NOTHING SENT. Redaction-replace-and-send is not an
// option here the way it is for artifact.publish — a prompt whose content was
// secretly a token is a node that interpolated secret material, which § 4 step
// 8 forbids outright, and a silently rewritten prompt would misreport what the
// model was actually asked.
func (m *ModelChat) requestBody(spec *modelChatSpec) ([]byte, *AttemptResult) {
	req := map[string]any{"model": spec.model, "messages": spec.messages}
	if spec.temperature != nil {
		req["temperature"] = *spec.temperature
	}
	if spec.maxTokens != nil {
		req["max_tokens"] = *spec.maxTokens
	}
	if spec.schema != nil {
		// § 4 step 8's "JSON-schema-constrained": the node's declared output
		// schema goes on the wire as response_format.json_schema, so the
		// endpoint is asked for the shape the pipeline will validate.
		req["response_format"] = map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   modelChatResponseName,
				"schema": spec.schema,
				"strict": false,
			},
		}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: the resolved messages cannot be serialized as json: "+bounded(err.Error(), 300))
	}
	if m.Redact != nil {
		if _, n := m.Redact(string(body)); n > 0 {
			return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeSecretScan, fmt.Sprintf(
				"model.chat: the request body interpolates %d value(s) this run materialized from secrets — "+
					"ADR-0018's no-secret-in-a-prompt rule applies to this kind too, so NO request was sent "+
					"(§ 4 step 8); the node must bind non-secret content", n))
		}
	}
	return body, nil
}

func (m *ModelChat) client() *http.Client {
	if m.HTTPClient != nil {
		return m.HTTPClient
	}
	return &http.Client{}
}

func (m *ModelChat) requestTimeout() time.Duration {
	if m.Timeout > 0 {
		return m.Timeout
	}
	return modelChatDefaultTimeout
}

// post issues the single call and maps transport reality onto ADR-0023 § 7's
// classes: 5xx and transport failures are infra, 429 is infra carrying the
// Retry-After the endpoint offered, a deadline is timeout, and any other 4xx is
// infra too (a rejected request is a wiring/endpoint fact the advancer cannot
// fix by retrying the node's author). Response bodies are redaction-scanned
// before they can reach a browser-visible detail.
func (m *ModelChat) post(ctx context.Context, c AttemptClaim, host string, body []byte) (int, []byte, *AttemptResult) {
	endpoint := strings.TrimRight(strings.TrimSpace(m.BaseURL), "/") + "/chat/completions"
	reqCtx, cancel, armed := m.armRequest(ctx, c)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, mcBad(ErrorClassInfra, ModelChatCodeConfig,
			"model.chat: could not build the request for "+host+": "+bounded(err.Error(), 300))
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if m.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+m.APIKey)
	}
	resp, err := m.client().Do(httpReq)
	if err != nil {
		// Never err.Error() unscanned: a url.Error quotes the URL, and an
		// endpoint that echoes a header into its error text must not put the
		// key in the attempt's detail. The key is never in body or URL, so the
		// residual risk is the message alone — scan it anyway.
		detail := m.scanText(bounded(err.Error(), 300))
		switch {
		case ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled):
			// shutdown / cancel-requested: the loop picks the honest terminal.
			return 0, nil, &AttemptResult{Status: ""}
		case errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded):
			return 0, nil, mcBad(ErrorClassTimeout, "", fmt.Sprintf(
				"model.chat: no completion from %s within %s (the attempt's deadline arm, § 4 step 8)",
				host, armed))
		default:
			return 0, nil, mcBad(ErrorClassInfra, "",
				"model.chat: request to "+host+" failed: "+detail)
		}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, modelChatBodyMax+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return 0, nil, mcBad(ErrorClassTimeout, "", fmt.Sprintf(
				"model.chat: %s stopped mid-response within %s", host, armed))
		}
		return 0, nil, mcBad(ErrorClassInfra, "",
			"model.chat: reading the response from "+host+": "+m.scanText(bounded(err.Error(), 300)))
	}
	if len(raw) > modelChatBodyMax {
		return resp.StatusCode, nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeBadResponse, fmt.Sprintf(
			"model.chat: %s sent a response over %d bytes; a completion is one json object, so it is not a response "+
				"this worker can attribute to the node", host, modelChatBodyMax))
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return resp.StatusCode, raw, nil
	case resp.StatusCode == http.StatusTooManyRequests:
		wait := strings.TrimSpace(resp.Header.Get("Retry-After"))
		if wait == "" {
			wait = "not offered"
		}
		return resp.StatusCode, raw, mcBad(ErrorClassInfra, "", fmt.Sprintf(
			"model.chat: %s rate-limited the completion (http %d, Retry-After: %s); the advancer's retry policy owns the next attempt",
			host, resp.StatusCode, bounded(wait, 60)))
	case resp.StatusCode >= 500:
		return resp.StatusCode, raw, mcBad(ErrorClassInfra, "", fmt.Sprintf(
			"model.chat: %s returned http %d: %s", host, resp.StatusCode, m.scanText(bounded(string(raw), 200))))
	default:
		return resp.StatusCode, raw, mcBad(ErrorClassInfra, "", fmt.Sprintf(
			"model.chat: %s rejected the completion request (http %d): %s",
			host, resp.StatusCode, m.scanText(bounded(string(raw), 200))))
	}
}

// armRequest gives the call the attempt's own deadline when it has one, and the
// configured fallback arm otherwise.
func (m *ModelChat) armRequest(ctx context.Context, c AttemptClaim) (context.Context, context.CancelFunc, string) {
	if !c.DeadlineAt.IsZero() {
		remaining := time.Until(c.DeadlineAt)
		if remaining <= 0 {
			// Already expired: context.WithDeadline gives an immediately
			// cancelled context, which surfaces as timeout below.
			remaining = time.Millisecond
		}
		reqCtx, cancel := context.WithDeadline(ctx, c.DeadlineAt)
		return reqCtx, cancel, remaining.Truncate(time.Millisecond).String()
	}
	reqCtx, cancel := context.WithTimeout(ctx, m.requestTimeout())
	return reqCtx, cancel, m.requestTimeout().String()
}

func (m *ModelChat) scanText(text string) string {
	if m.Redact == nil {
		return text
	}
	out, _ := m.Redact(text)
	return out
}

// completionEnvelope is the subset of an OpenAI-compatible response this kind
// reads. `error` is the shape gateway-style endpoints answer with on 200.
type completionEnvelope struct {
	Choices []struct {
		Message *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		Text         string `json:"text"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// completionText pulls the one message § 4 step 8 allows: text, nothing else.
func completionText(status int, raw []byte) (string, *AttemptResult) {
	var env completionEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", mcBad(ErrorClassInvalidOutput, ModelChatCodeBadResponse, fmt.Sprintf(
			"model.chat: the endpoint answered http %d with something that is not a completion envelope: %s",
			status, bounded(err.Error(), 200)))
	}
	if env.Error != nil {
		return "", mcBad(ErrorClassInfra, "", fmt.Sprintf(
			"model.chat: the endpoint reported an error on http %d: %s",
			status, bounded(strings.TrimSpace(env.Error.Type+": "+env.Error.Message), 240)))
	}
	if len(env.Choices) == 0 {
		return "", mcBad(ErrorClassInvalidOutput, ModelChatCodeBadResponse, fmt.Sprintf(
			"model.chat: the completion envelope on http %d carries no choices, so the node has no text", status))
	}
	msg := env.Choices[0].Message
	var content string
	switch {
	case msg != nil && len(msg.Content) > 0:
		var s string
		if err := json.Unmarshal(msg.Content, &s); err == nil {
			content = s
		} else {
			// Some endpoints answer content as content-part arrays
			// (chat/completions "text" parts). Concatenate the text parts; any
			// other part type is a shape this kind does not understand.
			parts, ok := contentParts(msg.Content)
			if !ok {
				return "", mcBad(ErrorClassInvalidOutput, ModelChatCodeBadResponse,
					"model.chat: the completion message content is neither a string nor text parts (OpenAI-compatible shape expected)")
			}
			content = parts
		}
	case env.Choices[0].Text != "":
		content = env.Choices[0].Text
	default:
		return "", mcBad(ErrorClassInvalidOutput, ModelChatCodeBadResponse,
			"model.chat: the completion carries no message content, so the node has no text")
	}
	return content, nil
}

func contentParts(raw json.RawMessage) (string, bool) {
	var parts []struct {
		Type string          `json:"type"`
		Text json.RawMessage `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return "", false
	}
	var sb strings.Builder
	for _, p := range parts {
		if p.Type != "text" || len(p.Text) == 0 {
			return "", false
		}
		var s string
		if err := json.Unmarshal(p.Text, &s); err != nil {
			return "", false
		}
		sb.WriteString(s)
	}
	return sb.String(), true
}

// modelChatSchemaURL is a synthetic resource name for the one-shot compiler;
// schema.go:30's comment is why the URL is needed at all (internal $refs).
const modelChatSchemaURL = "https://communication.dev/attempt/model-chat-response.schema.json"

// validateCompletion is § 4 step 8's rule that the reply is checked against
// the node's declared output schema BEFORE outputs are set: an unvalidated
// payload would become a downstream binding the compiler never promised.
func validateCompletion(spec *modelChatSpec, text string) (any, *AttemptResult) {
	var instance any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&instance); err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeSchemaFail, fmt.Sprintf(
			"model.chat: the node declared a responseSchema but the completion is not json: %s",
			bounded(err.Error(), 200)))
	}
	doc, err := json.Marshal(spec.schema)
	if err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: config.responseSchema is not a json schema object: "+bounded(err.Error(), 200))
	}
	var sdoc any
	if err := json.Unmarshal(doc, &sdoc); err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: config.responseSchema does not serialize as json: "+bounded(err.Error(), 200))
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(modelChatSchemaURL, sdoc); err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: config.responseSchema is not a valid json schema document: "+bounded(err.Error(), 200))
	}
	schema, err := compiler.Compile(modelChatSchemaURL)
	if err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: could not compile config.responseSchema: "+bounded(err.Error(), 200))
	}
	if err := schema.Validate(instance); err != nil {
		return nil, mcBad(ErrorClassInvalidOutput, ModelChatCodeSchemaFail,
			"model.chat: the completion failed the node's declared responseSchema (§ 4 step 8): "+
				bounded(err.Error(), 300))
	}
	return instance, nil
}

// spillOutputs is § 4 step 8's over-cap branch: "its text lands in outputs
// and, above the inline cap, in a kind=json artifact". The full validated
// reply becomes the artifact's bytes — scanned through the run's secret seam
// first, exactly as artifact.publish scans before it writes — Put into the
// byte backend, then recorded by the fenced row writer, which writes the
// artifact row and its artifact.created in one transaction and neither for a
// stale lease. Outputs then carry a bounded preview plus the ref, never the
// payload (§ 6's inline cap is what made this a spill in the first place).
func (m *ModelChat) spillOutputs(ctx context.Context, c AttemptClaim, spec *modelChatSpec, host string, full map[string]any, fullSize int) (AttemptResult, *AttemptResult) {
	content, err := marshalCanonicalJSON(full)
	if err != nil {
		return AttemptResult{}, mcBad(ErrorClassInvalidOutput, ModelChatCodeConfig,
			"model.chat: the over-cap completion cannot be serialized as the spill artifact's json: "+
				bounded(err.Error(), 300))
	}
	content, redactions := m.redactBytes(content)
	if !json.Valid(content) {
		// artifactpublish.go's rule verbatim: a kind=json artifact that does
		// not parse would be a broken record presented as evidence, and
		// redaction outranks nothing — so nothing is published.
		return AttemptResult{}, mcBad(ErrorClassInvalidOutput, ModelChatCodeOutputsLg, fmt.Sprintf(
			"model.chat: the secret scan rewrote the spill payload into unparseable json (%d bytes); a "+
				"kind=json artifact must parse, so nothing was published", len(content)))
	}
	name := strings.TrimSpace(m.ArtifactName)
	if name == "" {
		name = modelChatDefaultArtifactName
	}
	kind := artifacts.KindJSON
	media := defaultArtifactMedia(kind)
	if limit := artifacts.LimitFor(kind); limit > 0 && int64(len(content)) > limit {
		return AttemptResult{}, mcBad(ErrorClassInvalidOutput, ModelChatCodeOutputsLg, fmt.Sprintf(
			"model.chat: completion is %d bytes, over the %s kind cap of %d bytes (ADR-0020 D2) and over the "+
				"32 KiB inline cap (§ 6) — neither outputs nor a kind=json artifact can carry it",
			len(content), kind, limit))
	}

	ref, err := m.Bytes.Put(ctx, artifacts.Input{
		ProjectID:   c.ProjectID,
		Name:        artifacts.SanitizeFilename(name),
		Kind:        kind,
		MediaType:   media,
		Sensitivity: artifacts.SensitivityStandard,
		MaxBytes:    artifacts.LimitFor(kind),
		Body:        bytes.NewReader(content),
	})
	if err != nil {
		return AttemptResult{}, mcBad(ErrorClassInfra, "",
			"model.chat: put spill artifact bytes: "+bounded(err.Error(), 400))
	}
	id, err := m.Rows.PublishAttemptArtifact(ctx, AttemptArtifactInput{
		OrganizationID:  c.OrganizationID,
		ProjectID:       c.ProjectID,
		RunID:           c.RunID,
		NodeExecutionID: c.NodeExecutionID,
		AttemptID:       c.AttemptID,
		WorkerID:        c.WorkerID,
		FencingToken:    c.FencingToken,
		Name:            name,
		Kind:            kind,
		MediaType:       media,
		Sensitivity:     artifacts.SensitivityStandard,
		Ref:             ref,
		RedactionCount:  redactions,
	})
	if err != nil {
		if errors.Is(err, ErrLeaseLost) {
			// § 4 step 10's "I am dead": stop writing, no retry, no second
			// Put. The object stays in the backend unreferenced for the orphan
			// sweep; the attempt reports the lost fence and publishes nothing.
			return AttemptResult{}, mcBad(ErrorClassInfra, "", "model.chat: the fenced artifact writer refused a "+
				"stale lease (this worker's fencing token is no longer current): bytes are in the backend "+
				"unreferenced, no artifact row and no artifact.created event were written")
		}
		return AttemptResult{}, mcBad(ErrorClassInfra, "",
			"model.chat: publish spill artifact row: "+bounded(err.Error(), 400))
	}
	if id == "" {
		return AttemptResult{}, mcBad(ErrorClassInfra, "", "model.chat: the fenced artifact writer reported "+
			"success with no artifact id, which the attempt cannot name in outputs")
	}

	text, _ := modelChatString(full["text"])
	outputs := map[string]any{
		"text_preview":    modelChatPreview(text, modelChatPreviewMax),
		"truncated":       true,
		"model":           spec.model,
		"endpoint":        host,
		"artifact_id":     id,
		"kind":            kind,
		"name":            name,
		"media_type":      media,
		"sha256":          ref.SHA256,
		"digest":          "sha256:" + ref.SHA256,
		"size_bytes":      ref.SizeBytes,
		"inline_bytes":    fullSize,
		"redaction_count": redactions,
	}
	rawOut, err := json.Marshal(outputs)
	if err != nil || len(rawOut) > modelChatInlineOutput {
		return AttemptResult{}, mcBad(ErrorClassInvalidOutput, ModelChatCodeOutputsLg, fmt.Sprintf(
			"model.chat: spilled outputs envelope is %d bytes over the 32 KiB inline cap (§ 6)", len(rawOut)))
	}
	m.logger().Debug("model.chat spilled an over-cap completion to a kind=json artifact",
		slog.String("attempt_id", c.AttemptID), slog.String("artifact_id", id),
		slog.Int("inline_bytes", fullSize), slog.Int("redaction_count", redactions))
	return AttemptResult{
		Status:        AttemptStatusSucceeded,
		Outcome:       "passed",
		Outputs:       outputs,
		OutputsDigest: "sha256:" + sha256Hex(rawOut),
		ArtifactRefs: []any{map[string]any{
			"artifact_id":     id,
			"kind":            kind,
			"name":            name,
			"media_type":      media,
			"sha256":          ref.SHA256,
			"size_bytes":      ref.SizeBytes,
			"storage_backend": ref.StorageBackend,
			"storage_key":     ref.StorageKey,
		}},
	}, nil
}

// redactBytes runs the run's secret seam over bytes destined for the byte
// backend — artifactpublish.go's same seam, with its same ADR-0020 D4 rule
// that a missing scanner reports 0 rather than an invented number.
func (m *ModelChat) redactBytes(content []byte) ([]byte, int) {
	if m == nil || m.Redact == nil {
		return content, 0
	}
	out, n := m.Redact(string(content))
	if n < 0 {
		n = 0
	}
	return []byte(out), n
}

// modelChatPreview keeps the inline head of a spilled reply inside its budget
// without cutting a rune in half, so a browser never renders U+FFFD where a
// character was.
func modelChatPreview(text string, max int) string {
	if max <= 0 || len(text) <= max {
		return text
	}
	cut := max - len("…")
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "…"
}
