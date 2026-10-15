package compiler

import (
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// policies compiles spec.policies and applies both ceilings: the engine's
// (ADR-0023 § 7, so a document cannot validate at publish and prove
// unschedulable at run time) and the assignment's (contract § 2 route 18,
// budget_overrides may only *lower* a limit).
func (w *walk) policies(v canonValue) Policies {
	p := Policies{
		MaxConcurrentNodes: 1,
		MaxNodeExecutions:  100,
		MaxChildDepth:      0,
		CancelPolicy:       "cascade",
	}
	at := ptr.Root.Child("spec").Child("policies")
	if m, ok := v.(map[string]canonValue); ok {
		p.MaxConcurrentNodes = intOf(m["maxConcurrentNodes"], p.MaxConcurrentNodes)
		p.MaxDurationSeconds = intOf(m["maxDurationSeconds"], p.MaxDurationSeconds)
		p.MaxNodeExecutions = intOf(m["maxNodeExecutions"], p.MaxNodeExecutions)
		p.MaxChildDepth = intOf(m["maxChildDepth"], p.MaxChildDepth)
		p.WorkspaceMode, _ = m["workspaceMode"].(string)
		if cp, ok := m["cancelPolicy"].(string); ok {
			p.CancelPolicy = cp
		}
		if _, has := m["cancelPolicy"]; has && cp0(p) == "detach" {
			// ADR-0024 § 3 keeps detach unimplemented; ADR-0023 § 10 says it is
			// an explicit choice, not something the engine decides. Publishing a
			// run that would cancel differently from what it promised is the
			// honest failure mode M4 refuses.
			w.err(at.Child("cancelPolicy"), diag.CodeUnsupportedPolicy,
				"cancelPolicy: detach is not implemented in this build: cancellation is always a cascade (ADR-0023 § 10, ADR-0024 § 3)")
		}
	}
	if p.MaxChildDepth > MaxEngineChildDepth {
		// runs.depth carries CHECK 0..2 (ADR-0023 § 7): a deeper request cannot
		// be stored, so it cannot be published.
		w.err(at.Child("maxChildDepth"), diag.CodeChildDepthExceeded,
			"policies.maxChildDepth %d exceeds the engine ceiling %d (ADR-0023 § 7; runs.depth carries CHECK 0..2)", p.MaxChildDepth, MaxEngineChildDepth)
		p.MaxChildDepth = MaxEngineChildDepth
	}
	if p.MaxDurationSeconds != 0 && p.MaxDurationSeconds < MinRunDurationSecs {
		w.err(at.Child("maxDurationSeconds"), diag.CodeBudgetBelowMinimum,
			"policies.maxDurationSeconds %d is below the engine minimum %d (contract § 6)", p.MaxDurationSeconds, MinRunDurationSecs)
	}
	if w.opts.Ceilings != nil {
		w.clampPolicies(at, &p)
	}
	return p
}

func cp0(p Policies) string { return p.CancelPolicy }

// clampPolicies applies the assignment ceilings, reporting every clamp.
func (w *walk) clampPolicies(at ptr.Pointer, p *Policies) {
	cl := w.opts.Ceilings
	if cl.MaxConcurrentNodes > 0 && p.MaxConcurrentNodes > cl.MaxConcurrentNodes {
		w.err(at.Child("maxConcurrentNodes"), diag.CodeBudgetAboveCeiling,
			"maxConcurrentNodes %d exceeds the assignment ceiling %d: budget_overrides may only lower a limit (contract § 2 route 18)", p.MaxConcurrentNodes, cl.MaxConcurrentNodes)
		p.MaxConcurrentNodes = cl.MaxConcurrentNodes
	}
	if cl.MaxNodeExecutions > 0 && p.MaxNodeExecutions > cl.MaxNodeExecutions {
		w.err(at.Child("maxNodeExecutions"), diag.CodeBudgetAboveCeiling,
			"maxNodeExecutions %d exceeds the assignment ceiling %d", p.MaxNodeExecutions, cl.MaxNodeExecutions)
		p.MaxNodeExecutions = cl.MaxNodeExecutions
	}
	if cl.MaxDurationSeconds > 0 && p.MaxDurationSeconds > cl.MaxDurationSeconds {
		w.err(at.Child("maxDurationSeconds"), diag.CodeBudgetAboveCeiling,
			"maxDurationSeconds %d exceeds the assignment ceiling %d", p.MaxDurationSeconds, cl.MaxDurationSeconds)
		p.MaxDurationSeconds = cl.MaxDurationSeconds
	}
	if cl.MaxChildDepth >= 0 && p.MaxChildDepth > cl.MaxChildDepth {
		w.err(at.Child("maxChildDepth"), diag.CodeBudgetAboveCeiling,
			"maxChildDepth %d exceeds the assignment ceiling %d", p.MaxChildDepth, cl.MaxChildDepth)
		p.MaxChildDepth = cl.MaxChildDepth
	}
}

// retry compiles a node's retryPolicy.
func (w *walk) retry(nv map[string]canonValue, at ptr.Pointer) Retry {
	r := Retry{MaxAttempts: 1, Jitter: true, WorkspacePolicy: "reuse_or_recreate"}
	cfg, ok := nv["retryPolicy"].(map[string]canonValue)
	if !ok {
		return r
	}
	at = at.Child("retryPolicy")
	r.MaxAttempts = intOf(cfg["maxAttempts"], 1)
	r.BaseSeconds = intOf(cfg["baseSeconds"], 30)
	if m, ok := cfg["multiplier"].(float64); ok {
		r.Multiplier = m
	} else {
		r.Multiplier = 2
	}
	r.MaxSeconds = intOf(cfg["maxSeconds"], 0)
	if j, ok := cfg["jitter"].(bool); ok {
		r.Jitter = j
	}
	r.WorkspacePolicy, _ = cfg["workspacePolicy"].(string)
	r.RetriableErrors = asStrings(cfg["retriableErrors"])
	if r.MaxAttempts > w.budgets.MaxAttemptsCeiling() {
		w.err(at.Child("maxAttempts"), diag.CodeBudgetAboveCeiling,
			"maxAttempts %d exceeds the ceiling %d", r.MaxAttempts, w.budgets.MaxAttemptsCeiling())
		r.MaxAttempts = w.budgets.MaxAttemptsCeiling()
	}
	// ADR-0023 § 7: workspace_lost never auto-retries, so admitting it into a
	// retriableErrors list would promise a retry that cannot happen. The schema
	// admits the name because a future milestone owns it; the compiler refuses
	// it while the worker cannot honour it.
	for _, code := range r.RetriableErrors {
		if code == "workspace_lost" {
			w.err(at.Child("retriableErrors"), diag.CodeUnsupportedPolicy,
				"retriableErrors may not list workspace_lost: a lost workspace is never retried automatically (ADR-0023 § 7)")
		}
	}
	return r
}

// failure compiles 03's failure table for one node. Deviation D6: the error
// route is a readiness exception, not a graph edge, which is what keeps the DAG
// free of route-typed edges (ADR-0021 § 6).
func (w *walk) failure(s *scope, id string, nv map[string]canonValue, at ptr.Pointer) FailurePolicy {
	f := FailurePolicy{OnExecutionError: "stop"}
	cfg, ok := nv["failurePolicy"].(map[string]canonValue)
	if !ok {
		return f
	}
	at = at.Child("failurePolicy")
	f.ErrorRoute, _ = cfg["errorRoute"].(string)
	f.OnExecutionError, _ = cfg["onExecutionError"].(string)
	if f.OnExecutionError == "" {
		f.OnExecutionError = "stop"
	}
	if f.OnExecutionError == "route" {
		if f.ErrorRoute == "" {
			// 03's failure table is validated, not interpreted (contract § 5.1
			// step 5): "route" with no errorRoute is a compiler error.
			w.err(at.Child("onExecutionError"), diag.CodeUnknownDependency,
				"node %q sets onExecutionError: route but names no errorRoute", id)
			return f
		}
		if f.ErrorRoute == "stop" || f.ErrorRoute == "continue" {
			w.err(at.Child("errorRoute"), diag.CodeUnknownDependency,
				"node %q sets errorRoute: %q, which is an outcome name, not a node id in scope %q", id, f.ErrorRoute, s.key)
			return f
		}
		if !s.ids[f.ErrorRoute] {
			if where := w.declaredIDs[f.ErrorRoute]; len(where) > 0 {
				w.err(at.Child("errorRoute"), diag.CodeUnknownDependency,
					"node %q sets errorRoute: %q, declared in scope %s and not visible in scope %q", id, f.ErrorRoute, strings.Join(where, ", "), s.key)
			} else {
				w.err(at.Child("errorRoute"), diag.CodeUnknownDependency,
					"node %q sets errorRoute: %q, which is not a node in scope %q", id, f.ErrorRoute, s.key)
			}
			return f
		}
	}
	return f
}

// kindPolicy applies what only the compiler can state about a node's config:
// executability, registry existence, secret shape, and the deferred-behaviour
// refusals ADR-0024 § 3 lists.
func (w *walk) kindPolicy(s *scope, id, kind string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	if cfg == nil {
		return
	}
	cfgAt := at.Child("config")

	// Secret literals anywhere in config text are an error, not a warning
	// (ADR-0021 § 3 invariant 5, ADR-0022 § 3: interpolation may not join a
	// secret into text).
	w.secretLiterals(s, id, cfg, cfgAt, pn)

	switch kind {
	case "agent.acp":
		w.agentPolicy(s, id, cfg, cfgAt, pn)
	case "process.exec":
		w.execPolicy(s, id, cfg, cfgAt, pn)
	case "model.chat":
		w.chatPolicy(s, id, cfg, cfgAt)
	case "human.approval":
		w.approvalPolicy(s, id, cfg, cfgAt)
	case "pipeline.invoke":
		w.invokePolicy(s, id, cfg, cfgAt, pn)
	case "artifact.publish":
		w.publishPolicy(s, id, cfg, cfgAt)
	case "condition":
		w.conditionPolicy(s, id, cfg, cfgAt)
	case "until":
		w.untilPolicy(s, id, cfg, cfgAt, pn)
	case "for_each":
		w.forEachPolicy(s, id, cfg, cfgAt, pn)
	}
}

// agentPolicy refuses what M4 cannot execute for an ACP node (ADR-0024 § 3).
func (w *walk) agentPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	pn.Profile, _ = cfg["profile"].(string)
	if mode, _ := cfg["sessionMode"].(string); mode == "continue_live" {
		// ADR-0024 § 3: the enum keeps the name for a later milestone; the
		// bridge cannot hold a live session across a node boundary yet.
		w.err(at.Child("sessionMode"), diag.CodeUnsupportedSessionMode,
			"sessionMode: continue_live is not implemented in this build: a node may start a session or resume a stored one (ADR-0024 § 3)")
	}
	if pn.Profile != "" {
		if r := w.opts.Registries; r != nil && r.Profiles != nil && !r.Profiles.Exists(pn.Profile) {
			w.err(at.Child("profile"), diag.CodeUnknownProfile,
				"agent profile %q is not defined for the project (ADR-0016's agent_profiles is name-scoped; @revision suffixes are not a thing, so an unknown name is this error)", pn.Profile)
		}
	}
	if ws, ok := cfg["workspace"].(map[string]canonValue); ok {
		pn.Workspace = &Workspace{}
		pn.Workspace.Mode, _ = ws["mode"].(string)
		if repos, ok := ws["repositories"].([]canonValue); ok {
			for _, rv := range repos {
				b := w.binding(rv, at.Child("workspace").Child("repositories").Child(itoa(0)), s, schema.PositionValue)
				pn.Workspace.Repositories = append(pn.Workspace.Repositories, b)
			}
		}
	}
}

