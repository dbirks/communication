package assistant

// This file is ADR-0052's approval summarization pass: ONE bounded model turn
// (no tool loop, the same broker path ADR-0034/0044 use) that turns a pipeline
// gate's summary plus its artifact references into a short decider summary and
// a small set of suggested actions. The model is not trusted: its answer must
// be exactly one JSON object, unknown intent/risk members are coerced to
// "other", labels are capped, and the answer is secret-scanned before it is
// returned (ADR-0018 / the broker's own egress rule).
//
// Nothing here stores anything — the result is returned to the caller and the
// route caches it in memory keyed on the gate's version (ADR-0052). It never
// decides the gate: the decider still calls the existing `decide` endpoint.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// SummaryLabelMax is the cap on one suggested action's label.
const SummaryLabelMax = 40

// SummaryMaxRunes caps the decider summary text before it is written.
const SummaryMaxRunes = 300

// Action caps: the design asks for 2–4 suggested actions.
const (
	minActions = 2
	maxActions = 4
)

// NewTextOnly builds a broker for the text-only paths (ADR-0044's
// CompleteText and ADR-0052's summarization/interpretation): the config is
// validated exactly as New validates it, and an unset base URL is the honest
// ErrNotConfigured the route turns into 503 assistant_not_configured. The
// store is deliberately nil: these turns make one completion and never call a
// tool, so no read surface is granted (and a broker that could not read a row
// could not read a row the caller cannot).
func NewTextOnly(cfg Config) (*Broker, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/") == "" {
		return nil, ErrNotConfigured
	}
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	return &Broker{cfg: cfg}, nil
}

// SummaryAction is one suggested action the model proposes. Intent and risk
// are always one of the wire enums — unknown members are coerced to "other" —
// and Label is capped at SummaryLabelMax.
type SummaryAction struct {
	Label  string `json:"label"`
	Intent string `json:"intent"`
	Risk   string `json:"risk"`
}

// ApprovalSummary is POST /api/v1/approvals/{id}/summary's 200 body.
type ApprovalSummary struct {
	Summary     string          `json:"summary"`
	Actions     []SummaryAction `json:"actions"`
	Model       string          `json:"model"`
	GeneratedAt time.Time       `json:"generated_at"`
}

// intent and risk are closed enums; anything else is "other", never an error —
// the model is asked to choose from them but is not re-asked on a miss.
var (
	validIntent = map[string]bool{"approve": true, "reject": true, "request_changes": true, "other": true}
	validRisk   = map[string]bool{"proceed": true, "refuse": true, "destructive": true, "other": true}
)

// SummaryPrompt builds the one-shot (system, user) pair for a summarization
// turn: the gate summary plus its artifact references, both already bounded by
// the route before they reach this. One request, one JSON object, no re-ask.
func SummaryPrompt(gate, refs string) (string, string) {
	system := "You summarize a software-engineering pipeline gate for a human approver deciding whether to approve or reject the pending work. " +
		"Answer with EXACTLY ONE JSON object and nothing else, of the form: " +
		`{"summary":"<at most two plain sentences, no markdown>","actions":[{"label":"<short label of at most 40 characters>","intent":"approve|reject|request_changes|other","risk":"proceed|refuse|destructive|other"}]}. ` +
		"Give between 2 and 4 actions the approver is most likely to take (for example Approve, Reject, Request changes). intent is the decision the action stands for; risk classifies it: proceed (a safe approval), refuse (a rejection), destructive (hard to reverse), or other. Never invent facts that are not in the gate text, and never include secrets, tokens or credentials."
	user := "Gate summary:\n" + strings.TrimSpace(gate)
	if refs := strings.TrimSpace(refs); refs != "" {
		user += "\n\nReferenced artifacts:\n" + refs
	}
	return system, user
}

// SummarizeApproval makes ONE completion and returns the validated summary.
// Egress failures carry the broker's Failure mapping (503 unreachable, 504
// timeout, 502 malformed); a structurally bad or secret-bearing answer is a
// 502, never a re-ask and never returned as-is.
func (b *Broker) SummarizeApproval(ctx context.Context, gate, refs string) (ApprovalSummary, *Failure) {
	system, user := SummaryPrompt(gate, refs)
	raw, fail := b.CompleteText(ctx, system, user)
	if fail != nil {
		return ApprovalSummary{}, fail
	}
	out, err := ParseApprovalSummary(raw)
	if err != nil {
		return ApprovalSummary{}, failure(FailBadModelResponse, err.Error(), http.StatusBadGateway)
	}
	if f := scanOutputForSecrets(out); f != nil {
		return ApprovalSummary{}, f
	}
	out.Model = b.cfg.Model
	out.GeneratedAt = time.Now().UTC()
	return out, nil
}

