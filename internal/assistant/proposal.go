package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
)

// This file is ADR-0044's closed operation set: the assistant proposes ONE
// structural change to a draft, the server validates it against the draft
// itself, and the UI applies it with the same graphDoc op a human gesture
// uses. The model's text is never trusted: it is one JSON object from a fixed
// enum, or a 422 at the route (the model is not re-asked).

// The three ops of the closed set (ADR-0044 § 2).
const (
	OpInsertAfter  = "insert_after"
	OpInsertOnEdge = "insert_on_edge"
	OpUpdatePrompt = "update_prompt"
)

// executableKinds is the kind set a proposal may insert: the compiler's
// executed catalogue (compiler.ExecutedKinds, guarded against the shipped
// schema by the compiler's own contract test — no hard-coded copy here),
// minus the Publish kinds. ADR-0045 keeps the Publish kinds out of new
// authoring, so the assistant adds working nodes, never publish nodes
// (artifact.publish is executed but still excluded; git.publish is not
// executed yet). The schema's validate-only kinds (parallel, join, gate,
// git.commit, integration.*) never appear: a proposal the run would refuse
// to execute is not a proposal.
var executableKinds = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range compiler.ExecutedKinds() {
		m[k] = true
	}
	delete(m, "git.publish")
	delete(m, "artifact.publish")
	return m
}()

