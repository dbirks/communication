// Package assistant is ADR-0034's read-only broker: one bounded model turn that
// answers a browsing caller's question from the caller's own read view.
//
// The two rules the whole package exists to keep are (a) every tool is a
// read-only store method already serving an existing HTTP route, called with
// the caller's own Caller, so the assistant can never see more than the caller
// can via the routes; and (b) nothing is stored — no table, no transcript, no
// replay log (ADR-0034 "v1 stores nothing").
//
// The package deliberately does not import internal/api (internal/api imports
// this one), so Caller and the row payloads are this package's own small types
// and api/assistant.go is the adapter between them.
package assistant

import "errors"

// Caps from docs/design/assistant-v1.md § Tools. They are constants rather than
// configuration: the bounded turn is the safety property, and an operator
// widening it is changing the design, not tuning it.
const (
	// MaxModelCalls bounds completions per turn — one answer plus the design's
	// single round of follow-up, with room for a refusal/retry.
	MaxModelCalls = 4
	// MaxToolCalls bounds tool results per turn (the design's per-round cap of
	// 4 plus the follow-up round).
	MaxToolCalls = 8
	// MaxItems caps the rows one tool result carries to the model.
	MaxItems = 64
	// MaxResultBytes caps one tool result's JSON payload; over it the result is
	// truncated and marked "truncated": true.
	MaxResultBytes = 2048
	// MaxQuestionRunes is the ask route's 1..2000 character rule.
	MaxQuestionRunes = 2000
	// MaxPromptBytes caps what this broker will ever put on the wire.
	MaxPromptBytes = 64 << 10
	// DefaultModel is the deployment's LLM collective (ADR-0034).
	DefaultModel = "qwen3-8-27b"
)

// Errors the ask route maps onto problem+json statuses.
var (
	// ErrNotConfigured is the honest refusal: with no COMMUNICATION_ASSISTANT_*
	// triple the feature is absent, and the answer is never a hallucination.
	ErrNotConfigured = errors.New("assistant: not configured")
	// ErrQuestionInvalid is an empty/oversized question.
	ErrQuestionInvalid = errors.New("assistant: question is invalid")
	// ErrSecretInPrompt is ADR-0018's gate: the request body carries
	// secret-shaped material, so nothing is sent (docs/design/assistant-v1.md
	// § Egress refusal).
	ErrSecretInPrompt = errors.New("assistant: request body carries secret-shaped material")
)

// Failure is a turn that could not be answered, with the stable code the
// `degraded` field names. Status is the HTTP status the route should answer
// with (503 unreachable, 504 timeout — docs/design/assistant-v1.md § ask).
type Failure struct {
	Code   string
	Detail string
	Status int
}

const (
	FailModelUnreachable = "model_unreachable"
	FailModelTimeout     = "model_timeout"
	FailBadModelResponse = "malformed_completion"
	FailCallCap          = "model_call_cap_exceeded"
	FailToolCap          = "tool_cap_exceeded"
)

func (f *Failure) Error() string {
	if f == nil {
		return "assistant: turn failed"
	}
	return "assistant: " + f.Code + ": " + f.Detail
}

func failure(code, detail string, status int) *Failure {
	return &Failure{Code: code, Detail: bounded(detail, 400), Status: status}
}

// Caller is the authenticated human reduced to what project authorization
// needs — the same three fields internal/api.Caller carries. The adapter in
// internal/api/assistant.go builds it from the session Principal, never from a
// header or a path value.
type Caller struct {
	UserID         string
	OrganizationID string
	IsOrgAdmin     bool
}

// Link is a same-origin jump the UI renders as a button. Every href in an
// Answer was produced by a tool from rows the caller may read and then matched
// against the route allowlist; a model-invented URL never survives.
type Link struct {
	Label string `json:"label"`
	Href  string `json:"href"`
}

// ToolCall is the transparency record of one tool the broker ran (or refused).
// Reason is a stable code and is present only when OK is false; a refused call
// carries no data and no resource name (the 404 rule of
// internal/api/conversations.go).
type ToolCall struct {
	Name   string         `json:"name"`
	Args   map[string]any `json:"args"`
	OK     bool           `json:"ok"`
	Reason string         `json:"reason,omitempty"`
}

// Answer is POST /api/v1/assistant/ask's 200 body.
type Answer struct {
	AnswerMarkdown string     `json:"answer_markdown"`
	Links          []Link     `json:"links"`
	ToolCalls      []ToolCall `json:"tool_calls"`
	TurnID         string     `json:"assistant_turn_id"`
	Degraded       *string    `json:"degraded"`
}

// PaletteEntry is one client-supplied palette row (the UI's own jump index, so
// the assistant can name what is already on screen). Its To is validated
// against the route allowlist before it reaches the model or the answer.
type PaletteEntry struct {
	Label     string
	Secondary string
	To        string
}

// QuestionContext is what the UI knows about where the question was asked.
type QuestionContext struct {
	Route     string
	ProjectID string
	Palette   []PaletteEntry
}

// bounded clips s to n bytes without splitting a rune, so a detail string from
// an endpoint can never inflate a response.
func bounded(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8Start(s, n) {
		n--
	}
	return s[:n]
}

func utf8Start(s string, i int) bool { return i <= len(s) && (s[i]&0xC0) != 0x80 }
