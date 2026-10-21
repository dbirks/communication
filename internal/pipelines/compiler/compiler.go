// Package compiler turns a schema-valid pipeline document into the plan a run
// executes: scopes, per-scope DAGs, node instance keys, compiled expressions,
// budget ceilings and the publish-time refusal list (ADR-0021 § 3, ADR-0022
// § 4/§ 5, ADR-0023 § 2).
//
// Planning happens once, at publish (ADR-0023 § 2): the runtime never
// recompiles, so a scheduler bug cannot disagree with the validator and a
// published graph cannot rewrite itself. Plan is therefore plain serializable
// JSON, and plan_digest is sha256 over its canonical bytes.
package compiler

import (
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// Kinds M4 executes (ADR-0024 § 1 — nine names) and the milestone that owns
// each deferred one (ADR-0024 § 2 — seven names). TestKindCatalogueMatchesSchema
// fails the build when the shipped schema's kind enum and these tables
// disagree, which is the guard ADR-0021's Consequences asks for.
var executedKinds = map[string]bool{
	"agent.acp":        true,
	"model.chat":       true,
	"process.exec":     true,
	"condition":        true,
	"human.approval":   true,
	"until":            true,
	"for_each":         true,
	"pipeline.invoke":  true,
	"artifact.publish": true,
}

// deferredKinds maps each validated-but-not-executed kind to the reason a
// validate error can quote, naming the milestone (ADR-0024 § 2: the error must
// not be folklore).
var deferredKinds = map[string]string{
	"parallel":           "planned for M5: joins need a scope-level completion rule and cancellation semantics of their own",
	"join":               "planned for M5: joins need a scope-level completion rule and cancellation semantics of their own",
	"gate":               "planned for M5: a template composition over kinds M4 executes, and the template registry is M5",
	"git.commit":         "planned for M6: publication needs action intents and probe/reconcile (contract § 7 case 6)",
	"git.publish":        "planned for M6: publication needs action intents and probe/reconcile (contract § 7 case 6)",
	"integration.query":  "planned for M6: provider contracts need trigger dedupe and webhook reconciliation",
	"integration.action": "planned for M6: provider contracts need trigger dedupe and action reconciliation",
}

// controlPlaneKinds move pending → ready → succeeded inside the advancer's
// transaction and never take a lease (ADR-0023 § 3).
var controlPlaneKinds = map[string]bool{
	"condition":       true,
	"human.approval":  true,
	"until":           true,
	"for_each":        true,
	"pipeline.invoke": true,
}

// Engine ceilings the document must not exceed (ADR-0023 § 7, contract § 6).
const (
	MaxEngineChildDepth = 2
	MinRunDurationSecs  = 60
	MaxIterationsBound  = 32
	MaxForEachItems     = 1000
	MaxForEachConc      = 20
)

// ExecutedKinds lists the nine kinds M4 runs.
func ExecutedKinds() []string { return sortedKeys(executedKinds) }

// DeferredKinds lists the seven kinds validate refuses.
func DeferredKinds() []string {
	out := make([]string, 0, len(deferredKinds))
	for k := range deferredKinds {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Compile turns a loader-and-schema-clean document into a Plan. A non-empty
// diagnostic list means the document is invalid: nothing may be stored or
// published from it (ADR-0021 § 3).
func Compile(doc loader.Document, opts Options) (*Plan, diag.List) {
	if opts.Budgets == nil {
		b := DefaultBudgets()
		opts.Budgets = &b
	}
	root := doc.Map()
	if root == nil {
		d := diag.List{}
		d.Addf(diag.SourceCompiler, diag.CodeInvalidYAML, ptr.Root, "document root is not a mapping")
		return nil, d
	}
	w := &walk{
		opts:        opts,
		budgets:     *opts.Budgets,
		doc:         root,
		declaredIDs: map[string][]string{},
		plan: &Plan{
			Version:      PlanVersion,
			DigestScope:  canon.DigestScope,
			CELVersion:   expr.CELVersion,
			Budgets:      *opts.Budgets,
			SchemaDigest: schema.Digest(),
			CELEnvDigest: EnvDigest(),
		},
	}
	w.apiVersion, _ = root["apiVersion"].(string)
	w.plan.Document = DocumentInfo{APIVersion: w.apiVersion, Kind: doc.Kind, Name: doc.Name}
	w.run(doc)
	if !w.diags.Valid() {
		return nil, w.diags
	}
	return w.plan, nil
}

// walk is the document walk. One struct holds the state so the recursion into
// bodies cannot lose a counter or a scope pointer.
type walk struct {
	opts       Options
	budgets    Budgets
	doc        map[string]canon.Value
	apiVersion string

	plan        *Plan
	diags       diag.List
	totalNodes  int
	declaredIDs map[string][]string // node id → every scope key that declares it
	inputs      *expr.SchemaNode
	exprSeq     int
	bailed      bool
}

func (w *walk) run(doc loader.Document) {
	spec, ok := w.doc["spec"].(map[string]canon.Value)
	if !ok {
		w.err(ptr.Root.Child("spec"), diag.CodeSchemaShape, "spec must be a mapping")
		return
	}
	if doc.Kind == loader.KindNodeTemplate {
		w.nodeTemplate(spec)
		return
	}
	w.plan.Inputs = spec["inputs"]
	w.plan.Outputs = spec["outputs"]
	w.inputs = expr.SchemaFromJSON(spec["inputs"])
	w.plan.Policies = w.policies(spec["policies"])

	nodesAt := ptr.Root.Child("spec").Child("nodes")
	nodes, _ := spec["nodes"].([]canon.Value)
	if len(nodes) == 0 {
		w.err(nodesAt, diag.CodeEmptyBody, "the pipeline declares no nodes")
		return
	}
	root := &scope{
		key:       "/",
		kind:      "root",
		nodes:     nodes,
		nodesAt:   nodesAt,
		path:      nil,
		suffix:    "",
		exprScope: expr.ScopePipeline,
	}
	w.scopeWalk(root)

	if rb, ok := spec["resultBindings"].(map[string]canon.Value); ok {
		w.plan.RunBindings = w.resultBindings(rb, ptr.Root.Child("spec").Child("resultBindings"), root)
	}
}

// scopeWalk compiles one DAG: identity, dependency legality, acyclicity,
// entries and terminals, then every node, then the bodies it owns.
func (w *walk) scopeWalk(s *scope) {
	// Both halves are idempotent: a composite declares its body's reference
	// table up front (the owner's predicates name body nodes) and the scope is
	// walked once afterwards.
	w.declare(s)
	w.compileScope(s)
}

// declare gives a scope its identity and its reference table. A composite's
// predicates name body nodes (until's passWhen reads nodes.test), so the table
// has to exist before the owner is compiled — a plan that cannot see its own
// children would reject the sample it came from.
func (w *walk) declare(s *scope) {
	if s.declared {
		return
	}
	s.declared = true
	s.ids = map[string]bool{}
	s.byID = map[string]map[string]canon.Value{}
	s.at = map[string]ptr.Pointer{}
	s.order = nil

	for i, raw := range s.nodes {
		nv, ok := raw.(map[string]canon.Value)
		if !ok {
			w.err(s.nodesAt.Index(i), diag.CodeSchemaShape, "node must be a mapping")
			continue
		}
		id, _ := nv["id"].(string)
		at := s.nodesAt.Index(i)
		if id == "" {
			w.err(at, diag.CodeSchemaShape, "node needs an id")
			continue
		}
		if expr.IsReservedIdentifier(id) || id == "_" {
			// `nodes.loop` would compile and `loop` as a root never would, so
			// the name is refused outright rather than left as a trap
			// (ADR-0022 § 2).
			w.err(at.Child("id"), diag.CodeReservedNodeID,
				"node id %q is a reserved identifier in the CEL parser: rename it (ADR-0022 § 2)", id)
			w.diags.Addf(diag.SourceCompiler, diag.CodeReservedNodeID, at.Child("kind"),
				"(the node's kind is %q, so this is a naming problem, not a modelling one)", kindOf(nv))
		}
		if s.ids[id] {
			w.err(at.Child("id"), diag.CodeDuplicateNodeID,
				"node id %q is declared twice in scope %q", id, s.key)
			continue
		}
		s.ids[id] = true
		s.byID[id] = nv
		s.at[id] = at
		s.order = append(s.order, id)
		w.declaredIDs[id] = append(w.declaredIDs[id], s.key)
		w.totalNodes++
	}
	// The reference table exists before any binding is compiled: an expression
	// may read any declared node in its own scope, including one that appears
	// later in the list (ADR-0022 § 2's invariant 6 check).
	s.schemas = map[string]*expr.SchemaNode{}
	s.engine = map[string][]string{}
	for _, id := range s.order {
		s.schemas[id] = expr.SchemaFromJSON(s.byID[id]["outputs"])
		switch s.byID[id]["kind"] {
		case "until":
			s.engine[id] = []string{"iterations"}
		case "for_each":
			s.engine[id] = []string{"children", "items"}
		}
	}
	if w.totalNodes > w.budgets.MaxTotalNodes {
		w.err(s.nodesAt, diag.CodeGraphTooLarge,
			"the document declares %d nodes in total; the limit is %d", w.totalNodes, w.budgets.MaxTotalNodes)
		return
	}
	if len(s.order) > w.budgets.MaxNodesPerScope {
		w.err(s.nodesAt, diag.CodeGraphTooLarge,
			"scope %q declares %d nodes; the limit is %d", s.key, len(s.order), w.budgets.MaxNodesPerScope)
		return
	}

	if len(s.order) == 0 {
		w.err(s.nodesAt, diag.CodeEmptyBody, "scope %q declares no nodes", s.key)
		return
	}

}

// compileScope enforces topology, compiles every node and records the scope.
func (w *walk) compileScope(s *scope) {
	if s.compiled || !s.declared || len(s.order) == 0 {
		return
	}
	s.compiled = true
	w.dependencies(s)
	entries, terminals, cyclic := w.dag(s)
	if cyclic || w.bailed {
		return
	}
	s.entry, s.terminals = entries, terminals

	for _, id := range s.order {
		w.node(s, id)
	}
	w.checkRoutes(s)

	w.plan.Scopes = append(w.plan.Scopes, Scope{
		Key:                s.key,
		Kind:               s.kind,
		Owner:              s.owner,
		Parent:             s.parent,
		EntryNodes:         entries,
		TerminalNodes:      terminals,
		TopologicalOrder:   topoOrder(s),
		ExpressionScope:    scopeName(s.exprScope),
		MaxIterations:      s.maxIterations,
		MaxDurationSeconds: s.maxDuration,
		MaxConcurrency:     s.maxConcurrency,
		OnChildFailure:     s.onChildFailure,
		IndexedSegments:    s.indexed,
	})
}

// dependencies checks dependsOn existence, self-reference and scope. JSON
// Schema cannot compare array items, which is why these are compiler codes
// (ADR-0021 § 3, measured by the spike).
func (w *walk) dependencies(s *scope) {
	for _, id := range s.order {
		for _, target := range asStrings(s.byID[id]["dependsOn"]) {
			at := s.at[id].Child("dependsOn")
			switch {
			case target == id:
				w.err(at, diag.CodeSelfDependency, "node %q depends on itself", id)
			case s.ids[target]:
				// legal
			case len(w.declaredIDs[target]) > 0:
				w.err(at, diag.CodeDependsOutsideScope,
					"node %q depends on %q, which is declared in scope %q and not in %q: a scope's graph only sees its own nodes (ADR-0021 § 3)",
					id, target, strings.Join(w.declaredIDs[target], ", "), s.key)
			default:
				w.err(at, diag.CodeUnknownDependency,
					"node %q depends on %q, which is not declared", id, target)
			}
		}
	}
}

// node compiles one node: executability, policy, bindings, and the body scope
// a composite owns.
func (w *walk) node(s *scope, id string) {
	nv := s.byID[id]
	at := s.at[id]
	kind, _ := nv["kind"].(string)

	if reason, deferred := deferredKinds[kind]; deferred {
		if !w.opts.AllowDeferredKinds {
			// ADR-0024 § 2: the draft is invalid here, not "valid but broken at
			// runtime". The message names the milestone, which is the point of
			// a validate-time refusal.
			w.err(at.Child("kind"), diag.CodeKindNotImplemented,
				"kind %q is validated but not executed by this build: %s", kind, reason)
		}
	} else if !executedKinds[kind] {
		w.err(at.Child("kind"), diag.CodeKindNotImplemented,
			"kind %q is not in the v1alpha1 catalogue", kind)
	}

	pn := Node{
		ID:            id,
		Kind:          kind,
		Scope:         s.key,
		Path:          append(append([]string{}, s.path...), id),
		InstanceKey:   instanceKey(s.path, s.suffix, id),
		ExecLocation:  locationOf(kind),
		DependsOn:     dedupe(asStrings(nv["dependsOn"])),
		Outputs:       nv["outputs"],
		EngineOutputs: s.engine[id],
	}
	pn.Indexed = append([]string{}, s.indexed...)
	if s.kind != "root" {
		pn.Indexed = append(pn.Indexed, s.owner)
	}
	if ts := intOf(nv["timeoutSeconds"], 0); ts > 0 {
		pn.TimeoutSeconds = ts
	}
	pn.Retry = w.retry(nv, at)
	pn.Failure = w.failure(s, id, nv, at)

	if when, ok := nv["when"].(string); ok {
		b := w.binding(when, at.Child("when"), s, schema.PositionExpression)
		pn.When = &b
	}

	// A composite's predicates are evaluated over the body's envelope, so they
	// compile in the child scope; every other config field is the parent's.
	cfg, _ := nv["config"].(map[string]canon.Value)
	body := cfg // what the policy and composite checks read
	var tmplRev TemplateRevision
	hasTmplRef := false
	// ADR-0049 § 2: a `template: slug@semver` member turns the node into a pin
	// of the template revision's parameterized body. The canonical document
	// keeps the reference string as written; only the plan gains the
	// expansion (templateRefs + templateParams), so a template's content
	// change cannot move this revision's digest (ADR-0021).
	if ref, ok := nv["template"].(string); ok && ref != "" {
		if compositeNodeKinds[kind] {
			w.err(at.Child("template"), diag.CodeTemplateRefUnresolved,
				"node %q references a template, but a %s body cannot be composed through parameters yet", id, kind)
		} else if rev, found := w.resolveTemplateRef(id, ref, kind, cfg, at); found {
			hasTmplRef = true
			tmplRev = rev
			body = rev.Config
			pn.TemplateRefs = []TemplateRef{{
				TemplateID:             rev.TemplateID,
				TemplateRevisionID:     rev.RevisionID,
				TemplateRevisionDigest: rev.RevisionDigest,
			}}
			pn.TemplateParams = cfg
			// The revision's output schema is the node's contract.
			pn.Outputs = rev.OutputSchema
		}
	}
	child := w.compositeChild(s, id, kind, body, at)
	if child != nil {
		pn.SubScope = child.key
		// A for_each scope ends when every index key is terminal (ADR-0023 § 8);
		// only an `until` judges its body with predicates, because passWhen/failWhen
		// exist in configUntil and nowhere else in the catalogue (contract § 9.2).
		// Reading them for every composite compiled an empty expression for each
		// for_each body, which the parser refused as a syntax error — a legal
		// fan-out could not be published at all.
		if kind == "until" {
			if pw, has := cfg["passWhen"]; has {
				pn.PassWhen = ptrOf(w.binding(pw, at.Child("config").Child("passWhen"), child, schema.PositionExpression))
			}
			if fs, has := cfg["failWhen"]; has {
				b := w.binding(fs, at.Child("config").Child("failWhen"), child, schema.PositionExpression)
				pn.FailWhen = &b
			}
		} else {
			for _, name := range []string{"passWhen", "failWhen"} {
				if _, has := cfg[name]; has {
					w.err(at.Child("config").Child(name), diag.CodeUnsupportedPolicy,
						"%s %q has no %s: only an until judges its body with a predicate, and a %s scope ends when every child key is terminal (ADR-0023 § 8)", kind, id, name, kind)
				}
			}
		}
		if rb, ok := cfg["resultBindings"].(map[string]canon.Value); ok {
			pn.ResultBindings = w.resultBindings(rb, at.Child("config").Child("resultBindings"), child)
		}
	}
	if hasTmplRef {
		// The body's bindings compile in the template-scope environment (the
		// parameters are the declared roots); the node's config is the values.
		pn.ConfigBindings = w.templateBodyBindings(tmplRev, at.Child("config"), kind)
		// Secret literals in the parameter values are refused exactly as in an
		// inline node's config (ADR-0049 § 2.3/Security).
		w.secretLiterals(s, id, cfg, at.Child("config"), &pn)
	} else {
		pn.ConfigBindings = w.configValues(cfg, at.Child("config"), s, kind)
	}
	w.kindPolicy(s, id, kind, body, at, &pn)

	w.plan.Nodes = append(w.plan.Nodes, pn)
	if child != nil && !w.bailed {
		w.scopeWalk(child)
	}
}

// compositeChild builds the body scope an until/for_each/parallel owns, with
// the roots its expressions may use.
func (w *walk) compositeChild(s *scope, id, kind string, cfg map[string]canon.Value, at ptr.Pointer) *scope {
	var bodyNodes []canon.Value
	bodyAt := at.Child("config")
	switch kind {
	case "until", "for_each":
		body, _ := cfg["body"].(map[string]canon.Value)
		bodyNodes, _ = body["nodes"].([]canon.Value)
		bodyAt = bodyAt.Child("body").Child("nodes")
	default:
		return nil
	}
	if len(bodyNodes) == 0 {
		w.err(bodyAt, diag.CodeEmptyBody,
			"node %q has an empty body: a composite with no nodes can never reach a terminal outcome", id)
		return nil
	}
	child := &scope{
		key:       s.key + id + "/",
		parent:    s.key,
		owner:     id,
		kind:      kind,
		nodes:     bodyNodes,
		nodesAt:   bodyAt,
		path:      append(append([]string{}, s.path...), id),
		exprScope: expr.ScopeUntil,
		indexed:   append(append([]string{}, s.indexed...), id),
		// ADR-0023 § 1: a plan stores the canonical suffix and lists the
		// segments a run indexes, so /build_until_verified[2]/review is derived
		// rather than invented.
		suffix: "[1]",
	}
	if kind == "for_each" {
		child.exprScope = expr.ScopeForEach
		child.suffix = "[0]"
	}
	if mi := intOf(cfg["maxIterations"], 0); mi > 0 {
		child.maxIterations = mi
	}
	if md := intOf(cfg["maxDurationSeconds"], 0); md > 0 {
		child.maxDuration = md
	}
	if mc := intOf(cfg["maxConcurrency"], 0); mc > 0 {
		child.maxConcurrency = mc
	}
	if ocf, ok := cfg["onChildFailure"].(string); ok {
		child.onChildFailure = ocf
	}
	if rb, ok := cfg["resultBindings"].(map[string]canon.Value); ok {
		// The loop's `previous` root is exactly these names (ADR-0023 § 8): a
		// prior-iteration read of any other key can never resolve.
		child.prevKeys = sortedKeysValue(rb)
	}
	// The body's identity and reference table are built here rather than in
	// scopeWalk, because the owner's passWhen / failWhen / resultBindings name
	// body nodes: a composite whose predicates compile before its own children
	// are declared rejects the very sample this contract was written from.
	w.declare(child)
	return child
}

// instanceKey builds ADR-0023 § 1's text path. A plan stores the key with a
// canonical suffix (iteration 1 / index 0) and lists which segments receive a
// runtime [i], so a run materialises /build_until_verified[2]/review without
// ever inventing a new spelling.
func instanceKey(path []string, suffix, id string) string {
	var b strings.Builder
	for _, seg := range path {
		b.WriteString("/" + seg + suffix)
	}
	b.WriteString("/" + id)
	return b.String()
}