// execPolicy checks placement without a `workspace` CEL root: repositories are
// declared in the config, never referenced from an expression (contract § 9.1
// row 9).
func (w *walk) execPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	if _, has := cfg["cwd"]; has {
		// cwd is a relativePath in the schema, so a ${{ … }} there is already a
		// schema_shape failure; here we only catch an author who tried to name
		// a repository through it.
		if str, ok := cfg["cwd"].(string); ok && strings.Contains(str, "${{") {
			w.err(at.Child("cwd"), diag.CodeBindingPosition,
				"workspace.repo.root is not a root: a node declares repositories in config.workspace and the worker resolves them (contract § 9.1 row 9)")
		}
	}
	if ws, ok := cfg["workspace"].(map[string]canonValue); ok {
		pn.Workspace = &Workspace{}
		pn.Workspace.Mode, _ = ws["mode"].(string)
		repos := asStrings(ws["repositories"])
		for _, repo := range repos {
			if strings.Contains(repo, "${{") {
				continue // expression: unresolvable at publish without a run
			}
			if r := w.opts.Registries; r != nil && r.Repositories != nil && !r.Repositories.Exists(repo) {
				w.err(at.Child("workspace").Child("repositories"), diag.CodeUnknownRepository,
					"repository %q is not bound to this project (07 § repositories are project bindings)", repo)
			}
		}
	}
}

