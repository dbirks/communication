package assistant

// This file is ADR-0052's free-text interpretation: the approver replies in
// their own words to a gate, and ONE bounded model turn (the same broker path)
// restates their intent and PROPOSES a decision. The model NEVER decides: the
// response is a proposal the UI shows and the human confirms by calling the
// existing `decide` endpoint themselves (ADR-0034's "the model is not trusted"
// rule, and the design's "you confirm whatever it proposes").

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// InterpretationMaxRunes caps the one-sentence restatement.
const InterpretationMaxRunes = 300

// InterpretCommentsMax is the decide endpoint's own 8 KiB comments bound; a
// proposed note the decider could not paste into `decide` is not honest.
const InterpretCommentsMax = 8192

// ProposedDecision is the decision the model PROPOSES for the approver to
// confirm. Decision is one of the three decider actions; an unknown or
// ambiguous model member is coerced to "reject" — never "approve", because a
// summary the model cannot place must not default to letting work through.
type ProposedDecision struct {
	Decision string `json:"decision"`
	Comments string `json:"comments"`
}

// Interpretation is POST /api/v1/approvals/{id}/interpret's 200 body.
type Interpretation struct {
	Interpretation string           `json:"interpretation"`
	Proposed       ProposedDecision `json:"proposed"`
}

var validInterpretDecision = map[string]bool{"approve": true, "reject": true, "request_changes": true}

// InterpretPrompt builds the one-shot (system, user) pair for an
// interpretation turn: the gate summary and the approver's free-text reply,
// both already bounded by the route. One request, one JSON object, no re-ask.
func InterpretPrompt(gate, reply string) (string, string) {
	system := "A human approver replied, in their own words, to a software-engineering pipeline gate. Interpret their intent. " +
		"Answer with EXACTLY ONE JSON object and nothing else: " +
		`{"interpretation":"<one plain sentence restating what the approver wants>","proposed":{"decision":"approve|reject|request_changes","comments":"<a short decider note, faithful to the approver's words>"}}. ` +
		"decision is whichever of approve, reject, request_changes is closest to the approver's intent; if it is ambiguous or not clearly approving, use reject. comments is the short note the approver would attach to their decision — keep it faithful and add nothing they did not say. Never include secrets, tokens or credentials."
	user := "Gate summary:\n" + strings.TrimSpace(gate) +
		"\n\nApprover's reply:\n" + strings.TrimSpace(reply)
	return system, user
}

// InterpretReply makes ONE completion and returns the validated proposal.
// Egress failures carry the broker's Failure mapping; a structurally bad or
// secret-bearing answer is a 502, never returned as-is.
func (b *Broker) InterpretReply(ctx context.Context, gate, reply string) (Interpretation, *Failure) {
	system, user := InterpretPrompt(gate, reply)
	raw, fail := b.CompleteText(ctx, system, user)
	if fail != nil {
		return Interpretation{}, fail
	}
	out, err := ParseInterpretation(raw)
	if err != nil {
		return Interpretation{}, failure(FailBadModelResponse, err.Error(), http.StatusBadGateway)
	}
	blob, merr := json.Marshal(out)
	if merr != nil {
		return Interpretation{}, failure(FailBadModelResponse, "the answer cannot be serialized", http.StatusInternalServerError)
	}
	if secretShape.Find(blob) != nil {
		return Interpretation{}, failure("secret_in_response",
			"the model's answer carries secret-shaped material and was not returned", http.StatusBadGateway)
	}
	return out, nil
}

// interpretModelAnswer is the shape the model is asked for; extra members are
// dropped by the typed decode.
type interpretModelAnswer struct {
	Interpretation string `json:"interpretation"`
	Proposed       struct {
		Decision string `json:"decision"`
		Comments string `json:"comments"`
	} `json:"proposed"`
}

// ParseInterpretation validates and coerces the model's answer into an
// Interpretation. It is pure — no model, no store — so the coercion rules are
// unit-tested and the route shares them verbatim.
func ParseInterpretation(raw string) (Interpretation, error) {
	s, err := stripModelProse(raw)
	if err != nil {
		return Interpretation{}, err
	}
	dec := json.NewDecoder(strings.NewReader(s))
	var a interpretModelAnswer
	if err := dec.Decode(&a); err != nil {
		return Interpretation{}, errors.New("the answer is not a JSON object")
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return Interpretation{}, errors.New("the answer is not exactly one JSON object")
	}

	restated := bounded(strings.TrimSpace(a.Interpretation), InterpretationMaxRunes)
	if restated == "" {
		restated = bounded(strings.TrimSpace(a.Proposed.Comments), InterpretationMaxRunes)
	}
	if restated == "" {
		return Interpretation{}, errors.New("the answer's interpretation is empty")
	}

	decision := strings.ToLower(strings.TrimSpace(a.Proposed.Decision))
	if !validInterpretDecision[decision] {
		// Ambiguous or unknown intent never defaults to approval.
		decision = "reject"
	}
	comments := bounded(strings.TrimSpace(a.Proposed.Comments), InterpretCommentsMax)

	return Interpretation{
		Interpretation: restated,
		Proposed:       ProposedDecision{Decision: decision, Comments: comments},
	}, nil
}
