package schema

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// Binding position names (ADR-0022 § 1). The schema types these as $defs
// names; the compiler dispatches on them so a binding can never masquerade as
// a typed literal, and so "where does an expression live" has exactly one
// answer per field instead of one per compiler.
const (
	// PositionLiteral: a ${{ … }} string here is an authoring mistake.
	PositionLiteral = "literal"
	// PositionText: bindingText — literal text with zero or more ${{ … }}.
	PositionText = "bindingText"
	// PositionValue: bindingValue — a whole-value ${{ … }} (or the {expr,
	// fallback} object), or a plain literal of the declared JSON type.
	PositionValue = "bindingValue"
	// PositionExpression: bare CEL with no delimiters, typed bool.
	PositionExpression = "expression"
	// PositionScope: a body/branches container whose nodes hold their own
	// bindings; the compiler recurses instead of inspecting a scalar.
	PositionScope = "scope"
	// PositionSchema: an embedded JSON Schema (inputs, outputs,
	// responseSchema). Its strings are schema vocabulary, never bindings.
	PositionSchema = "schema"
	// PositionUnknown: the walker could not place the pointer.
	PositionUnknown = "unknown"
)

// positions is the schema-walking state: the asset as a JSON tree plus the
// document being placed.
type positions struct {
	root map[string]any
}

func newPositions(asset []byte) (*positions, error) {
	var doc map[string]any
	if err := json.Unmarshal(asset, &doc); err != nil {
		return nil, err
	}
	return &positions{root: doc}, nil
}

var positionCache = func() *positions {
	p, err := newPositions(schemaAsset)
	if err != nil {
		panic("schema: embedded asset cannot be parsed for binding positions: " + err.Error())
	}
	return p
}()

// Position reports the binding position of the value at p in doc.
//
// This is the compiler's dispatch table: the answer comes from walking the
// shipped schema alongside the document, so the schema's $defs names remain
// the single source of truth about which slots bind (contract § 9.2).
// TestPositionTable pins the result for every binding site of the sample and
// of each spec example, which is what stops the two from drifting.
func Position(doc any, p ptr.Pointer) string {
	pos, _ := positionCache.place(doc, p)
	return pos
}

// PositionAndDef additionally returns the $defs name the slot resolved to.
func PositionAndDef(doc any, p ptr.Pointer) (string, string) {
	return positionCache.place(doc, p)
}

func (ps *positions) place(doc any, pointer ptr.Pointer) (string, string) {
	tokens := pointer.Segments()
	m, ok := doc.(map[string]any)
	if !ok {
		return PositionUnknown, ""
	}
	cur, ok := pickBranch(ps.root, m, tokens)
	if !ok {
		return PositionUnknown, ""
	}
	def := ""
	value := doc
	for _, tok := range tokens {
		cur, value, def = ps.child(cur, value, tok, def)
		if cur == nil {
			return PositionUnknown, def
		}
	}
	return classify(cur, def), def
}

// pickBranch resolves the root oneOf to the branch whose kind const matches
// the document, so Pipeline and NodeTemplate never share a walk.
func pickBranch(root map[string]any, doc map[string]any, tokens []string) (map[string]any, bool) {
	kind, _ := doc["kind"].(string)
	if branches, ok := root["oneOf"].([]any); ok {
		for _, b := range branches {
			bm, ok := b.(map[string]any)
			if !ok {
				continue
			}
			resolved, okBranch := followRef(root, bm)
			if !okBranch || resolved == nil {
				continue
			}
			if constKind(resolved) == kind {
				return resolved, true
			}
		}
		return nil, false
	}
	return root, true
}

func constKind(s map[string]any) string {
	props, _ := s["properties"].(map[string]any)
	if props == nil {
		return ""
	}
	k, _ := props["kind"].(map[string]any)
	if k == nil {
		return ""
	}
	c, _ := k["const"].(string)
	return c
}

// child descends one reference token, carrying the matching document value so
// an if/then branch can be resolved, and remembering the last $defs name seen.
func (ps *positions) child(s map[string]any, value any, tok, def string) (map[string]any, any, string) {
	s = ps.expand(s, value)
	if s == nil {
		return nil, nil, def
	}
	if ref, _ := s["$ref"].(string); ref != "" {
		r, d := ps.byRef(ref)
		if r == nil {
			return nil, nil, def
		}
		if d != "" {
			def = d
		}
		return ps.child(r, value, tok, def)
	}
	if items, ok := s["items"].(map[string]any); ok && s["type"] == "array" {
		next := arrayElement(value, tok)
		return items, next, def
	}
	props, _ := s["properties"].(map[string]any)
	if next, ok := props[tok].(map[string]any); ok {
		val := memberValue(value, tok)
		if r, d := followRefKeep(ps.root, next); r != nil {
			if d != "" {
				def = d
			}
			return r, val, def
		}
		return next, val, def
	}
	if ap, ok := s["additionalProperties"].(map[string]any); ok {
		return ap, memberValue(value, tok), def
	}
	return nil, nil, def
}

