package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/dbirks/communication/internal/pipelines/compiler"
)

// maxOutputViolations bounds attempts.output_errors: the JSON-Schema refusal
// is evidence, not a dump, and contract § 6's bounded-detail rule outranks
// completeness (§ 1's output_errors column has no size CHECK to lean on).
const maxOutputViolations = 16

// OutputViolation is one JSON-Schema location where a produced envelope
// refused the node's declared outputs schema. `Location` is the keyword
// location (the promise), `Instance` is the instance location (the field that
// broke it) — together they let a reader see WHY the reply was refused without
// rereading the plan.
type OutputViolation struct {
	Keyword  string `json:"keyword"`
	Location string `json:"location"`
	Instance string `json:"instance_location"`
	Message  string `json:"message"`
}

// OutputRejection is the boundary's invalid_output verdict (ADR-0022 § 4 rule
// 2, contract § 4 step 8). It is an error AND the evidence, because the
// attempt row wants the evidence and the journal wants the sentence.
type OutputRejection struct {
	Node       string
	Violations []OutputViolation
}

func (r *OutputRejection) Error() string {
	parts := make([]string, 0, len(r.Violations))
	for _, v := range r.Violations {
		parts = append(parts, fmt.Sprintf("at %s: %s", v.Instance, v.Message))
	}
	return fmt.Sprintf("invalid_output: node %s reply violates its declared outputs schema: %s",
		r.Node, strings.Join(parts, "; "))
}

// Entries is the payload form of attempts.output_errors and
// node.attempt.failed{output_errors[]} (contract § 1, § 3 row 22).
func (r *OutputRejection) Entries() []any {
	out := make([]any, 0, len(r.Violations))
	for _, v := range r.Violations {
		out = append(out, map[string]any{
			"keyword":           v.Keyword,
			"location":          v.Location,
			"instance_location": v.Instance,
			"message":           v.Message,
		})
	}
	return out
}

// Output validation is the boundary transaction's own check (contract § 4
// step 8: "validation failure is an invalid_output attempt failure"). The
// worker validates first, but the store re-validates at the checkpoint txn:
// a node reaching succeeded with an envelope its plan would not accept is
// exactly the lie this milestone exists to make unrepresentable — and the
// Postgres implementation runs the same check in SQL-adjacent Go, so the
// rule lives here, plan-driven, once.
//
// The schema library is the one the schema package already uses (ADR-0021
// § 2); no new dependency.

// ValidateOutputs checks a completion envelope against the node's declared
// outputs schema from the plan. Engine kinds (until/for_each) succeed through
// the advancer with engine-shaped outputs and are exempt.
func (p *Program) ValidateOutputs(n *NodeExecution, pn *compiler.Node, outputs any) error {
	if pn == nil {
		return nil
	}
	key := p.plan.Document.Name + "\x00" + pn.InstanceKey
	rej, err := CheckNodeOutputs(key, pn.InstanceKey, pn.Outputs, outputs)
	if err != nil || rej == nil {
		return err
	}
	return rej
}

// CheckNodeOutputs is the boundary's schema rule with ONE implementation: the
// engine's checkpoint transaction (MemStore.Complete) and the worker's fenced
// boundary write (postgres.AttemptStore.CompleteAttempt) both answer through
// here, so a reply cannot be valid on one path and invisible-invalid on the
// other. schema is the node's declared outputs JSON exactly as the pinned plan
// carries it; a node that declares nothing promises nothing and is accepted.
// A non-nil error means the schema itself was unusable — the boundary must NOT
// close a succeeded node on a check it could not run.
func CheckNodeOutputs(cacheKey, nodeKey string, schema, outputs any) (*OutputRejection, error) {
	if schema == nil {
		return nil, nil
	}
	s, err := outputSchema(cacheKey, nodeKey, schema)
	if err != nil {
		return nil, err
	}
	if err := s.Validate(jsonNative(outputs)); err != nil {
		return violations(nodeKey, err), nil
	}
	return nil, nil
}

// violations turns a JSON-Schema refusal into the boundary's evidence.
func violations(nodeKey string, err error) *OutputRejection {
	rej := &OutputRejection{Node: nodeKey}
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		rej.Violations = []OutputViolation{{
			Keyword: "validation_error", Location: "#", Instance: "#",
			Message: boundedMessage(err.Error()),
		}}
		return rej
	}
	var walk func(u *jsonschema.OutputUnit)
	walk = func(u *jsonschema.OutputUnit) {
		if u == nil || len(rej.Violations) >= maxOutputViolations {
			return
		}
		if u.Error != nil {
			kw := u.KeywordLocation
			if kw == "" {
				kw = "/"
			}
			inst := u.InstanceLocation
			if inst == "" {
				inst = "/"
			}
			segs := strings.Split(strings.Trim(kw, "/"), "/")
			rej.Violations = append(rej.Violations, OutputViolation{
				Keyword:  segs[len(segs)-1],
				Location: "#" + kw,
				Instance: inst,
				Message:  boundedMessage(u.Error.String()),
			})
			return
		}
		for i := range u.Errors {
			walk(&u.Errors[i])
		}
	}
	root := ve.DetailedOutput()
	walk(root)
	if len(rej.Violations) == 0 {
		rej.Violations = []OutputViolation{{
			Keyword: "validation_error", Location: "#", Instance: "/",
			Message: boundedMessage(err.Error()),
		}}
	}
	return rej
}

func boundedMessage(s string) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

var (
	outputSchemaMu sync.Mutex
	outputSchemaVc = jsonschema.NewCompiler()
	outputSchemaN  int
	outputCache    = map[string]*jsonschema.Schema{}
)

func outputSchema(cacheKey, nodeKey string, declared any) (*jsonschema.Schema, error) {
	doc := jsonNative(declared)
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("runtime: node %s outputs schema is not json: %w", nodeKey, err)
	}
	key := cacheKey + "\x00" + string(raw)
	outputSchemaMu.Lock()
	defer outputSchemaMu.Unlock()
	if s, ok := outputCache[key]; ok {
		return s, nil
	}
	// Re-decode through JSON: a plan snapshot holds integers as int64 and the
	// worker's envelope as json.Number, while jsonschema compiles its document
	// on the plain-decoded shape (modelchat.go:625's round trip does the same).
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, fmt.Errorf("runtime: node %s outputs schema is not a JSON object", nodeKey)
	}
	url := fmt.Sprintf("https://communication.dev/runtime/node-outputs/%d#", outputSchemaN)
	outputSchemaN++
	if err := outputSchemaVc.AddResource(url, m); err != nil {
		return nil, fmt.Errorf("runtime: compile outputs schema for %s: %w", nodeKey, err)
	}
	s, err := outputSchemaVc.Compile(url)
	if err != nil {
		return nil, fmt.Errorf("runtime: compile outputs schema for %s: %w", nodeKey, err)
	}
	outputCache[key] = s
	return s, nil
}

// jsonNative normalizes Go values that jsonschema's Validate refuses (notably
// int/int for numbers, which CEL hands back as int64 — valid JSON semantics,
// but the validator compares on reflection).
func jsonNative(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = jsonNative(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = jsonNative(val)
		}
		return out
	case int:
		return int64(t)
	case int32:
		return int64(t)
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out
	default:
		return v
	}
}
