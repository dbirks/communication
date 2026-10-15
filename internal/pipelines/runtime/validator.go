package runtime

import (
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/dbirks/communication/internal/pipelines/compiler"
)

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
	if pn == nil || pn.Outputs == nil {
		return nil
	}
	s, err := p.outputSchema(pn)
	if err != nil {
		return err
	}
	if err := s.Validate(jsonNative(outputs)); err != nil {
		return fmt.Errorf("invalid_output: %w", err)
	}
	return nil
}

var (
	outputSchemaMu sync.Mutex
	outputSchemaVc = jsonschema.NewCompiler()
	outputSchemaN  int
	outputCache    = map[string]*jsonschema.Schema{}
)

func (p *Program) outputSchema(pn *compiler.Node) (*jsonschema.Schema, error) {
	key := p.plan.Document.Name + "\x00" + pn.InstanceKey + "\x00" + fmt.Sprint(pn.Outputs)
	outputSchemaMu.Lock()
	defer outputSchemaMu.Unlock()
	if s, ok := outputCache[key]; ok {
		return s, nil
	}
	doc := jsonNative(pn.Outputs)
	m, ok := doc.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("runtime: node %s outputs schema is not a JSON object", pn.InstanceKey)
	}
	url := fmt.Sprintf("https://communication.dev/runtime/node-outputs/%d#", outputSchemaN)
	outputSchemaN++
	if err := outputSchemaVc.AddResource(url, m); err != nil {
		return nil, fmt.Errorf("runtime: compile outputs schema for %s: %w", pn.InstanceKey, err)
	}
	s, err := outputSchemaVc.Compile(url)
	if err != nil {
		return nil, fmt.Errorf("runtime: compile outputs schema for %s: %w", pn.InstanceKey, err)
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
