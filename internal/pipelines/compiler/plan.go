package compiler

import (
	"bytes"
	"encoding/json"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/expr"
)

// PlanVersion versions the plan structure itself. A run pins
// {plan_digest, version}, so a plan-format change is visible in a run rather
// than a silently re-pinned revision.
const PlanVersion = "v1alpha1-plan-1"

// Execution locations (ADR-0023 § 3). A control-plane node never enters the
// leased state and never takes a worker lease; the CHECK that makes that
// unrepresentable is contract § 1's.
const (
	LocationWorker       = "worker"
	LocationControlPlane = "control_plane"
)

// Plan is the compiled, digestible form of one published revision. It is what
// `pipeline_revisions.compiled_plan` holds and what a run copies into
// `runs.plan_snapshot` (ADR-0023 § 2).
type Plan struct {
	Version     string         `json:"version"`
	DigestScope string         `json:"digest_scope"`
	CELVersion  string         `json:"cel_version"`
	Document    DocumentInfo   `json:"document"`
	Inputs      canon.Value    `json:"inputs"`
	Outputs     canon.Value    `json:"outputs,omitempty"`
	Policies    Policies       `json:"policies"`
	Scopes      []Scope        `json:"scopes"`
	Nodes       []Node         `json:"nodes"`
	Expressions []Expression   `json:"expressions"`
	RunBindings []NamedBinding `json:"run_bindings,omitempty"`
	Budgets     Budgets        `json:"budgets"`
	// SchemaDigest and CELEnvDigest let a revision prove which schema and
	// which CEL environment produced it (contract § 1's schema_digest /
	// cel_env_digest columns, § 6.2's doctor cells).
	SchemaDigest string `json:"schema_digest"`
	CELEnvDigest string `json:"cel_env_digest"`
}

