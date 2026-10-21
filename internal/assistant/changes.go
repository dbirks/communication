package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// ADR-0050 decision 5: the draft-edit change recording and the CLOSED
// inverse op. The model's text is never trusted: the applied op is one of
// ADR-0044's three ops, and the undo travels as the closed inverse the
// server recorded when it applied the op — {"draft_id", "inverse"} —
// never as model text.
//
// The YAML surgery here edits the document tree directly (like the UI's
// graphDoc), then re-runs the SAME loader + schema validation the draft
// validate path runs, so a malformed result is refused before it ever
// reaches the version-checked PUT.

// InverseOp is the closed inverse of one applied draft op
// (decision 5's table): insert_after / insert_on_edge invert to
// delete_node; update_prompt inverts to update_prompt with the PREVIOUS
// prompt text the server recorded.
type InverseOp struct {
	Op     string `json:"op"` // delete_node | update_prompt
	Node   string `json:"node"`
	Prompt string `json:"prompt,omitempty"`
}

// draftUndoPayload is the assistant_changes.undo_payload document for a
// draft_edit row. It is never returned on any read route (decision 1);
// only its presence (undoable) is.
type draftUndoPayload struct {
	DraftID string    `json:"draft_id"`
	Inverse InverseOp `json:"inverse"`
}

// ErrInverseNotApplicable is the structural refusal: the inverse op does
// not apply to the draft's current version (the inserted node is gone or
// gained dependents). The draft is left untouched and the 409 detail says
// so (decision 5).
var ErrInverseNotApplicable = errors.New("assistant: the inverse op does not structurally apply")

// inverseFor builds the closed inverse of one applied op.
// previousPrompt is the prompt text BEFORE the update_prompt edit (the
// server's own record).
func inverseFor(p Proposal, previousPrompt string) (InverseOp, bool) {
	switch p.Op {
	case "insert_after", "insert_on_edge":
		if p.ID == "" {
			return InverseOp{}, false
		}
		return InverseOp{Op: "delete_node", Node: p.ID}, true
	case "update_prompt":
		if p.Node == "" {
			return InverseOp{}, false
		}
		return InverseOp{Op: "update_prompt", Node: p.Node, Prompt: previousPrompt}, true
	default:
		return InverseOp{}, false
	}
}

// --- the YAML tree machinery -------------------------------------------

// docRoot loads one draft document into a YAML tree the ops can walk.
func docRoot(text []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(text, &doc); err != nil {
		return nil, fmt.Errorf("the draft is not a yaml document: %s", firstDiagErr(err))
	}
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) != 1 {
			return nil, errors.New("the draft document is empty")
		}
		return doc.Content[0], nil
	}
	if doc.Kind != yaml.MappingNode {
		return nil, errors.New("the draft document is not a mapping")
	}
	return &doc, nil
}

func firstDiagErr(err error) string {
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i > 0 {
		s = s[:i]
	}
	return bounded(s, 200)
}

// nodeMapping is one node item inside a nodes sequence.
type nodeMapping struct {
	seq  *yaml.Node
	idx  int
	node *yaml.Node
}

// mapValue returns one key of a mapping node as its value node.
func mapValue(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func scalarValue(n *yaml.Node) string {
	if n == nil {
		return ""
	}
	return n.Value
}

// newMapping builds a flat string-keyed YAML mapping (insertion order).
func newMapping(kv ...string) *yaml.Node {
	m := &yaml.Node{Kind: yaml.MappingNode}
	for i := 0; i+1 < len(kv); i += 2 {
		m.Content = append(m.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: kv[i]},
			&yaml.Node{Kind: yaml.ScalarNode, Value: kv[i+1]})
	}
	return m
}

// setMappingKey inserts or replaces one key of a mapping node.
func setMappingKey(m *yaml.Node, key string, v *yaml.Node) {
	if m == nil || m.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content[i+1] = v
			return
		}
	}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, v)
}

