package assistant

import (
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
)

// DefaultTimeout arms a request when the caller's context carries no deadline.
// A palette keystroke must not hang a browser forever.
const DefaultTimeout = 30 * time.Second

// BodyLimit caps the endpoint response this broker will buffer (a completion
// is one JSON object, not a stream) — the same reasoning as the worker's
// modelChatBodyMax.
const BodyLimit = 4 << 20

// MaxAttempts caps one completion across transient upstream failures: the
// first attempt plus at most MaxAttempts-1 retries, so a single rate limit, a
// gateway hiccup or a model reload cannot kill a whole turn (the lab's llm-
// collective failures: 429 rate-limit, http 502, http 503, reload-404). Mirrors
// ADR-0023 § 7's retry.maxAttempts.
const MaxAttempts = 3

// RetryBackoff is the assistant client's egress retry policy constants (the
// ADR-0023 § 7 `retry {maxAttempts, backoff {baseSeconds, multiplier, maxSeconds,
// jitter}}` block): the delay before retry n is baseSeconds * multiplier^(n-1),
// clamped to maxSeconds, ±20% jitter.
const (
	RetryBackoffBaseSeconds = 2
	RetryBackoffMultiplier  = 3
	RetryBackoffMaxSeconds  = 15
)

// Config is serve's assistant egress triple (ADR-0034: separate names from the
// worker's COMMUNICATION_MODEL_CHAT_* so one process's endpoint and cost budget
// is not silently another's).
type Config struct {
	// BaseURL is the OpenAI-compatible server root; the call is
	// POST {BaseURL}/chat/completions. Empty means the feature is off.
	BaseURL string
	// APIKey is the bearer token. It only ever reaches a request header: never
	// a log line, a detail string or an answer.
	APIKey string
	// Model is the deployment's LLM collective (default qwen3-8-27b).
	Model string
	// HTTPClient is injectable for tests; nil uses a client with no own
	// timeout (per-request deadline).
	HTTPClient *http.Client
	// Timeout overrides DefaultTimeout.
	Timeout time.Duration
	// Logger receives egress outcomes. The key is never logged, and neither is
	// prompt or answer content.
	Logger *slog.Logger
	// Sleep is the backoff wait between completion attempts, injected for
	// tests; nil means a context-aware time.Sleep. The per-call deadline and
	// the caller's context are the hard ceiling on retrying.
	Sleep func(ctx context.Context, d time.Duration) error
}

// Validate applies the worker's COMMUNICATION_MODEL_CHAT_* rules verbatim
// (cmd/communication/worker.go): an http(s) root with a host, no credentials
// and no query/fragment. A bad URL is a startup refusal, not a per-request
// surprise.
func (c Config) Validate() error {
	root := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if root == "" {
		return nil
	}
	u, err := url.Parse(root)
	if err != nil {
		return fmt.Errorf("COMMUNICATION_ASSISTANT_BASE_URL %q is not a URL: %w", c.BaseURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("COMMUNICATION_ASSISTANT_BASE_URL %q must be an http(s) URL", c.BaseURL)
	}
	if u.Host == "" {
		return fmt.Errorf("COMMUNICATION_ASSISTANT_BASE_URL %q names no host", c.BaseURL)
	}
	if u.User != nil {
		return errors.New("COMMUNICATION_ASSISTANT_BASE_URL must not carry credentials in the URL; use COMMUNICATION_ASSISTANT_API_KEY")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("COMMUNICATION_ASSISTANT_BASE_URL %q must be a server root (no query or fragment)", c.BaseURL)
	}
	return nil
}

// Store is the read-only data access the tool registry is a closed map over.
// Each method is the store call behind an existing route and MUST be given the
// caller: a broker that could read a row without a Caller could read a row the
// caller cannot. Items is the route's own payload shape as JSON, so the
// assistant's answer is built from the same bytes the browser would have got
// (08-assistant.md's "one control source" rule).
type Store interface {
	ListProjects(ctx context.Context, c Caller) (json.RawMessage, error)
	ListPipelines(ctx context.Context, c Caller) (json.RawMessage, error)
	ListProjectRuns(ctx context.Context, c Caller, projectID string) (json.RawMessage, error)
	ListRunNodes(ctx context.Context, c Caller, runID string) (json.RawMessage, error)
	// ListProjectApprovals returns every gate of the project; the pending
	// filter is the tool's, so the same store call answers the route too.
	ListProjectApprovals(ctx context.Context, c Caller, projectID string) (json.RawMessage, error)
	ListPipelineRevisions(ctx context.Context, c Caller, pipelineID string) (json.RawMessage, error)
	ListAgentProfiles(ctx context.Context, c Caller) (json.RawMessage, error)
}

// Broker runs one bounded read-only turn per Ask. It is stateless: v1 stores
// nothing, so two asks in a row are two independent turns.
type Broker struct {
	store Store
	cfg   Config
	tools map[string]tool
	order []string
	// wire decodes the model's tool_calls[].function.name back to the
	// registry name (wire.go); never a reverse string replace.
	wire map[string]string
}

// New refuses an unconfigured or invalid endpoint rather than building a broker
// that would answer 503 on every request.
func New(cfg Config, store Store) (*Broker, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/") == "" {
		return nil, ErrNotConfigured
	}
	if store == nil {
		return nil, fmt.Errorf("assistant: no store handle: %w", ErrNotConfigured)
	}
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	byWire, err := toolWireMap()
	if err != nil {
		return nil, err
	}
	return &Broker{store: store, cfg: cfg, tools: toolRegistry(), order: toolOrder, wire: byWire}, nil
}

// Configured reports whether egress is wired. The ask route answers 503
// assistant_not_configured when it is not.
func (b *Broker) Configured() bool { return b != nil && b.cfg.BaseURL != "" && b.store != nil }

// EndpointHost names the third party the ops page must state plainly
// (ADR-0024's honesty rule). Empty when unconfigured; never includes
// credentials.
func (b *Broker) EndpointHost() string {
	if !b.Configured() {
		return ""
	}
	u, err := url.Parse(b.cfg.BaseURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Host
}

func (b *Broker) logger() *slog.Logger {
	if b != nil && b.cfg.Logger != nil {
		return b.cfg.Logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (b *Broker) client() *http.Client {
	if b != nil && b.cfg.HTTPClient != nil {
		return b.cfg.HTTPClient
	}
	return &http.Client{}
}

func (b *Broker) timeout() time.Duration {
	if b != nil && b.cfg.Timeout > 0 {
		return b.cfg.Timeout
	}
	return DefaultTimeout
}

// sleep waits out a backoff; the context deadline and the caller's context
// are the ceiling, so a cancelled context never sleeps past its deadline.
func (b *Broker) sleep(ctx context.Context, d time.Duration) error {
	if b.cfg.Sleep != nil {
		return b.cfg.Sleep(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
