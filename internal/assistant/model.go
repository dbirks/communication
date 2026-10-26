package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// This file is the minimal OpenAI-compatible chat-completions client. It is a
// deliberate copy of the wire half of internal/worker/modelchat.go rather than
// a factored shared package: the worker's version is bound to AttemptClaim /
// AttemptResult and ADR-0023 § 7's error classes, and refactoring it would
// change the worker's behaviour for no benefit to the worker (ADR-0034 gives
// serve its own egress site, with the worker's validation rules copied).

// chatMessage is one envelope message. Content is a string or null (a
// tool_calls-only assistant turn has no text).
type chatMessage struct {
	Role    string  `json:"role"`
	Content *string `json:"content"`
	// ToolCalls is present only on an assistant turn the model asked for tools.
	ToolCalls []toolCallRequest `json:"tool_calls,omitempty"`
}

type toolCallRequest struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function functionCall `json:"function"`
}

type functionCall struct {
	Name string `json:"name"`
	// Arguments is the model's raw JSON arguments string; it is parsed, capped
	// and validated by the registry, never trusted.
	Arguments string `json:"arguments"`
}

type toolSpec struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

func text(s string) *string { return &s }

type chatRequest struct {
	Model          string         `json:"model"`
	Messages       []chatMessage  `json:"messages"`
	Tools          []toolSpec     `json:"tools,omitempty"`
	ToolChoice     string         `json:"tool_choice,omitempty"`
	Temperature    *float64       `json:"temperature,omitempty"`
	MaxTokens      *int           `json:"max_tokens,omitempty"`
	ResponseFormat map[string]any `json:"response_format,omitempty"`
	// ChatTemplateKwargs is passed through verbatim to vLLM-style
	// `chat_template_kwargs`. The draft-proposal turn sets
	// {"enable_thinking": false} so a reasoning model answers in under a
	// second instead of spending its budget thinking (the proposals route
	// would otherwise die on the broker timeout). The /ask path never sets
	// it, so that request body is byte-identical to before this field.
	ChatTemplateKwargs map[string]any `json:"chat_template_kwargs,omitempty"`
}