func (w *walk) chatPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer) {
	if _, ok := cfg["responseSchema"]; ok {
		// The response schema is an embedded JSON Schema, not a binding; the
		// worker validates the model's answer against it at execution.
		_ = schema.Digest()
	}
}

func (w *walk) approvalPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer) {
	roles := asStrings(cfg["approverRoles"])
	users := asStrings(cfg["approverUserIds"])
	if len(roles) == 0 && len(users) == 0 {
		w.err(at, diag.CodeSchemaShape,
			"human.approval %q names no approverRoles or approverUserIds: nobody could ever decide it", id)
	}
}

// invokePolicy enforces the recursion rule at publish time: a definition that
// could exceed the depth ceiling is invalid, and self-invocation is the
// degenerate case (ADR-0023 § 10).
func (w *walk) invokePolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	target, _ := cfg["pipeline"].(string)
	if w.opts.InvokeDepthCheck {
		depth := len(s.path) + 1
		if w.plan.Policies.MaxChildDepth < depth {
			w.err(at.Child("pipeline"), diag.CodeChildDepthExceeded,
				"this invoke would create a run at depth %d but policies.maxChildDepth is %d (ADR-0023 § 7)", depth, w.plan.Policies.MaxChildDepth)
		}
	}
	if mode, _ := cfg["waitFor"].(string); mode == "started" {
		// ADR-0023 § 10: detach waits for no outcome, so a `started` promise
		// cannot be kept by this build's advancer.
		w.err(at.Child("waitFor"), diag.CodeUnsupportedPolicy,
			"waitFor: started is not implemented in this build: an invoke waits for the child's terminal outcome (ADR-0023 § 10)")
	}
	if rp, _ := cfg["revisionPolicy"].(string); rp == "pinned_digest" {
		if _, ok := cfg["pinnedRevision"]; !ok {
			w.err(at.Child("revisionPolicy"), diag.CodeSchemaShape,
				"revisionPolicy: pinned_digest requires pinnedRevision (ADR-0023 § 10: every run pins the exact revision it executes)")
		}
	}
	if r := w.opts.Registries; r != nil && r.PipelineRevs != nil && target != "" && !strings.Contains(target, "${{") {
		if _, ok := r.PipelineRevs.Resolve(target); !ok {
			// No separate code exists for this in contract § 2's registry list,
			// so the taxonomy reuses unknown_dependency and says why.
			w.err(at.Child("pipeline"), diag.CodeUnknownDependency,
				"invoke target %q is not a published pipeline of this project (unknown_dependency is the registry's only reference code)", target)
		}
	}
}