// summaryModelAnswer is the shape the model is asked for; extra members are
// dropped by the typed decode, so a hallucinated field never reaches a client.
type summaryModelAnswer struct {
	Summary string `json:"summary"`
	Actions []struct {
		Label  string `json:"label"`
		Intent string `json:"intent"`
		Risk   string `json:"risk"`
	} `json:"actions"`
}

// ParseApprovalSummary validates and coerces the model's answer into an
// ApprovalSummary (Model and GeneratedAt stay zero; the caller fills them).
// It is pure — no model, no store — so the coercion rules are unit-tested and
// the route shares them verbatim.
func ParseApprovalSummary(raw string) (ApprovalSummary, error) {
	s, err := stripModelProse(raw)
	if err != nil {
		return ApprovalSummary{}, err
	}
	dec := json.NewDecoder(strings.NewReader(s))
	var a summaryModelAnswer
	if err := dec.Decode(&a); err != nil {
		return ApprovalSummary{}, errors.New("the answer is not a JSON object")
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return ApprovalSummary{}, errors.New("the answer is not exactly one JSON object")
	}

	summary := firstTwoSentences(a.Summary)
	summary = bounded(summary, SummaryMaxRunes)
	if strings.TrimSpace(summary) == "" {
		return ApprovalSummary{}, errors.New("the answer's summary is empty")
	}

	actions := make([]SummaryAction, 0, len(a.Actions))
	for _, in := range a.Actions {
		label := truncateRune(strings.TrimSpace(in.Label), SummaryLabelMax)
		if label == "" {
			// An action with no label the approver could read is noise.
			continue
		}
		actions = append(actions, SummaryAction{
			Label:  label,
			Intent: coerceEnum(in.Intent, validIntent),
			Risk:   coerceEnum(in.Risk, validRisk),
		})
	}
	if len(actions) > maxActions {
		actions = actions[:maxActions]
	}
	if len(actions) < 1 {
		return ApprovalSummary{}, errors.New("the answer carries no usable action")
	}
	if len(actions) < minActions {
		// The design asks for 2–4; a single usable action is still honest and
		// renderable, so keep it rather than failing the whole card.
	}
	return ApprovalSummary{Summary: summary, Actions: actions}, nil
}

// coerceEnum maps an unknown model member to "other" and lowercases a known
// one, so the wire always carries a legal enum (the route does not re-ask).
func coerceEnum(v string, allowed map[string]bool) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if allowed[v] {
		return v
	}
	return "other"
}

// scanOutputForSecrets is ADR-0018 applied to the ANSWER: the broker scans the
// request before egress, but a model that echoes a secret-shaped string must
// not be handed to a browser either. A match is a refusal (502), not a
// redaction — and the match is never echoed.
func scanOutputForSecrets(s ApprovalSummary) *Failure {
	blob, err := json.Marshal(s)
	if err != nil {
		return failure(FailBadModelResponse, "the answer cannot be serialized", http.StatusInternalServerError)
	}
	if secretShape.Find(blob) != nil {
		return failure("secret_in_response",
			"the model's answer carries secret-shaped material and was not returned", http.StatusBadGateway)
	}
	return nil
}

// truncateRune clips s to at most n RUNES (a character cap, not a byte cap) so
// an action label stays within the 40-character bound even for non-ASCII text.
func truncateRune(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// stripModelProse removes a leading <think>...</think> block (reasoning models)
// and an optional ``` / ```json fence, returning the trimmed body the JSON
// decoder must read. A malformed fence or an unclosed think block is a refusal.
func stripModelProse(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "<think") {
		i := strings.Index(s, "</think>")
		if i < 0 {
			return "", errors.New("the answer's think block never closes")
		}
		s = strings.TrimSpace(s[i+len("</think>"):])
	}
	if strings.HasPrefix(s, "```") {
		end := strings.IndexByte(s, '\n')
		if end < 0 {
			return "", errors.New("the fenced answer has no body")
		}
		body := s[end+1:]
		closeIdx := strings.LastIndex(body, "```")
		if closeIdx < 0 {
			return "", errors.New("the fenced answer is not closed")
		}
		s = strings.TrimSpace(body[:closeIdx])
	}
	return s, nil
}

// firstTwoSentences clips s to its first two sentences (the design's "≤ 2
// sentences" cap as a hard bound, so a chatty model cannot inflate the card).
func firstTwoSentences(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	count := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '.', '!', '?':
			count++
			if count == 2 {
				j := i + 1
				for j < len(s) && (s[j] == ' ' || s[j] == '\n' || s[j] == '\t') {
					j++
				}
				return strings.TrimSpace(s[:j])
			}
		}
	}
	return s
}