// reply is the subset of a completion this broker reads. `error` is the shape
// gateway-style endpoints answer with even on a 200.
type reply struct {
	Choices []struct {
		Message *struct {
			Content   json.RawMessage   `json:"content"`
			ToolCalls []toolCallRequest `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// modelAnswer is one completion: the text (empty when the model asked for
// tools) and the tool calls it requested.
type modelAnswer struct {
	Text      string
	ToolCalls []toolCallRequest
	Finished  bool
}

// complete issues ONE POST, retried on transient upstream conditions — any
// HTTP 5xx (gateway/upstream failure: 500, 502, 503, 504 …), HTTP 429, the
// model loading/unavailable error envelope (the 404 "the model was reloading"
// turn-killer and the gateway-style error envelope some endpoints answer even
// on a 200) — plus connection errors: up to MaxAttempts attempts with
// exponential backoff and jitter (Retry-After honoured, capped by
// RetryBackoffMaxSeconds), never past the per-call deadline or the caller's
// context. The user-facing error after the last attempt is the one a single
// attempt would have produced, and answers that are not transient (other 4xx,
// malformed envelopes) are never retried. Every assistant egress path — the
// ask loop, the conversation runner, draft proposals and their re-ask, the
// approval summaries and interpretations — goes through this one loop.
func (b *Broker) complete(ctx context.Context, req chatRequest) (modelAnswer, *Failure) {
	ctx, cancel := context.WithTimeout(ctx, b.timeout())
	defer cancel()

	var (
		ans        modelAnswer
		bad        *Failure
		retryAfter time.Duration
		retry      bool
	)
	for attempt := 1; ; attempt++ {
		ans, bad, retryAfter, retry = b.completeOnce(ctx, req, attempt)
		if !retry || attempt >= MaxAttempts {
			return ans, bad
		}
		b.logger().Info("assistant completion retrying after a transient upstream failure",
			slog.String("endpoint", b.EndpointHost()),
			slog.Int("attempt", attempt+1))
		if err := b.sleep(ctx, retryAfter); err != nil {
			// Context cancelled (or its deadline hit) while backing off: the
			// per-call deadline and the caller's context are the ceiling, so stop
			// retrying rather than fire into the void.
			return modelAnswer{}, failure(FailModelTimeout, b.EndpointHost()+" stopped before its next completion attempt", http.StatusGatewayTimeout)
		}
	}
}

// completeOnce is ONE completion attempt (1-based `attempt` numbers the backoff
// when the condition is transient): build the request, send it, map the
// outcome to a *Failure, and report whether the condition was transient and how
// long to wait before the next attempt. Transient answers come back with a
// retry verdict; the retry budget lives in complete.
func (b *Broker) completeOnce(ctx context.Context, req chatRequest, attempt int) (modelAnswer, *Failure, time.Duration, bool) {
	ctx, cancel := context.WithTimeout(ctx, b.timeout())
	defer cancel()

	body, err := json.Marshal(req)
	if err != nil {
		return modelAnswer{}, failure(FailBadModelResponse, "cannot serialize the request: "+err.Error(), http.StatusInternalServerError), 0, false
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, b.cfg.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return modelAnswer{}, failure(FailModelUnreachable, "could not build the request for "+b.EndpointHost(), http.StatusServiceUnavailable), 0, false
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if b.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+b.cfg.APIKey)
	}

	resp, err := b.client().Do(httpReq)
	if err != nil {
		// err.Error() quotes the URL, and an endpoint that echoes a header into
		// its error text must not put the key in a browser-visible detail, so
		// only the host is named.
		if ctx.Err() != nil {
			// Cancelled (shutdown / cancel-requested) or its deadline hit: not a
			// transient condition, so never retry.
			if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
				return modelAnswer{}, failure(FailModelTimeout, fmt.Sprintf("no completion from %s within %s", b.EndpointHost(), b.timeout().Truncate(time.Millisecond)), http.StatusGatewayTimeout), 0, false
			}
			return modelAnswer{}, failure(FailModelUnreachable, "request to "+b.EndpointHost()+" failed", http.StatusServiceUnavailable), 0, false
		}
		// Transport-level failure (connection refused/reset mid-flight, TLS
		// reset): transient from the turn's point of view, back off and retry.
		return modelAnswer{}, failure(FailModelUnreachable, "request to "+b.EndpointHost()+" failed", http.StatusServiceUnavailable), retryBackoff(attempt), true
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, BodyLimit+1))
	if err != nil {
		if ctx.Err() != nil {
			// Cancelled/deadline mid-response: the per-call deadline or the
			// caller's context ended it, not the endpoint.
			if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
				return modelAnswer{}, failure(FailModelTimeout, b.EndpointHost()+" stopped mid-response", http.StatusGatewayTimeout), 0, false
			}
			return modelAnswer{}, failure(FailModelUnreachable, "reading the response from "+b.EndpointHost(), http.StatusServiceUnavailable), 0, false
		}
		// The connection dropped mid-response: transient, back off and retry.
		return modelAnswer{}, failure(FailModelUnreachable, "reading the response from "+b.EndpointHost(), http.StatusServiceUnavailable), retryBackoff(attempt), true
	}
	if len(raw) > BodyLimit {
		return modelAnswer{}, failure(FailBadModelResponse, fmt.Sprintf("%s sent a response over %d bytes", b.EndpointHost(), BodyLimit), http.StatusBadGateway), 0, false
	}
	retryAfter, retry := transientRetry(resp.StatusCode, raw, resp.Header.Get("Retry-After"), attempt)
	if retry {
		_, bad := parseCompletion(resp.StatusCode, raw, b.EndpointHost())
		return modelAnswer{}, bad, retryAfter, true
	}
	ans, bad := parseCompletion(resp.StatusCode, raw, b.EndpointHost())
	return ans, bad, 0, false
}

// transientRetry reports whether a completion answered with a transient
// upstream condition should be attempted again, and how long to wait before the
// next attempt (1-based `attempt` numbers the backoff). Retriable: any 5xx
// (gateway/upstream failure — a plain 500 and a 504 are the same outage as a
// 502/503), 429 (rate limited), and the model loading/unavailable error
// envelope: the 404 "model was reloading" turn-killer, and the gateway-style
// error envelope some endpoints answer even on a 200. Transport-level failures
// are retried by the caller. Any other 4xx is a rejected request, not a
// transient condition, and never retried; neither is a malformed completion.
func transientRetry(status int, raw []byte, retryAfter string, attempt int) (time.Duration, bool) {
	switch {
	case status >= http.StatusInternalServerError, status == http.StatusTooManyRequests:
		return retryAfterOrBackoff(retryAfter, attempt), true
	case status >= 400:
		if status == http.StatusNotFound && modelUnavailable(string(raw)) {
			return retryAfterOrBackoff(retryAfter, attempt), true
		}
		return 0, false
	}
	if modelUnavailable(string(raw)) {
		return retryAfterOrBackoff(retryAfter, attempt), true
	}
	return 0, false
}

// retryAfterOrBackoff honours the endpoint's Retry-After when it offered one —
// capped by RetryBackoffMaxSeconds, because the retry policy's own ceiling
// bounds the wait an endpoint may impose — and otherwise computes the
// exponential backoff for the next retry.
func retryAfterOrBackoff(retryAfter string, attempt int) time.Duration {
	if d, ok := retryAfterDelay(retryAfter); ok && d > 0 {
		if limit := time.Duration(RetryBackoffMaxSeconds) * time.Second; d > limit {
			d = limit
		}
		return d
	}
	return retryBackoff(attempt)
}

// retryBackoff is the delay before retry `attempt` (the 1-based number of the
// failed attempt): baseSeconds * multiplier^(attempt-1), clamped to maxSeconds,
// ±20% jitter — the ADR-0023 § 7 retry backoff formula.
func retryBackoff(attempt int) time.Duration {
	d := time.Duration(RetryBackoffBaseSeconds) * time.Second
	for i := 1; i < attempt; i++ {
		d *= time.Duration(RetryBackoffMultiplier)
	}
	if d > time.Duration(RetryBackoffMaxSeconds)*time.Second {
		d = time.Duration(RetryBackoffMaxSeconds) * time.Second
	}
	return time.Duration(float64(d) * (0.8 + rand.Float64()*0.4))
}

// retryAfterDelay reads a Retry-After header: delay-seconds or an HTTP-date.
func retryAfterDelay(header string) (time.Duration, bool) {
	v := strings.TrimSpace(header)
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d, true
		}
	}
	return 0, false
}

// modelUnavailable reports whether a 404 completion refusal means the model is
// not currently available (e.g. reloading) — retryable — rather than a bad
// request. The refusal travels in the gateway-style error envelope.
func modelUnavailable(raw string) bool {
	var env struct {
		Error *struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &env); err != nil || env.Error == nil {
		return false
	}
	joined := strings.ToLower(env.Error.Message + " " + env.Error.Type)
	for _, marker := range []string{"loading", "reload", "unavailable", "not available", "not currently available"} {
		if strings.Contains(joined, marker) {
			return true
		}
	}
	return false
}

func parseCompletion(status int, raw []byte, host string) (modelAnswer, *Failure) {
	// Status class first: a gateway that answers 500 in html is still an
	// unreachable endpoint, and calling that a malformed completion would blame
	// the pipeline of the request for an egress outage (ADR-0023 § 7's split,
	// carried onto this route by ADR-0034).
	switch {
	case status >= 500:
		return modelAnswer{}, failure(FailModelUnreachable, fmt.Sprintf("%s returned http %d", host, status), http.StatusServiceUnavailable)
	case status == http.StatusTooManyRequests:
		return modelAnswer{}, failure(FailModelUnreachable, fmt.Sprintf("%s rate-limited the completion (http 429)", host), http.StatusServiceUnavailable)
	case status >= 400:
		return modelAnswer{}, failure(FailBadModelResponse, fmt.Sprintf("%s rejected the completion request (http %d)", host, status), http.StatusBadGateway)
	}
	var env reply
	if err := json.Unmarshal(raw, &env); err != nil {
		return modelAnswer{}, failure(FailBadModelResponse, fmt.Sprintf("%s answered http %d with something that is not a completion envelope", host, status), http.StatusBadGateway)
	}
	if env.Error != nil {
		return modelAnswer{}, failure(FailModelUnreachable, fmt.Sprintf("%s reported an error on http %d: %s", host, status, bounded(env.Error.Type+": "+env.Error.Message, 200)), http.StatusServiceUnavailable)
	}
	if len(env.Choices) == 0 {
		return modelAnswer{}, failure(FailBadModelResponse, fmt.Sprintf("%s sent no choices on http %d", host, status), http.StatusBadGateway)
	}
	choice := env.Choices[0]
	out := modelAnswer{Finished: choice.FinishReason == "stop" || choice.FinishReason == ""}
	if choice.Message == nil {
		return out, failure(FailBadModelResponse, fmt.Sprintf("%s sent a choice with no message", host), http.StatusBadGateway)
	}
	out.ToolCalls = choice.Message.ToolCalls
	if len(choice.Message.Content) > 0 {
		var s string
		if err := json.Unmarshal(choice.Message.Content, &s); err == nil {
			out.Text = s
		} else {
			// Some endpoints answer content as a raw string or an array of
			// content parts; keep the JSON rather than losing the answer.
			out.Text = string(choice.Message.Content)
		}
	}
	return out, nil
}