func (w *walk) publishPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer) {
	if from, ok := cfg["from"].(map[string]canonValue); ok {
		if p, _ := from["path"].(string); p != "" && !strings.HasPrefix(p, "artifacts/") {
			w.err(at.Child("from").Child("path"), diag.CodeSchemaShape,
				"artifact.publish from.path is relative to the workspace, which M4 stages under the run's worktree")
		}
	}
}

func (w *walk) conditionPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer) {
	seen := map[string]ptr.Pointer{}
	for i, cs := range asListOfMaps(cfg["cases"]) {
		r, _ := cs["route"].(string)
		rAt := at.Child("cases").Index(i).Child("route")
		if r == "" {
			continue
		}
		if pass := routePasses(r); pass {
			// pass/fail are the engine's own outcome names; reusing them for a
			// business route would make outputs.route ambiguous (01's
			// business-vs-execution split, restated in ADR-0023 § 8).
			w.err(rAt, diag.CodeUnsupportedPolicy,
				"condition route %q collides with an engine outcome name (ADR-0023 § 8)", r)
		}
		if prev, dup := seen[r]; dup {
			w.err(rAt, diag.CodeDuplicateKey,
				"condition %q declares route %q twice (first at %s)", id, r, prev.String())
		}
		seen[r] = rAt
	}
	if d, _ := cfg["default"].(string); d != "" && routePasses(d) {
		w.err(at.Child("default"), diag.CodeUnsupportedPolicy,
			"condition default route %q collides with an engine outcome name (ADR-0023 § 8)", d)
	}
}