// executableKindList is the insertable kind set in stable order — the list
// the draft.apply tool's description and every unknown_kind refusal name.
func executableKindList() []string {
	out := make([]string, 0, len(executableKinds))
	for k := range executableKinds {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// kindSuggestion names the closest insertable kind to a rejected value so
// the model can correct itself in the same turn: a dotted suffix first
// ("approval" -> "human.approval"), then a unique substring, then an edit
// distance small enough to be a misspelling rather than a different
// concept.
func kindSuggestion(got string) string {
	g := strings.ToLower(strings.TrimSpace(got))
	if g == "" {
		return ""
	}
	var suffix, substr []string
	best, bestDist := "", 1<<30
	for _, k := range executableKindList() {
		if k == g {
			continue
		}
		if strings.HasSuffix(k, g) {
			suffix = append(suffix, k)
		}
		if strings.Contains(k, g) {
			substr = append(substr, k)
		}
		if d := editDistance(g, k); d < bestDist {
			best, bestDist = k, d
		}
	}
	switch {
	case len(suffix) == 1:
		return suffix[0]
	case len(substr) == 1:
		return substr[0]
	case bestDist <= 3 && bestDist < len(g)/2+1:
		return best
	}
	return ""
}

// editDistance is the classic Levenshtein distance for the misspelling
// fallback of kindSuggestion (both strings are short kind names).
func editDistance(a, b string) int {
	ca, cb := []rune(a), []rune(b)
	dist := make([]int, len(cb)+1)
	for j := range dist {
		dist[j] = j
	}
	for i, ra := range ca {
		prev := dist[0]
		dist[0] = i + 1
		for j, rb := range cb {
			old := dist[j+1] // the value the NEXT row's prev needs
			cur := old
			cost := 1
			if ra == rb {
				cost = 0
			}
			if v := dist[j] + cost; v < cur { // substitute
				cur = v
			}
			if v := prev + 1; v < cur { // insert
				cur = v
			}
			if v := old + 1; v < cur { // delete
				cur = v
			}
			dist[j+1] = cur
			prev = old
		}
	}
	return dist[len(cb)]
}

// proposalIDPattern is the schema's `identifier` pattern verbatim
// (pipeline-v1alpha1.schema.json $defs/identifier): it deliberately excludes
// '-' and '.' so every id is a legal single CEL selector.
var proposalIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// PromptPreviewLimit caps the prompt text the draft summary carries to the
// model (the task pins 400 characters).
const PromptPreviewLimit = 400

// Proposal is ONE validated operation. Config travels for insert ops
// (secretRefs stay refs, never values — the draft's own bytes are the
// source); Prompt for update_prompt. Extra fields the model adds are dropped
// by the typed decode, so the response carries only the validated shape.
type Proposal struct {
	Op      string         `json:"op"`
	After   string         `json:"after,omitempty"`
	From    string         `json:"from,omitempty"`
	To      string         `json:"to,omitempty"`
	Node    string         `json:"node,omitempty"`
	Kind    string         `json:"kind,omitempty"`
	ID      string         `json:"id,omitempty"`
	Config  map[string]any `json:"config,omitempty"`
	Prompt  string         `json:"prompt,omitempty"`
	Summary string         `json:"summary,omitempty"`
}

// ProposalError is a structural refusal with the stable reason the 422's
// detail names. Reasons:
//
//	unknown_op            the op is outside the closed set
//	unknown_kind          the kind is not an executable node kind
//	bad_id                the new id breaks the identifier pattern
//	id_taken              the new id collides with an existing draft node
//	unknown_node          a referenced id (after/from/to/node) is not in the draft
//	target_has_dependents insert_after on a node that already has dependents
//	no_edge               insert_on_edge on a pair with no dependsOn edge
//	scope_mismatch        from and to are in different scopes
//	guarded_target        the edge target has a when guard
//	condition_source      the edge source is a condition node
//	error_route           the edge is an onFailure.errorRoute
//	edge_guarded          the target's when/config reads nodes.<from>.*
//	wrong_kind            update_prompt on a node that is not agent.acp
//	prompt_kind_not_supported update_prompt on a model.chat node
//	empty_prompt          update_prompt with no prompt text
type ProposalError struct {
	Reason string
	Detail string
}

func (e *ProposalError) Error() string { return e.Reason + ": " + e.Detail }

func proposalError(reason, format string, args ...any) *ProposalError {
	return &ProposalError{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// DocNode is one node of the draft tree: the members ValidateProposal and
// the model summary need, never the raw config (secrets do not travel to the
// model). ConfigText is the compact JSON of when+config used ONLY for the
// edge-guard mention check.
type DocNode struct {
	ID         string
	Kind       string
	Scope      string // "" at the top level, the enclosing scope node's id
	DependsOn  []string
	When       string
	Profile    string
	Prompt     string
	ErrorRoute string // the node's own onFailure.errorRoute, when set
	ConfigText string // compact JSON of the config ("" when absent)
}

// Doc is the draft's node tree: spec.nodes plus the children every scope
// holds (until/for_each bodies, parallel branches). dependsOn never crosses
// a scope boundary, so every edge stays inside one scope.
type Doc struct {
	byID  map[string]DocNode
	order []string
}

// LoadDraftDoc parses a draft's document_yaml with the SAME loader the
// validate path runs (loader.Load), then walks the node tree. A document the
// loader refuses never reaches a proposal.
func LoadDraftDoc(text []byte) (*Doc, error) {
	doc, diags := loader.Load(text)
	if len(diags) > 0 {
		return nil, fmt.Errorf("the draft document does not load: %s", firstDiag(diags))
	}
	m := doc.Map()
	if m == nil {
		return nil, errors.New("the draft document is not a mapping")
	}
	spec, _ := m["spec"].(canon.Map)
	nodes, _ := spec["nodes"].([]any)
	if nodes == nil {
		return nil, errors.New("the draft has no spec.nodes")
	}
	d := &Doc{byID: map[string]DocNode{}}
	if err := d.append(nodes, ""); err != nil {
		return nil, err
	}
	return d, nil
}

// append walks one level of spec.nodes (or a scope body / branch).
func (d *Doc) append(nodes []any, scope string) error {
	for _, item := range nodes {
		m, ok := item.(canon.Map)
		if !ok {
			return errors.New("a node is not a mapping")
		}
		id := nodeString(m["id"])
		kind := nodeString(m["kind"])
		if id == "" {
			return errors.New("a node has no id")
		}
		cfg, _ := m["config"].(canon.Map)
		n := DocNode{ID: id, Kind: kind, Scope: scope, When: nodeString(m["when"])}
		if list, ok := m["dependsOn"].([]any); ok {
			n.DependsOn = nodeStrings(list)
		}
		if onFailure, ok := m["onFailure"].(canon.Map); ok {
			n.ErrorRoute = nodeString(onFailure["errorRoute"])
		}
		if cfg != nil {
			n.Profile = nodeString(cfg["profile"])
			n.Prompt = nodeString(cfg["prompt"])
			if blob, err := json.Marshal(cfg); err == nil {
				n.ConfigText = string(blob)
			}
			// The scopes that hold their children: until/for_each bodies
			// and parallel branches.
			if body, ok := cfg["body"].(canon.Map); ok {
				if children, ok := body["nodes"].([]any); ok {
					if err := d.append(children, id); err != nil {
						return err
					}
				}
			}
			if branches, ok := cfg["branches"].([]any); ok {
				for _, item := range branches {
					br, ok := item.(canon.Map)
					if !ok {
						return errors.New("a parallel branch is not a mapping")
					}
					if children, ok := br["nodes"].([]any); ok {
						if err := d.append(children, id); err != nil {
							return err
						}
					}
				}
			}
		}
		if _, exists := d.byID[id]; !exists {
			d.byID[id] = n
			d.order = append(d.order, id)
		} else {
			d.byID[id] = n
		}
	}
	return nil
}

// Find returns the node with the given id, wherever it sits in the scopes.
func (d *Doc) Find(id string) (DocNode, bool) {
	if d == nil {
		return DocNode{}, false
	}
	n, ok := d.byID[id]
	return n, ok
}

// HasID reports whether the id is used anywhere in the document.
func (d *Doc) HasID(id string) bool {
	_, ok := d.Find(id)
	return ok
}

// DependentsInScope names the nodes IN THE SAME SCOPE AS n whose dependsOn
// contains n.ID — the nodes an insert_after would have to rewire.
func (d *Doc) DependentsInScope(n DocNode) []string {
	var out []string
	for _, id := range d.order {
		m := d.byID[id]
		if m.ID == n.ID || m.Scope != n.Scope {
			continue
		}
		for _, dep := range m.DependsOn {
			if dep == n.ID {
				out = append(out, m.ID)
				break
			}
		}
	}
	return out
}

// nodeString reads a string member out of a canon value.
func nodeString(v any) string {
	s, _ := v.(string)
	return s
}

func nodeStrings(list []any) []string {
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func firstDiag(diags diag.List) string {
	return diags[0].String()
}

// ValidateProposal checks ONE proposal against the draft. It is pure — no
// model, no store — so the refusal rules are unit-tested on the probe
// pipeline and the route shares them verbatim. The § 4 edge rules of the
// Studio design apply here too: a proposal that would split a guarded,
// condition or error-route edge is refused, not returned for the UI to
// explain.
func ValidateProposal(d *Doc, p Proposal) *ProposalError {
	if d == nil || len(d.order) == 0 {
		return proposalError("unknown_node", "the draft has no nodes")
	}
	switch p.Op {
	case OpInsertAfter:
		if err := validateInsertKindID(d, p); err != nil {
			return err
		}
		after, ok := d.Find(p.After)
		if !ok {
			return unknownNodeError(d, p.After)
		}
		if deps := d.DependentsInScope(after); len(deps) > 0 {
			return proposalError("target_has_dependents",
				"node %q already has dependents in its scope (%s); use insert_on_edge to split a specific edge", p.After, strings.Join(deps, ", "))
		}
		return nil
	case OpInsertOnEdge:
		if err := validateInsertKindID(d, p); err != nil {
			return err
		}
		from, ok := d.Find(p.From)
		if !ok {
			return unknownNodeError(d, p.From)
		}
		to, ok := d.Find(p.To)
		if !ok {
			return unknownNodeError(d, p.To)
		}
		if !hasEdge(to.DependsOn, p.From) {
			return proposalError("no_edge", "node %q does not depend on node %q; there is no edge to split", to.ID, from.ID)
		}
		if from.Scope != to.Scope {
			return proposalError("scope_mismatch", "nodes %q and %q are in different scopes; dependsOn never crosses a scope boundary", from.ID, to.ID)
		}
		if to.When != "" {
			return proposalError("guarded_target", "node %q runs only when %q; a guarded edge cannot be split", to.ID, to.When)
		}
		if from.Kind == "condition" {
			return proposalError("condition_source", "node %q is a condition; its downstream edges encode route guards", from.ID)
		}
		if from.ErrorRoute == to.ID {
			return proposalError("error_route", "the edge %q -> %q is an error route (onFailure.errorRoute)", from.ID, to.ID)
		}
		needle := "nodes." + from.ID + "."
		if strings.Contains(to.When, needle) || strings.Contains(to.ConfigText, needle) {
			return proposalError("edge_guarded", "node %q reads %s in its when/config; a bound edge cannot be split", to.ID, from.ID)
		}
		return nil
	case OpUpdatePrompt:
		node, ok := d.Find(p.Node)
		if !ok {
			return unknownNodeError(d, p.Node)
		}
		if node.Kind == "model.chat" {
			return proposalError("prompt_kind_not_supported", "node %q is model.chat; update_prompt edits agent.acp prompts only", p.Node)
		}
		if node.Kind != "agent.acp" {
			return proposalError("wrong_kind", "update_prompt edits agent.acp prompts; node %q is %s", p.Node, node.Kind)
		}
		if strings.TrimSpace(p.Prompt) == "" {
			return proposalError("empty_prompt", "prompt is required and must be non-empty")
		}
		return nil
	default:
		return proposalError("unknown_op", "op %q is not one of %s", p.Op, strings.Join(validOpList(), ", "))
	}
}

// validOpList is the closed op set (ADR-0044 § 2) in stable order — what the
// draft.apply tool's description and the unknown_op refusal name.
func validOpList() []string {
	return []string{OpInsertAfter, OpInsertOnEdge, OpUpdatePrompt}
}

// unknownNodeError is the unknown_node refusal with the draft's own node
// ids, so a tool result can show the model the anchors it must retry with
// (the acceptance failure this exists for: the model could not see the ids
// it must anchor on).
func unknownNodeError(d *Doc, id string) *ProposalError {
	return proposalError("unknown_node", "node %q is not in the draft%s", id, d.idTail())
}

// idTail is the draft's node ids for an error detail, capped so one detail
// cannot outgrow the bounded tool payload.
func (d *Doc) idTail() string {
	if d == nil || len(d.order) == 0 {
		return ""
	}
	ids := append([]string(nil), d.order...)
	if len(ids) > 24 {
		ids = append(ids[:24], "…")
	}
	return "; this draft's node ids are: " + strings.Join(ids, ", ")
}

// validateInsertKindID is the shared half of the two insert ops: the kind is
// executable, the id is well-formed and unused.
func validateInsertKindID(d *Doc, p Proposal) *ProposalError {
	if !executableKinds[p.Kind] {
		detail := fmt.Sprintf("kind %q is not a node kind the assistant can add", p.Kind)
		if s := kindSuggestion(p.Kind); s != "" {
			detail += fmt.Sprintf("; did you mean %q?", s)
		}
		detail += "; valid kinds: " + strings.Join(executableKindList(), ", ")
		return proposalError("unknown_kind", "%s", detail)
	}
	if !proposalIDPattern.MatchString(p.ID) {
		return proposalError("bad_id", "id %q must match the schema identifier pattern %s", p.ID, proposalIDPattern.String())
	}
	if d.HasID(p.ID) {
		return proposalError("id_taken", "id %q is already used in the draft", p.ID)
	}
	return nil
}

func hasEdge(deps []string, id string) bool {
	for _, d := range deps {
		if d == id {
			return true
		}
	}
	return false
}

// ExtractProposal pulls the ONE JSON object out of the model's answer. It
// tolerates a ```json fence and a <think>...</think> prefix (reasoning
// models) and nothing else: a second object, trailing prose or malformed
// JSON is a refusal the route turns into 422 (the model is not re-asked).
func ExtractProposal(raw string) (Proposal, error) {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "<think") {
		i := strings.Index(s, "</think>")
		if i < 0 {
			return Proposal{}, errors.New("the answer's think block never closes")
		}
		s = strings.TrimSpace(s[i+len("</think>"):])
	}
	if strings.HasPrefix(s, "```") {
		end := strings.IndexByte(s, '\n')
		if end < 0 {
			return Proposal{}, errors.New("the fenced answer has no body")
		}
		body := s[end+1:]
		closeIdx := strings.LastIndex(body, "```")
		if closeIdx < 0 {
			return Proposal{}, errors.New("the fenced answer is not closed")
		}
		s = strings.TrimSpace(body[:closeIdx])
	}
	dec := json.NewDecoder(strings.NewReader(s))
	var p Proposal
	if err := dec.Decode(&p); err != nil {
		return Proposal{}, fmt.Errorf("the answer is not a JSON object: %v", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return Proposal{}, errors.New("the answer is not exactly one JSON object")
	}
	if p.Op == "" {
		return Proposal{}, errors.New("the answer object has no op")
	}
	return p, nil
}

// draftNodeView is one row of draft.get's structural view (the tool the
// model plans a draft edit from): everything an insert can anchor on, and
// nothing a secret could travel in — no prompts, no config, no profiles.
type draftNodeView struct {
	ID        string   "json:\"id\""
	Kind      string   "json:\"kind\""
	Scope     string   "json:\"scope,omitempty\""
	DependsOn []string "json:\"depends_on,omitempty\""
	When      string   "json:\"when,omitempty\""
}

// structNodes renders the draft's node tree in draft order: every node,
// wherever it sits in the scopes, so a 13-node draft's ids all reach the
// model inside the draft.get cap.
func structNodes(d *Doc) []draftNodeView {
	out := make([]draftNodeView, 0, len(d.order))
	for _, id := range d.order {
		n := d.byID[id]
		out = append(out, draftNodeView{ID: n.ID, Kind: n.Kind, Scope: n.Scope,
			DependsOn: n.DependsOn, When: bounded(n.When, 200)})
	}
	return out
}

// ProposalNodeSummary is one row of the compact draft summary the model sees:
// ids, kinds, scopes, edges, guards, a 400-character prompt preview and the
// profile. Configs do not travel at all, so a secret value cannot reach the
// model (the draft's secret refs stay refs, as the ADR pins).
type ProposalNodeSummary struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Scope     string   `json:"scope,omitempty"`
	DependsOn []string `json:"depends_on,omitempty"`
	When      string   `json:"when,omitempty"`
	Prompt    string   `json:"prompt,omitempty"`
	Profile   string   `json:"profile,omitempty"`
}

// Summaries renders the compact node list in draft order.
func (d *Doc) Summaries() []ProposalNodeSummary {
	out := make([]ProposalNodeSummary, 0, len(d.order))
	for _, id := range d.order {
		n := d.byID[id]
		var prompt string
		if n.Kind == "agent.acp" || n.Kind == "model.chat" {
			runes := []rune(n.Prompt)
			if len(runes) > PromptPreviewLimit {
				prompt = string(runes[:PromptPreviewLimit]) + "…"
			} else {
				prompt = n.Prompt
			}
		}
		out = append(out, ProposalNodeSummary{
			ID: n.ID, Kind: n.Kind, Scope: n.Scope, DependsOn: n.DependsOn,
			When: n.When, Prompt: prompt, Profile: n.Profile,
		})
	}
	return out
}

// ProposalPrompt builds the one-shot (system, user) pair for a proposal turn:
// the closed op set, the draft summary, the caller's profile list and the
// instruction. One request, one JSON object, no re-ask (ADR-0044 § 3).
func ProposalPrompt(summariesJSON []byte, profiles []string, instruction string) (string, string) {
	system := `You edit pipeline drafts for a software engineering platform. Answer with exactly ONE JSON object and no other text, one of:
{"op":"insert_after","after":"<existing node id>","kind":"<node kind>","id":"<new node id>","config":{...},"summary":"<one short sentence>"}
{"op":"insert_on_edge","from":"<existing node id>","to":"<existing node id>","kind":"<node kind>","id":"<new node id>","config":{...},"summary":"<one short sentence>"}
{"op":"update_prompt","node":"<existing node id>","prompt":"<the new prompt text>","summary":"<one short sentence>"}
Rules: kind is one of ` + strings.Join(executableKindList(), ", ") + `. The new id must match ^[a-z][a-z0-9_]{0,62}$ and must not already be used in the draft. insert_after is only possible when the node named by "after" has no dependents in its scope: if depends_on of ANY node in the draft names it, insert_after is invalid for it and you MUST use insert_on_edge with "from" set to that node and "to" set to one of its dependents (split the first such edge). insert_on_edge splits the edge from->to, where "to" depends on "from"; never insert on an edge whose target has a when guard, whose source is a condition node, or whose target reads nodes.<source>. anywhere in its when/config. For an agent.acp config give {"profile":"<one of the available profile names>","prompt":"<the prompt text>"}. Never invent node ids, profile names or kinds.
Worked example: the draft has nodes tests and review, where review depends on tests. Instruction \"insert a code reviewer after tests\" => the target node already has a dependent, so the answer is {\"op\":\"insert_on_edge\",\"from\":\"tests\",\"to\":\"review\",\"kind\":\"agent.acp\",\"id\":\"code_reviewer\",\"config\":{\"profile\":\"m4-reviewer\",\"prompt\":\"Review the code.\"},\"summary\":\"Insert a code reviewer between tests and review\"} — NOT insert_after.`
	user := "Draft nodes (id, kind, scope, depends_on, when guard, prompt preview, profile):\n"
	user += string(summariesJSON)
	if len(profiles) > 0 {
		user += "\nAvailable agent profiles: " + strings.Join(profiles, ", ")
	}
	user += "\n\nInstruction: " + instruction
	return system, user
}

// CompleteText issues ONE completion — no tool loop — and returns the answer
// text. Egress failures carry the same Failure mapping the ask route uses
// (503 unreachable / 504 timeout / 502 malformed), so the proposals route
// and the ask route degrade identically.
func (b *Broker) CompleteText(ctx context.Context, system, user string) (string, *Failure) {
	// enable_thinking=false: the proposal turn is one-shot extraction from a
	// closed op set, not reasoning, and a thinking model spends minutes in
	// the thinking budget before it ever emits the JSON the route needs.
	ans, fail := b.complete(ctx, chatRequest{
		Model: b.cfg.Model,
		Messages: []chatMessage{
			{Role: "system", Content: text(system)},
			{Role: "user", Content: text(user)},
		},
		ChatTemplateKwargs: map[string]any{"enable_thinking": false},
	})
	if fail != nil {
		return "", fail
	}
	return ans.Text, nil
}