// nodesLists walks every nodes sequence the document holds: spec.nodes and
// the children every scope holds (until/for_each body.nodes, parallel
// branches[].nodes) — the same walk LoadDraftDoc runs.
func nodesLists(root *yaml.Node) []nodeMapping {
	var out []nodeMapping
	collect := func(seq *yaml.Node) {
		if seq == nil || seq.Kind != yaml.SequenceNode {
			return
		}
		for i, item := range seq.Content {
			if item.Kind != yaml.MappingNode {
				continue
			}
			out = append(out, nodeMapping{seq: seq, idx: i, node: item})
		}
	}
	spec := mapValue(root, "spec")
	collect(mapValue(spec, "nodes"))
	for _, nm := range append([]nodeMapping(nil), out...) {
		cfg := mapValue(nm.node, "config")
		body := mapValue(cfg, "body")
		collect(mapValue(body, "nodes"))
		if branches := mapValue(cfg, "branches"); branches != nil && branches.Kind == yaml.SequenceNode {
			for _, br := range branches.Content {
				collect(mapValue(br, "nodes"))
			}
		}
	}
	return out
}

// findNodeMapping locates the node mapping with the given id, wherever it
// sits in the scopes.
func findNodeMapping(root *yaml.Node, id string) (nodeMapping, error) {
	for _, nm := range nodesLists(root) {
		if scalarValue(mapValue(nm.node, "id")) == id {
			return nm, nil
		}
	}
	return nodeMapping{}, fmt.Errorf("the draft has no node with id %q", id)
}

// dependsOnList returns the node's dependsOn sequence (nil when absent).
func dependsOnList(nm nodeMapping) *yaml.Node {
	return mapValue(nm.node, "dependsOn")
}

func dependsOnIDs(nm nodeMapping) []string {
	deps := dependsOnList(nm)
	if deps == nil {
		return nil
	}
	var out []string
	for _, item := range deps.Content {
		if s := scalarValue(item); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// setDependsOn replaces the node's dependsOn with the given ids.
func setDependsOn(nm nodeMapping, ids []string) {
	seq := &yaml.Node{Kind: yaml.SequenceNode}
	for _, id := range ids {
		seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: id})
	}
	setMappingKey(nm.node, "dependsOn", seq)
}

// dependentsOf lists every node whose dependsOn names id.
func dependentsOf(root *yaml.Node, id string) []nodeMapping {
	var out []nodeMapping
	for _, nm := range nodesLists(root) {
		if scalarValue(mapValue(nm.node, "id")) == id {
			continue
		}
		for _, dep := range dependsOnIDs(nm) {
			if dep == id {
				out = append(out, nm)
				break
			}
		}
	}
	return out
}

// marshalDoc re-serializes the tree and re-runs the SAME loader + schema
// validation the draft validate path runs (decision 5's
// "canonicalize/validate ... path"): a malformed result is refused before
// it can reach the version-checked PUT.
func marshalDoc(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(root); err != nil {
		_ = enc.Close()
		return nil, fmt.Errorf("the edited document does not serialize: %s", firstDiagErr(err))
	}
	_ = enc.Close()
	out := buf.Bytes()
	doc, diags := loader.Load(out)
	if len(diags) > 0 {
		return nil, fmt.Errorf("the edited document no longer loads: %s", firstDiag(diags))
	}
	if diags2 := draftSchemaValidator.Validate(doc.Map()); len(diags2) > 0 {
		return nil, fmt.Errorf("the edited document no longer validates: %s", firstDiag(diags2))
	}
	return out, nil
}

var draftSchemaValidator = schema.MustCompile()

// --- the three closed ops ----------------------------------------------