// expand applies allOf branches (including the per-kind if/then config
// branches) that match the current document value.
func (ps *positions) expand(s map[string]any, value any) map[string]any {
	if s == nil {
		return nil
	}
	branches, ok := s["allOf"].([]any)
	if !ok {
		return s
	}
	out := map[string]any{}
	for k, v := range s {
		out[k] = v
	}
	delete(out, "allOf")
	props := map[string]any{}
	if existing, ok := out["properties"].(map[string]any); ok {
		for k, v := range existing {
			props[k] = v
		}
	}
	for _, b := range branches {
		bm, ok := b.(map[string]any)
		if !ok {
			continue
		}
		if cond, ok := bm["if"].(map[string]any); ok {
			if !matches(value, cond) {
				continue
			}
			then, _ := bm["then"].(map[string]any)
			ps.mergeInto(props, then)
			continue
		}
		if direct, ok := followRef(ps.root, bm); ok && direct != nil {
			ps.mergeInto(props, direct)
			for k, v := range direct {
				if k != "properties" && k != "$ref" {
					out[k] = v
				}
			}
		}
	}
	out["properties"] = props
	return out
}

func (ps *positions) mergeInto(props map[string]any, branch map[string]any) {
	if branch == nil {
		return
	}
	if ref, _ := branch["$ref"].(string); ref != "" {
		if r, _ := ps.byRef(ref); r != nil {
			branch = r
		}
	}
	bp, _ := branch["properties"].(map[string]any)
	for k, v := range bp {
		props[k] = v
	}
}

// matches is the slice of JSON Schema the shipped asset actually uses in an
// `if`: a kind const, and required.
func matches(value any, cond map[string]any) bool {
	obj, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if props, ok := cond["properties"].(map[string]any); ok {
		for k, vschema := range props {
			vm, ok := vschema.(map[string]any)
			if !ok {
				continue
			}
			if c, hasConst := vm["const"]; hasConst {
				if obj[k] != c {
					return false
				}
			}
			if en, hasEnum := vm["enum"].([]any); hasEnum {
				found := false
				for _, e := range en {
					if e == obj[k] {
						found = true
					}
				}
				if !found {
					return false
				}
			}
		}
	}
	if req, ok := cond["required"].([]any); ok {
		for _, r := range req {
			if name, _ := r.(string); name != "" {
				if _, has := obj[name]; !has {
					return false
				}
			}
		}
	}
	return true
}

func memberValue(value any, tok string) any {
	if m, ok := value.(map[string]any); ok {
		return m[tok]
	}
	return nil
}

func arrayElement(value any, tok string) any {
	if arr, ok := value.([]any); ok {
		if i, err := strconv.Atoi(tok); err == nil && i >= 0 && i < len(arr) {
			return arr[i]
		}
	}
	return nil
}

// byRef resolves a local JSON pointer inside the asset, returning the $defs
// name when the pointer goes through one.
func (ps *positions) byRef(ref string) (map[string]any, string) {
	if !strings.HasPrefix(ref, "#") {
		return nil, ""
	}
	tokens := strings.Split(strings.TrimPrefix(ref, "#/"), "/")
	var cur any = ps.root
	for _, t := range tokens {
		if t == "" {
			continue
		}
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, ""
		}
		cur = m[unescapeToken(t)]
	}
	m, ok := cur.(map[string]any)
	if !ok {
		return nil, ""
	}
	def := ""
	if len(tokens) >= 2 && tokens[0] == "$defs" {
		def = tokens[1]
	}
	return m, def
}

func unescapeToken(t string) string {
	t = strings.ReplaceAll(t, "~1", "/")
	return strings.ReplaceAll(t, "~0", "~")
}

func followRef(root map[string]any, s map[string]any) (map[string]any, bool) {
	ref, _ := s["$ref"].(string)
	if ref == "" {
		return s, true
	}
	ps := &positions{root: root}
	r, _ := ps.byRef(ref)
	return r, r != nil
}

func followRefKeep(root map[string]any, s map[string]any) (map[string]any, string) {
	ref, _ := s["$ref"].(string)
	if ref == "" {
		return nil, ""
	}
	ps := &positions{root: root}
	r, def := ps.byRef(ref)
	return r, def
}

// classify maps a leaf schema (and the $defs name it came from) onto a binding
// position.
func classify(s map[string]any, def string) string {
	switch def {
	case "bindingText":
		return PositionText
	case "bindingValue", "bindingOrString", "bindingOrInteger", "bindingOrBoolean", "bindingString":
		return PositionValue
	case "celExpression":
		return PositionExpression
	case "body":
		return PositionScope
	case "jsonSchemaObject":
		return PositionSchema
	}
	// A body/branches container that was inlined rather than $ref'd: the
	// compiler still has to recurse.
	if props, ok := s["properties"].(map[string]any); ok {
		if _, has := props["nodes"]; has {
			return PositionScope
		}
	}
	if s["type"] == "array" {
		if items, ok := s["items"].(map[string]any); ok {
			if ip, ok := items["properties"].(map[string]any); ok {
				if _, has := ip["id"]; has {
					return PositionScope
				}
			}
		}
	}
	// Unresolved is treated as a value position, not a literal one. A binding in
	// a place the walker could not classify is the author's business (the schema
	// already refused the document or accepts the value); refusing here would
	// turn a walker gap into a false binding_position_mismatch. Literalness is
	// only ever asserted when a $defs name positively says so — timeoutSeconds,
	// maxIterations, maxConcurrency and friends are integers in the schema, so a
	// ${{ … }} there still fails, as schema_shape.
	return PositionValue
}