// DocumentInfo is the identity carried into every run snapshot.
type DocumentInfo struct {
	APIVersion string `json:"api_version"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
}

// Policies is spec.policies after the engine ceilings and the assignment
// clamps.
type Policies struct {
	MaxConcurrentNodes int    `json:"maxConcurrentNodes"`
	MaxDurationSeconds int    `json:"maxDurationSeconds,omitempty"`
	MaxNodeExecutions  int    `json:"maxNodeExecutions"`
	MaxChildDepth      int    `json:"maxChildDepth"`
	WorkspaceMode      string `json:"workspaceMode,omitempty"`
	CancelPolicy       string `json:"cancelPolicy"`
}

// Budgets records the ceilings the plan was checked against, so a run can show
// "the assignment lowered this" instead of re-deriving it.
type Budgets struct {
	ExpressionsPerRevision int `json:"expressionsPerRevision"`
	EvaluationsPerRun      int `json:"evaluationsPerRun"`
	EvalCostLimit          int `json:"evalCostLimit"`
	MaxNodesPerScope       int `json:"maxNodesPerScope"`
	MaxTotalNodes          int `json:"maxTotalNodes"`
	MaxItemsPerForEach     int `json:"maxItemsPerForEach"`
	// MaxAttempts is ADR-0023 § 7's retry ceiling; a document asking for more is
	// invalid rather than silently truncated at runtime.
	MaxAttempts int `json:"maxAttempts"`
}

// DefaultBudgets is contract § 6's cap table.
func DefaultBudgets() Budgets {
	return Budgets{
		ExpressionsPerRevision: expr.ExpressionsPerRevision,
		EvaluationsPerRun:      expr.EvaluationsPerRun,
		EvalCostLimit:          expr.EvalCostLimit,
		MaxNodesPerScope:       200,
		MaxTotalNodes:          1000,
		MaxItemsPerForEach:     MaxForEachItems,
		MaxAttempts:            MaxAttemptsCeiling,
	}
}

// Scope is one DAG: the root, or a composite node's body. Keys are the same
// text paths node instance keys are built from ('/' for the root).
type Scope struct {
	Key                string   `json:"key"`
	Kind               string   `json:"kind"` // root | until | for_each | parallel
	Owner              string   `json:"owner,omitempty"`
	Parent             string   `json:"parent,omitempty"`
	EntryNodes         []string `json:"entryNodes"`
	TerminalNodes      []string `json:"terminalNodes"`
	TopologicalOrder   []string `json:"topologicalOrder"`
	ExpressionScope    string   `json:"expressionScope"` // pipeline | until | for_each | template
	MaxIterations      int      `json:"maxIterations,omitempty"`
	MaxDurationSeconds int      `json:"maxDurationSeconds,omitempty"`
	MaxConcurrency     int      `json:"maxConcurrency,omitempty"`
	OnChildFailure     string   `json:"onChildFailure,omitempty"`
	// IndexedSegments names the path segments that carry a runtime [i]
	// (an until's node id, a for_each's), so instance keys are derived, never
	// invented (ADR-0023 § 1).
	IndexedSegments []string `json:"indexedSegments,omitempty"`
}

// Node is one node in one scope, with its compiled bindings.
type Node struct {
	ID             string        `json:"id"`
	Kind           string        `json:"kind"`
	Scope          string        `json:"scope"`
	Path           []string      `json:"path"`
	InstanceKey    string        `json:"instanceKey"`
	Indexed        []string      `json:"indexed,omitempty"`
	DependsOn      []string      `json:"dependsOn,omitempty"`
	ExecLocation   string        `json:"executionLocation"`
	When           *Binding      `json:"when,omitempty"`
	Failure        FailurePolicy `json:"failure"`
	Retry          Retry         `json:"retry"`
	TimeoutSeconds int           `json:"timeoutSeconds,omitempty"`
	Outputs        canon.Value   `json:"outputs,omitempty"`
	EngineOutputs  []string      `json:"engineOutputs,omitempty"`
	// PassWhen/FailWhen/ResultBindings belong to a composite's body envelope.
	PassWhen       *Binding       `json:"passWhen,omitempty"`
	FailWhen       *Binding       `json:"failWhen,omitempty"`
	ResultBindings []NamedBinding `json:"resultBindings,omitempty"`
	ConfigBindings []Binding      `json:"configBindings,omitempty"`
	Workspace      *Workspace     `json:"workspace,omitempty"`
	SecretRefs     []string       `json:"secretRefs,omitempty"`
	Profile        string         `json:"profile,omitempty"`
	Route          string         `json:"route,omitempty"`
	SubScope       string         `json:"subScope,omitempty"`
	// TemplateRefs pins the node's `template: slug@semver` reference to the
	// revision it resolved against at compile time (ADR-0049 § 2.3). Covered
	// by plan_digest: a run executes the pinned revision forever, and the
	// store writes a pipeline_revision_template_refs row per entry at publish.
	TemplateRefs []TemplateRef `json:"templateRefs,omitempty"`
	// TemplateParams is the node's config as the template's parameter values
	// (ADR-0049 § 2: the node's config carries the parameter values). It is
	// stored on the plan so the composed ConfigBindings stay resolvable without
	// a claim-time lookup.
	TemplateParams canon.Value `json:"templateParams,omitempty"`
}

// TemplateRef is one ADR-0049 § 2 pinning entry: the template revision a
// node resolved to at compile time. Identity plus digest, so the plan can
// prove which canonical revision it was built from without re-reading it.
type TemplateRef struct {
	TemplateID             string `json:"template_id"`
	TemplateRevisionID     string `json:"template_revision_id"`
	TemplateRevisionDigest string `json:"template_revision_digest"`
}

// FailurePolicy is 03's failure table, compiled. Deviation D6: the error route
// is a readiness exception, not a graph edge, which is what keeps the DAG free
// of route-typed edges (ADR-0021 § 6).
type FailurePolicy struct {
	OnExecutionError string `json:"onExecutionError"`
	ErrorRoute       string `json:"errorRoute,omitempty"`
}

// Retry is the compiled retry policy, already clamped to the assignment.
type Retry struct {
	MaxAttempts     int      `json:"maxAttempts"`
	BaseSeconds     int      `json:"baseSeconds,omitempty"`
	Multiplier      float64  `json:"multiplier,omitempty"`
	MaxSeconds      int      `json:"maxSeconds,omitempty"`
	Jitter          bool     `json:"jitter,omitempty"`
	RetriableErrors []string `json:"retriableErrors,omitempty"`
	WorkspacePolicy string   `json:"workspacePolicy,omitempty"`
}

// Workspace is placement without a `workspace` CEL root (ADR-0022 § 2,
// contract § 9.1 row 9).
type Workspace struct {
	Mode         string    `json:"mode,omitempty"`
	Repositories []Binding `json:"repositories,omitempty"`
}

// Binding is one authored value after the splitter ran: a literal, or one or
// more compiled expressions referenced by ID.
type Binding struct {
	// Pointer locates the value in the document (the diagnostic location
	// grammar, reused for the plan).
	Pointer string `json:"pointer"`
	// Position is bindingText | bindingValue | expression.
	Position string `json:"position"`
	// ExprIDs lists the compiled expressions this value uses, in order.
	ExprIDs []string `json:"exprIds,omitempty"`
	// Literal is the authored value when it carries no expression.
	Literal canon.Value `json:"literal,omitempty"`
	// Fallback is the {expr, fallback} object's literal, when authored.
	Fallback canon.Value `json:"fallback,omitempty"`
	// Template keeps the authored text with ${{ }} replaced by expression
	// ids, so the advancer can join a bindingText value without re-splitting.
	Template string `json:"template,omitempty"`
}

// IsLiteral reports whether the binding needs no evaluation.
func (b Binding) IsLiteral() bool { return len(b.ExprIDs) == 0 }

// NamedBinding is a binding with the output name it produces (resultBindings
// and spec.resultBindings).
type NamedBinding struct {
	Name    string  `json:"name"`
	Binding Binding `json:"binding"`
}

// Expression is one compiled CEL expression: the unit plan_digest covers
// (ADR-0022 § 5 — source text, normalized AST, reference list).
type Expression struct {
	ID            string       `json:"id"`
	Pointer       string       `json:"pointer"`
	Scope         string       `json:"scope"`
	Position      string       `json:"position"`
	Source        string       `json:"source"`
	NormalizedAST string       `json:"normalized_ast"`
	Refs          []Ref        `json:"refs"`
	Literals      []string     `json:"literals,omitempty"`
	ResultType    string       `json:"result_type"`
	BoolPredicate bool         `json:"bool_predicate,omitempty"`
	Cost          CostEstimate `json:"cost"`
}

// Ref is one static read performed by an expression; the runtime uses the list
// to build the envelope (ADR-0022 § 5).
type Ref struct {
	Root  string   `json:"root"`
	Path  []string `json:"path,omitempty"`
	Guard bool     `json:"guard,omitempty"`
}

// Key renders the reference in envelope spelling.
func (r Ref) Key() string {
	out := r.Root
	for _, p := range r.Path {
		out += "." + p
	}
	return out
}

// CostEstimate is the static shape plus the runtime bound. The measured
// evaluation budget is 200 actual cost (contract § 6); the plan records the
// AST node count so a growth in expression complexity is visible in a diff.
type CostEstimate struct {
	Nodes       int `json:"nodes"`
	ActualLimit int `json:"actual_limit"`
}

// Value renders the plan as the canonical JSON tree that is stored and
// digested.
func (p *Plan) Value() (canon.Value, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// A plan holds no HTML-meaningful characters that json.Marshal would
	// escape differently across versions, and the digest is taken over the
	// canonical re-encode, not over these bytes.
	var v canon.Value
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return normalizeNumbers(v), nil
}

// normalizeNumbers turns json.Number into int64/float64 so the canonical
// encoder sees the loader's numeric model (integers stay integers).
func normalizeNumbers(v canon.Value) canon.Value {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return canon.Value(i)
		}
		f, err := t.Float64()
		if err != nil {
			return canon.Value(t.String())
		}
		return canon.Value(f)
	case map[string]canon.Value:
		out := make(map[string]canon.Value, len(t))
		for k, sub := range t {
			out[k] = normalizeNumbers(sub)
		}
		return out
	case []canon.Value:
		out := make([]canon.Value, len(t))
		for i, sub := range t {
			out[i] = normalizeNumbers(sub)
		}
		return out
	}
	return v
}

// Bytes returns the canonical JSON to store in compiled_plan.
func (p *Plan) Bytes() ([]byte, error) {
	v, err := p.Value()
	if err != nil {
		return nil, err
	}
	return canon.Canonicalize(v)
}

// Digest returns plan_digest over the plan's canonical bytes.
func (p *Plan) Digest() (string, error) {
	b, err := p.Bytes()
	if err != nil {
		return "", err
	}
	return canon.Digest(b), nil
}

// FindNode returns the plan node with the given id in the given scope.
func (p *Plan) FindNode(scope, id string) (Node, bool) {
	for _, n := range p.Nodes {
		if n.Scope == scope && n.ID == id {
			return n, true
		}
	}
	return Node{}, false
}

// FindScope returns the scope with the given key.
func (p *Plan) FindScope(key string) (Scope, bool) {
	for _, s := range p.Scopes {
		if s.Key == key {
			return s, true
		}
	}
	return Scope{}, false
}

// Expr returns a compiled expression by id.
func (p *Plan) Expr(id string) (Expression, bool) {
	for _, e := range p.Expressions {
		if e.ID == id {
			return e, true
		}
	}
	return Expression{}, false
}