func (w *walk) untilPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	mi := intOf(cfg["maxIterations"], 0)
	if mi == 0 {
		// The schema requires maxIterations, so this is the defensive arm.
		w.err(at.Child("maxIterations"), diag.CodeSchemaShape,
			"until %q must carry an explicit iteration bound (ADR-0023 § 8: loops are bounded)", id)
		return
	}
	if mi > MaxIterationsBound {
		w.err(at.Child("maxIterations"), diag.CodeBudgetAboveCeiling,
			"maxIterations %d exceeds the engine ceiling %d (contract § 6)", mi, MaxIterationsBound)
	}
	if md := intOf(cfg["maxDurationSeconds"], 0); md != 0 && md < MinRunDurationSecs {
		w.err(at.Child("maxDurationSeconds"), diag.CodeBudgetBelowMinimum,
			"maxDurationSeconds %d is below the engine minimum %d (contract § 6)", md, MinRunDurationSecs)
	}
	if _, ok := cfg["failWhen"]; ok && pn.FailWhen == nil {
		w.err(at.Child("failWhen"), diag.CodeCELCompile, "failWhen is not a compiled expression")
	}
}

func (w *walk) forEachPolicy(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	if mc := intOf(cfg["maxConcurrency"], 0); mc > MaxForEachConc {
		w.err(at.Child("maxConcurrency"), diag.CodeBudgetAboveCeiling,
			"maxConcurrency %d exceeds the engine ceiling %d (ADR-0023 § 7: fan-out is always bounded)", mc, MaxForEachConc)
	}
	if ocf, _ := cfg["onChildFailure"].(string); ocf == "ignore_others" {
		w.err(at.Child("onChildFailure"), diag.CodeUnsupportedPolicy,
			"onChildFailure: ignore_others is not implemented in this build (ADR-0023 § 9: one child failing fails the scope)")
	}
	if from, ok := cfg["from"].(map[string]canonValue); ok {
		if p, _ := from["path"].(string); p != "" {
			if err := w.checkJSONPointer(p); err != nil {
				w.err(at.Child("from").Child("path"), diag.CodeCELCompile,
					"from.path is not a resolvable pointer: %v (ADR-0023 § 9: the item source is resolved at publish)", err)
			}
		}
	}
	if arr, ok := cfg["items"].([]canonValue); ok && len(arr) > w.budgets.MaxItemsPerForEach {
		w.err(at.Child("items"), diag.CodeGraphTooLarge,
			"items carries %d literal entries; the limit is %d (contract § 6)", len(arr), w.budgets.MaxItemsPerForEach)
	}
}

// checkJSONPointer proves a from.path names a location in the source the
// document declares.
func (w *walk) checkJSONPointer(p string) error {
	if p == "" || p[0] != '/' {
		return &pointerError{"must be an RFC 6901 pointer starting with /"}
	}
	for _, seg := range strings.Split(strings.TrimPrefix(p, "/"), "/") {
		if seg == "" {
			return &pointerError{"empty segment"}
		}
	}
	return nil
}

