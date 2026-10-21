package compiler

import (
	"encoding/json"
	"errors"
	"regexp"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/ptr"
)

// ADR-0049 § 2: resolving a pipeline node's `template: slug@semver`
// reference against the registry, fail-closed. The canonical document keeps
// the reference string as written — the expansion never touches it — so a
// template's content change cannot move a pipeline revision's digest
// (ADR-0021's semantics are untouched).

var (
	tmplRefSlugPattern    = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,127}$`)
	tmplRefVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// compositeNodeKinds own a body (config.body.nodes) that parameter
// composition cannot carry: the ADR-0049 § 2 expansion composes the template
// body's config bindings over the node's parameter values, and a body DAG of
// its own would need the same walk twice. A template reference on these
// kinds is a diagnostic, not a silent behaviour change.
var compositeNodeKinds = map[string]bool{"until": true, "for_each": true}

// splitTemplateRef parses `slug@semver` the schema pattern promises, and
// re-checks it here so a compile without schema validation (dev mode, tests)
// refuses a malformed reference fail-closed too.
func splitTemplateRef(ref string) (slug, version string, ok bool) {
	for i := len(ref) - 1; i >= 0; i-- {
		if ref[i] == '@' {
			slug, version = ref[:i], ref[i+1:]
			return slug, version, tmplRefSlugPattern.MatchString(slug) && tmplRefVersionPattern.MatchString(version)
		}
	}
	return "", "", false
}

// resolveTemplateRef handles one node's `template` member (ADR-0049 § 2.2):
// the reference must name an active revision of the caller's org, the node's
// kind must equal the revision's kind (spec.implements), and the node's
// config (the parameter values) must satisfy the revision's parameters
// schema. Every miss is a diagnostic — validate answers, no 500.
//
// On success it returns the pinned revision: the caller composes the body's
// ConfigBindings in a template-scope expression environment (w.inputs = the
// parameters schema, exactly what nodeTemplate does) and records the
// TemplateRef pin on the plan node.
func (w *walk) resolveTemplateRef(nodeID, ref, kind string, paramsValues map[string]canonValue, at ptr.Pointer) (TemplateRevision, bool) {
	atRef := at.Child("template")
	slug, version, ok := splitTemplateRef(ref)
	if !ok {
		w.err(atRef, diag.CodeTemplateRefUnresolved,
			"node %q's template reference %q must be slug@semver (e.g. security-reviewer@1.2.0)", nodeID, ref)
		return TemplateRevision{}, false
	}
	reg := w.opts.Registries
	if reg == nil || reg.Templates == nil {
		w.err(atRef, diag.CodeTemplateRefUnresolved,
			"node %q references template %s@%s, but no template registry is available to resolve it (fail-closed, ADR-0049 § 2)",
			nodeID, slug, version)
		return TemplateRevision{}, false
	}
	rev, found := reg.Templates.GetTemplateRevision(slug, version)
	if !found {
		w.err(atRef, diag.CodeTemplateRefUnresolved,
			"node %q references template %s@%s, which is not a published active revision the caller's organization can see (fail-closed, ADR-0049 § 2)",
			nodeID, slug, version)
		return TemplateRevision{}, false
	}
	if rev.Kind != kind {
		w.err(atRef, diag.CodeTypeMismatch,
			"node %q has kind %q, but template %s@%s implements %q — a node's kind must equal its template's spec.implements",
			nodeID, kind, slug, version, rev.Kind)
		return TemplateRevision{}, false
	}
	if detail := templateParamErrors(rev.Parameters, paramsValues); detail != "" {
		w.err(at.Child("config"), diag.CodeTypeMismatch,
			"node %q's config (the parameter values for %s@%s) does not match the revision's parameters: %s",
			nodeID, slug, version, detail)
		return TemplateRevision{}, false
	}
	return rev, true
}

// templateParamErrors validates the node's config (the parameter values)
// against the revision's parameters JSON schema and returns one short
// sentence per problem — "" when the values satisfy the schema.
func templateParamErrors(parameters canonValue, values map[string]canonValue) string {
	scB, err := json.Marshal(parameters)
	if err != nil {
		return "the revision's parameters schema is not JSON: " + err.Error()
	}
	var doc any
	if err := json.Unmarshal(scB, &doc); err != nil {
		return "the revision's parameters schema is not JSON: " + err.Error()
	}
	jc := jsonschema.NewCompiler()
	const resource = "https://communication.dev/schemas/node-template-parameters"
	if err := jc.AddResource(resource, doc); err != nil {
		return "the revision's parameters schema will not compile: " + err.Error()
	}
	s, err := jc.Compile(resource)
	if err != nil {
		return "the revision's parameters schema will not compile: " + err.Error()
	}
	vB, err := json.Marshal(values)
	if err != nil {
		return "the node's config is not JSON: " + err.Error()
	}
	var val any
	if err := json.Unmarshal(vB, &val); err != nil {
		return "the node's config is not JSON: " + err.Error()
	}
	vErr := s.Validate(val)
	if vErr == nil {
		return ""
	}
	var ve *jsonschema.ValidationError
	if errors.As(vErr, &ve) {
		return ve.Error()
	}
	return vErr.Error()
}

// templateBodyBindings compiles the template body's config in a
// template-scope expression environment (ADR-0049 § 2.2: the node's config
// carries the parameter values; the revision's config is the parameterized
// body). w.inputs is the walk's declared-root table and it is swapped for
// the parameters schema for exactly this compile — the same swap nodeTemplate
// performs for a standalone document — and restored before the next node, so
// the surrounding pipeline's roots are untouched.
func (w *walk) templateBodyBindings(rev TemplateRevision, at ptr.Pointer, kind string) []Binding {
	body := rev.Config
	scope := &scope{
		key:       "template",
		kind:      "template",
		exprScope: expr.ScopeTemplate,
		nodesAt:   at,
	}
	saved := w.inputs
	w.inputs = expr.SchemaFromJSON(rev.Parameters)
	bindings := w.configValues(body, at, scope, kind)
	w.inputs = saved
	return bindings
}
