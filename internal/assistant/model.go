package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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

// complete issues ONE POST. The body has already been secret-scanned by the
// caller; nothing here rewrites it, and the API key never leaves a header.
func (b *Broker) complete(ctx context.Context, req chatRequest) (modelAnswer, *Failure) {
	ctx, cancel := context.WithTimeout(ctx, b.timeout())
	defer cancel()

	body, err := json.Marshal(req)
	if err != nil {
		return modelAnswer{}, failure(FailBadModelResponse, "cannot serialize the request: "+err.Error(), http.StatusInternalServerError)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, b.cfg.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return modelAnswer{}, failure(FailModelUnreachable, "could not build the request for "+b.EndpointHost(), http.StatusServiceUnavailable)
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
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return modelAnswer{}, failure(FailModelTimeout, fmt.Sprintf("no completion from %s within %s", b.EndpointHost(), b.timeout().Truncate(time.Millisecond)), http.StatusGatewayTimeout)
		}
		return modelAnswer{}, failure(FailModelUnreachable, "request to "+b.EndpointHost()+" failed", http.StatusServiceUnavailable)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, BodyLimit+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return modelAnswer{}, failure(FailModelTimeout, b.EndpointHost()+" stopped mid-response", http.StatusGatewayTimeout)
		}
		return modelAnswer{}, failure(FailModelUnreachable, "reading the response from "+b.EndpointHost(), http.StatusServiceUnavailable)
	}
	if len(raw) > BodyLimit {
		return modelAnswer{}, failure(FailBadModelResponse, fmt.Sprintf("%s sent a response over %d bytes", b.EndpointHost(), BodyLimit), http.StatusBadGateway)
	}
	return parseCompletion(resp.StatusCode, raw, b.EndpointHost())
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
