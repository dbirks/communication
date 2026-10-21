package compiler

import (
	"strconv"

	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

type canonValue = canon.Value

// Ceilings are the assignment's limits, which a document may only ask to lower
// (contract § 2 route 18: budget_overrides may not raise a ceiling).
type Ceilings struct {
	MaxConcurrentNodes int
	MaxNodeExecutions  int
	MaxDurationSeconds int
	MaxChildDepth      int
}

// NameSet answers "does this name exist" for a project-scoped registry. The
// M4 API layer implements it over project_bindings and agent_profiles; a unit
// test implements it over a map.
type NameSet interface{ Exists(name string) bool }

// PipelineTarget resolves an invoke target to its published revision.
type PipelineTarget struct {
	Revision   int
	PlanDigest string
	ChildDepth int
}

// TemplateRevision is one pinned node-template revision the registry hands to
// the compiler (ADR-0049 § 2): the identity a plan pins, plus the content the
// composed node is built from. The digest travels so the plan can prove which
// canonical revision it was compiled against.
type TemplateRevision struct {
	Slug           string
	TemplateID     string
	RevisionID     string
	Kind           string
	Parameters     canonValue
	Config         map[string]canonValue
	OutputSchema   canonValue
	WorkspaceMode  string
	RevisionDigest string
}

// TemplateRegistry answers the compile-time questions a DB-free compiler
// cannot answer for `template: slug@semver` node references (ADR-0049 § 2).
// The store implements it over node_templates / node_template_revisions for
// the caller's organization; a unit test implements it over a map.
type TemplateRegistry interface {
	// GetActiveTemplate reports whether slug names an existing template in
	// the registry (any status — the status check rides GetTemplateRevision).
	GetActiveTemplate(slug string) bool
	// GetTemplateRevision returns the pinned revision for slug@version: an
	// unknown slug, an unknown version or a retired template all answer
	// not-found so the compiler can refuse fail-closed.
	GetTemplateRevision(slug, version string) (TemplateRevision, bool)
}

// Pipelines answers existence for an invoke target.
type Pipelines interface {
	Resolve(name string) (PipelineTarget, bool)
}

// Registries answer the questions a DB-free compiler cannot answer alone. A nil
// *Registries skips every existence check, which is what the unit tests and dev
// mode use; the API layer wires the real ones (ADR-0016's project_bindings and
// agent_profiles are the only sources of truth).
type Registries struct {
	Profiles      NameSet
	Repositories  NameSet
	PipelineRevs  Pipelines
	NodeTemplates NameSet
	// Templates resolves a pipeline node's `template: slug@semver` reference
	// (ADR-0049 § 2). Nil keeps a reference fail-closed: template_ref_unresolved.
	Templates TemplateRegistry
}

// Options configure a compile.
type Options struct {
	Budgets    *Budgets
	Registries *Registries
	// Ceilings may be nil to use the engine ceilings only.
	Ceilings *Ceilings
	// AllowDeferredKinds lets an M5/M6 build compile a deferred kind. It exists
	// so a later milestone reuses this compiler without a fork; M4 never sets it
	// (ADR-0024 § 2).
	AllowDeferredKinds bool
	// InvokeDepthCheck makes a pipeline.invoke prove its depth against
	// policies.maxChildDepth at publish. Off by default because the target
	// revision's own policies belong to the API layer that holds its plan.
	InvokeDepthCheck bool
}

// MaxAttemptsCeiling is the engine's retry ceiling (ADR-0023 § 7): a document
// asking for more is invalid rather than silently truncated at runtime.
const MaxAttemptsCeiling = 10

// MaxAttemptsCeiling is the budget's view of the same bound.
func (b Budgets) MaxAttemptsCeiling() int {
	if b.MaxAttempts == 0 {
		return MaxAttemptsCeiling
	}
	return b.MaxAttempts
}

func asStrings(v canonValue) []string {
	arr, ok := v.([]canonValue)
	if !ok {
		if s, ok := v.(string); ok {
			return []string{s}
		}
		return nil
	}
	var out []string
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func intOf(v canonValue, def int) int {
	switch t := v.(type) {
	case int64:
		return int(t)
	case int:
		return t
	case float64:
		return int(t)
	}
	return def
}

func boolOf(v canonValue, def bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return def
}

// floatOf reads a schema "number" the author may have written as an integer:
// the loader keeps integers as int64, so a bare `multiplier: 2` is not a
// float64 and asserting one silently loses the authored value.
func floatOf(v canonValue, def float64) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return def
}

// stringOr keeps the default for an absent field, so compiling an optional
// authored value never erases the default the schema did not require.
func stringOr(v canonValue, def string) (string, bool) {
	if s, ok := v.(string); ok && s != "" {
		return s, true
	}
	return def, false
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sortStrings(out)
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func scopeName(s expr.Scope) string {
	switch s {
	case expr.ScopeForEach:
		return "for_each"
	case expr.ScopeUntil:
		return "until"
	case expr.ScopeTemplate:
		return "template"
	default:
		return "pipeline"
	}
}

// locationOf assigns the execution location ADR-0023 § 3 states: only kinds
// that never need a process or a workspace run on the control plane.
func locationOf(kind string) string {
	if controlPlaneKinds[kind] {
		return LocationControlPlane
	}
	return LocationWorker
}

// PositionOf exposes the schema's binding position for a pointer, so tests and
// the API layer can ask the same question the compiler asked.
func PositionOf(doc map[string]canon.Value, at ptr.Pointer) string {
	return schema.Position(doc, at)
}

// err adds a compiler diagnostic at a document pointer.
func (w *walk) err(at ptr.Pointer, code diag.Code, format string, args ...any) {
	w.diags.Addf(diag.SourceCompiler, code, at, format, args...)
}

// ptrOf keeps a binding only when it actually needs evaluation; a pure literal
// predicate is noise in the plan.
func ptrOf(b Binding) *Binding {
	if b.IsLiteral() && b.Template == "" {
		return nil
	}
	return &b
}

// EnvDigest digests the CEL environment a plan was compiled against, so a
// runtime upgrade shows up in a plan diff instead of changing behaviour
// silently (contract § 9.1 row 19).
func EnvDigest() string {
	return canon.Digest([]byte(expr.EnvFingerprint()))
}

// cfgString reads an optional string field of a node config.
func kindOf(nv map[string]canonValue) string {
	k, _ := nv["kind"].(string)
	return k
}