type pointerError struct{ msg string }

func (e *pointerError) Error() string { return e.msg }

// secretLiterals implements ADR-0021 § 3's invariant 5 and ADR-0022 § 3: a
// secret is referenced, never written. Text that embeds ${{ secrets.x }} cannot
// be logged and is refused; a {expr: "secrets.foo"} value is a valid reference
// and a bare high-entropy string in a secret-shaped field is a warning the
// compiler cannot prove, so it is not invented here.
func (w *walk) secretLiterals(s *scope, id string, cfg map[string]canonValue, at ptr.Pointer, pn *Node) {
	var walk func(v canonValue, p ptr.Pointer)
	walk = func(v canonValue, p ptr.Pointer) {
		switch t := v.(type) {
		case map[string]canonValue:
			for k, sub := range t {
				walk(sub, p.Child(k))
			}
			if e, ok := t["expr"].(string); ok {
				for _, ref := range secretRefs(e) {
					pn.SecretRefs = append(pn.SecretRefs, ref)
					if !validSecretRef(ref) {
						w.err(p.Child("expr"), diag.CodeInvalidSecretRef,
							"secret reference %q is not a valid path (ADR-0022 § 3: secrets are referenced, never interpolated into text)", ref)
					}
				}
			}
		case []canonValue:
			for i, sub := range t {
				walk(sub, p.Index(i))
			}
		case string:
			// bindingText may not contain a secrets.* reference at all: a
			// joined secret would land in a prompt, an event or a log line.
			for _, ref := range secretRefs(t) {
				if schema.Position(w.doc, ptr.Pointer(p)) == schema.PositionText {
					w.err(p, diag.CodeSecretLiteral,
						"secrets.%s appears in binding text: interpolation may not join a secret into a string (ADR-0022 § 3). The worker exposes it to the process environment instead", ref)
				}
				pn.SecretRefs = append(pn.SecretRefs, ref)
			}
			if looksLikeSecretAssignment(t) {
				w.err(p, diag.CodeSecretLiteral,
					"a literal assignment to a secret-shaped value was detected in node %q; reference it with {expr: \"secrets.NAME\"} instead (ADR-0021 § 3 invariant 5)", id)
			}
		}
	}
	for k, v := range cfg {
		if k == "body" || k == "resultBindings" {
			continue
		}
		walk(v, at.Child(k))
	}
	sort.Strings(pn.SecretRefs)
	pn.SecretRefs = dedupe(pn.SecretRefs)
}

// secretRefs extracts secrets.<name> reads from expression source text without
// parsing it (the parser already rejected any secrets.* use in a text position;
// this is the audit for value positions).
func secretRefs(src string) []string {
	var out []string
	for _, word := range strings.FieldsFunc(src, func(r rune) bool {
		return !(r == '.' || r == '_' || r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) {
		if strings.HasPrefix(word, "secrets.") {
			out = append(out, strings.TrimRight(word, "'\"()"))
		}
	}
	return out
}

func validSecretRef(ref string) bool {
	name := strings.TrimPrefix(ref, "secrets.")
	if name == "" || name == ref {
		return false
	}
	for i, r := range name {
		ok := r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && r >= '0' && r <= '9'
		if !ok {
			return false
		}
	}
	return true
}

// looksLikeSecretAssignment is deliberately narrow: `KEY=value` inside a single
// scalar is the shape an author reaches for when they mean an environment
// secret. A heuristic wider than this becomes a false-positive engine.
func looksLikeSecretAssignment(s string) bool {
	if !strings.Contains(s, "${{") {
		return false
	}
	i := strings.IndexAny(s, "= ")
	if i <= 0 {
		return false
	}
	head := strings.ToLower(s[:i])
	for _, k := range []string{"token", "secret", "password", "api_key", "apikey", "key"} {
		if strings.HasSuffix(head, k) {
			return true
		}
	}
	return false
}

func routePasses(r string) bool {
	switch r {
	case "pass", "fail", "error", "skipped":
		return true
	}
	return false
}

func sortedKeysValue(m map[string]canonValue) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