// applyDraftOp applies one ADR-0044 op to the draft's current YAML and
// returns the new bytes. The op's structural preconditions (the node
// exists, the id is free, the edge exists, ...) are ValidateProposal's to
// check on the parsed Doc; the tree walk here re-checks them on the raw
// tree so a lie cannot land.
func applyDraftOp(text []byte, p Proposal) ([]byte, error) {
	root, err := docRoot(text)
	if err != nil {
		return nil, err
	}
	switch p.Op {
	case "insert_after", "insert_on_edge":
		nm, err := findNodeMapping(root, insertAnchor(p))
		if err != nil {
			return nil, err
		}
		node := newMapping("id", p.ID, "kind", p.Kind)
		if p.Config != nil && len(p.Config) > 0 {
			cfg, err := configNode(p.Config)
			if err != nil {
				return nil, err
			}
			setMappingKey(node, "config", cfg)
		}
		switch p.Op {
		case "insert_after":
			setDependsOn(nodeMapping{node: node}, []string{p.After})
		default: // insert_on_edge: split from -> to at `to`
			setDependsOn(nodeMapping{node: node}, []string{p.From})
			to, err := findNodeMapping(root, p.To)
			if err != nil {
				return nil, err
			}
			if !hasEdgeRef(to, p.From) {
				return nil, fmt.Errorf("the draft has no edge from %q to %q", p.From, p.To)
			}
			rewire := make([]string, 0, len(dependsOnIDs(to))+1)
			for _, dep := range dependsOnIDs(to) {
				if dep == p.From {
					rewire = append(rewire, p.ID)
				} else {
					rewire = append(rewire, dep)
				}
			}
			setDependsOn(to, rewire)
		}
		nm.seq.Content = append(nm.seq.Content, nil)
		copy(nm.seq.Content[nm.idx+2:], nm.seq.Content[nm.idx+1:])
		nm.seq.Content[nm.idx+1] = node
	case "update_prompt":
		nm, err := findNodeMapping(root, p.Node)
		if err != nil {
			return nil, err
		}
		cfg := mapValue(nm.node, "config")
		if cfg == nil || cfg.Kind != yaml.MappingNode {
			cfg = newMapping()
			setMappingKey(nm.node, "config", cfg)
		}
		setMappingKey(cfg, "prompt", &yaml.Node{Kind: yaml.ScalarNode, Value: p.Prompt})
	default:
		return nil, fmt.Errorf("unknown op %q", p.Op)
	}
	return marshalDoc(root)
}

// insertAnchor is the node the new node is spliced after.
func insertAnchor(p Proposal) string {
	if p.Op == "insert_after" {
		return p.After
	}
	return p.To
}

// configNode turns the model-supplied config (bounded keys, scalar
// values only) into a YAML mapping. Secret-shaped values are refused the
// way ADR-0018's egress gate refuses them: the config travels as refs and
// plain values a node needs to run, never as material.
func configNode(cfg map[string]any) (*yaml.Node, error) {
	m := &yaml.Node{Kind: yaml.MappingNode}
	for k, v := range cfg {
		key := bounded(strings.TrimSpace(k), 64)
		if key == "" || !configKeyRe.MatchString(key) {
			return nil, fmt.Errorf("config key %q is not allowed", key)
		}
		switch sv := v.(type) {
		case string:
			m.Content = append(m.Content,
				&yaml.Node{Kind: yaml.ScalarNode, Value: key},
				&yaml.Node{Kind: yaml.ScalarNode, Value: bounded(sv, 4000)})
		case bool:
			m.Content = append(m.Content,
				&yaml.Node{Kind: yaml.ScalarNode, Value: key},
				&yaml.Node{Kind: yaml.ScalarNode, Value: fmt.Sprint(sv)})
		case float64:
			m.Content = append(m.Content,
				&yaml.Node{Kind: yaml.ScalarNode, Value: key},
				&yaml.Node{Kind: yaml.ScalarNode, Value: fmt.Sprint(sv)})
		default:
			return nil, fmt.Errorf("config value for %q must be a string, number or boolean", key)
		}
	}
	return m, nil
}

var configKeyRe = configKeyPattern()

