package expr

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/canon"
)

// SchemaNode is the slice of JSON Schema the CEL reference table needs: the
// declared type set of a value, its known properties, and whether unknown
// properties are admissible. ADR-0022 § 4 rule 1 is what turns `dyn` back into
// publish-time type discipline, and this is the shape that carries it.
//
// It is deliberately small. Runtime output validation uses the full JSON Schema
// validator against the same document node; this type answers only "can this
// expression's selection ever resolve?" and "can this operand pair ever be
// equal?".
type SchemaNode struct {
	// Types holds the declared JSON type names ("string", "integer", …). An
	// empty set means the schema states no type, so nothing is refused.
	Types map[string]bool
	Props map[string]*SchemaNode
	// PropNames lists the declared property names (for the "declares X, Y"
	// part of an unknown_field message).
	PropNames []string
	// Open is true when additionalProperties admits unknown keys.
	Open bool
	// Enum holds an enum/const literal set when declared.
	Enum []any
	// Items is the element schema of an array.
	Items *SchemaNode
}

// OpenSchema is a schema that claims nothing: every selection resolves and no
// literal can be refused. It is the answer wherever the compiler has no
// declared basis for an opinion.
func OpenSchema() *SchemaNode {
	return &SchemaNode{Open: true, Types: map[string]bool{}, Props: map[string]*SchemaNode{}}
}

// SchemaFromJSON compiles a document's schema fragment into the reference
// table. Anything unrecognised degrades to "no claims" rather than to a
// refusal, so an unusual schema never produces a false publish-time error.
func SchemaFromJSON(v any) *SchemaNode {
	m, ok := v.(map[string]any)
	if !ok {
		return OpenSchema()
	}
	n := &SchemaNode{Types: map[string]bool{}, Props: map[string]*SchemaNode{}}
	switch t := m["type"].(type) {
	case string:
		n.Types[t] = true
	case []any:
		for _, s := range t {
			if str, ok := s.(string); ok {
				n.Types[str] = true
			}
		}
	}
	if props, ok := m["properties"].(map[string]any); ok {
		for k, sub := range props {
			n.Props[k] = SchemaFromJSON(sub)
			n.PropNames = append(n.PropNames, k)
		}
		sort.Strings(n.PropNames)
	}
	switch ap := m["additionalProperties"].(type) {
	case bool:
		n.Open = ap
	case map[string]any:
		n.Open = true
		_ = ap
	}
	if e, ok := m["enum"].([]any); ok {
		n.Enum = e
	}
	if c, hasConst := m["const"]; hasConst {
		n.Enum = append(n.Enum, c)
	}
	if it, ok := m["items"]; ok {
		n.Items = SchemaFromJSON(it)
	}
	return n
}

// Child resolves a property selection. found is false when the schema closes
// the object and the name is not declared — which is what makes an expression
// that reads a field "no declared output can produce" a publish-time refusal.
func (s *SchemaNode) Child(name string) (child *SchemaNode, found bool) {
	if s == nil {
		return nil, false
	}
	if c, ok := s.Props[name]; ok {
		return c, true
	}
	if s.Open || len(s.Types) == 0 {
		return OpenSchema(), true
	}
	return nil, false
}

// TypeNames renders the declared type set for a message.
func (s *SchemaNode) TypeNames() string {
	if s == nil || len(s.Types) == 0 {
		return "any"
	}
	out := make([]string, 0, len(s.Types))
	for t := range s.Types {
		out = append(out, t)
	}
	sort.Strings(out)
	return strings.Join(out, "|")
}

// AdmitsLiteral reports whether a literal of this JSON type could ever compare
// equal to a value of the declared type. integer/number overlap is kept because
// CEL compares 0 and 0.0 as equal (the spike's json-float-vs-int probe), and an
// enum's membership is the schema's business, not ours.
func (s *SchemaNode) AdmitsLiteral(jsonType string) bool {
	if s == nil || len(s.Types) == 0 {
		return true
	}
	if s.Types[jsonType] {
		return true
	}
	if jsonType == "integer" && s.Types["number"] {
		return true
	}
	if jsonType == "number" && s.Types["integer"] {
		return true
	}
	if jsonType == "number" && s.Types["integer"] {
		return true
	}
	if len(s.Enum) > 0 {
		return true
	}
	return false
}

// SchemaFromJSONText parses a declared output schema from its JSON text. It
// exists for tests and tooling that carry schemas as strings; the compiler path
// uses SchemaFromJSON on the loader's tree.
func SchemaFromJSONText(text string) (*SchemaNode, error) {
	var raw any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil, err
	}
	norm, err := canonJSONValue(raw)
	if err != nil {
		return nil, err
	}
	return SchemaFromJSON(norm), nil
}

// canonJSONValue converts json.Number into the loader's numeric model so a
// schema written by hand and one produced by the loader build the same node.
func canonJSONValue(v any) (canon.Value, error) {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i, nil
		} else {
			return t.Float64()
		}
	case map[string]any:
		out := make(canon.Map, len(t))
		for k, sub := range t {
			cv, err := canonJSONValue(sub)
			if err != nil {
				return nil, err
			}
			out[k] = cv
		}
		return out, nil
	case []any:
		out := make([]canon.Value, len(t))
		for i, sub := range t {
			cv, err := canonJSONValue(sub)
			if err != nil {
				return nil, err
			}
			out[i] = cv
		}
		return out, nil
	default:
		return v, nil
	}
}