// configKeyPattern is the node-config key rule: a yaml key a node config
// can hold (the loader's key rules kept simple).
func configKeyPattern() *regexp.Regexp {
	return regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`)
}

// applyInverse runs the CLOSED inverse of one applied op against the
// draft's current bytes (decision 5's undo semantics). delete_node also
// restores the edge insert_on_edge rewired: a dependent that exists ONLY
// because of the edit is spliced back to the inserted node's single
// source. Anything the inverse cannot prove it can reverse is a
// structural refusal with the draft left untouched.
func applyInverse(text []byte, inv InverseOp) ([]byte, error) {
	root, err := docRoot(text)
	if err != nil {
		return nil, err
	}
	switch inv.Op {
	case "delete_node":
		nm, err := findNodeMapping(root, inv.Node)
		if err != nil {
			return nil, fmt.Errorf("%w: the node %q is no longer in the draft",
				ErrInverseNotApplicable, inv.Node)
		}
		deps := dependsOnIDs(nm)
		for _, dep := range dependentsOf(root, inv.Node) {
			if len(deps) != 1 {
				return nil, fmt.Errorf("%w: the inserted node %q now has dependents; the draft is left untouched",
					ErrInverseNotApplicable, inv.Node)
			}
			// Restore the rewired edge: the dependent now depends on the
			// inserted node where it used to depend on the node's single
			// source.
			rewire := make([]string, 0, len(dependsOnIDs(dep))+1)
			replaced := false
			for _, d := range dependsOnIDs(dep) {
				if d == inv.Node {
					rewire = append(rewire, deps[0])
					replaced = true
				} else {
					rewire = append(rewire, d)
				}
			}
			if !replaced {
				return nil, fmt.Errorf("%w: the draft was edited around %q; the draft is left untouched",
					ErrInverseNotApplicable, inv.Node)
			}
			setDependsOn(dep, rewire)
		}
		nm.seq.Content = append(nm.seq.Content[:nm.idx], nm.seq.Content[nm.idx+1:]...)
	case "update_prompt":
		nm, err := findNodeMapping(root, inv.Node)
		if err != nil {
			return nil, fmt.Errorf("%w: the node %q is no longer in the draft",
				ErrInverseNotApplicable, inv.Node)
		}
		cfg := mapValue(nm.node, "config")
		if cfg == nil || cfg.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("%w: the node %q no longer carries a prompt",
				ErrInverseNotApplicable, inv.Node)
		}
		setMappingKey(cfg, "prompt", &yaml.Node{Kind: yaml.ScalarNode, Value: inv.Prompt})
	default:
		return nil, fmt.Errorf("%w: unknown inverse op %q", ErrInverseNotApplicable, inv.Op)
	}
	return marshalDoc(root)
}

// hasEdgeRef reports whether nm's dependsOn names id (the raw-tree twin of
// proposal.go's hasEdge).
func hasEdgeRef(nm nodeMapping, id string) bool {
	for _, dep := range dependsOnIDs(nm) {
		if dep == id {
			return true
		}
	}
	return false
}

// --- the Undoer ---------------------------------------------------------

// DraftEditUndoer is the ADR-0050 Undoer for draft_edit rows: it applies
// the change's recorded inverse op to the draft's CURRENT version through
// the same version-checked PUT path the edit used, as the caller (whose
// draft-write right is re-checked inside the service). Every miss — the
// draft is gone, the version moved, the caller lost the right, the inverse
// does not structurally apply — is a refusal, and the draft is left
// untouched because the stamp happens only after this returns nil.
type DraftEditUndoer struct {
	Draft DraftService
}

// UndoChange implements Undoer.
func (u DraftEditUndoer) UndoChange(ctx context.Context, c Caller, changeID string, payload json.RawMessage) error {
	if u.Draft == nil {
		return errors.New("no draft service is wired into this deployment")
	}
	var rec draftUndoPayload
	if err := json.Unmarshal(payload, &rec); err != nil || rec.DraftID == "" {
		return fmt.Errorf("the change's undo record is not a draft edit: %s", firstDiagErr(err))
	}
	doc, err := u.Draft.GetDocument(ctx, c, rec.DraftID)
	if err != nil {
		return fmt.Errorf("the draft no longer exists or is not writable by this caller: %s",
			firstDiagErr(err))
	}
	out, err := applyInverse(doc.Document, rec.Inverse)
	if err != nil {
		if errors.Is(err, ErrInverseNotApplicable) {
			return err
		}
		return fmt.Errorf("the inverse op cannot be applied: %s", firstDiagErr(err))
	}
	if _, err := u.Draft.ReplaceDocument(ctx, c, rec.DraftID, out, doc.Version); err != nil {
		return fmt.Errorf("the draft moved since the edit (version %d is no longer current); the change cannot be undone",
			doc.Version)
	}
	return nil
}
