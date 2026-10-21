package compiler

import (
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/ptr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// nodeTemplate compiles a NodeTemplate document (01 § node templates). M4
// validates its shape and parameters; publishing a template is the registry
// API's job (ADR-0049 § 3) — the document's config is compiled against the
// template's parameter envelope, which is what a host node's expansion
// substitutes into its own config values.
func (w *walk) nodeTemplate(spec map[string]canonValue) {
	w.inputs = expr.SchemaFromJSON(spec["parameters"])
	w.plan.Inputs = spec["parameters"]
	w.plan.Outputs = spec["outputs"]

	name := ""
	if m, ok := w.doc["metadata"].(map[string]canonValue); ok {
		name, _ = m["name"].(string)
	}
	w.plan.Document.Name = name

	// A NodeTemplate is one node: implements + parameters + config +
	// outputSchema (01 § node templates). It has no DAG of its own, so there is
	// no scope to walk — its config is compiled against the template's parameter
	// envelope, which is what an M5 expansion substitutes into the host node.
	impl, _ := spec["implements"].(string)
	if impl == "" {
		w.err(ptr.Root.Child("spec").Child("implements"), diag.CodeSchemaShape,
			"a node template must name the kind it implements")
	} else if reason, deferred := deferredKinds[impl]; deferred {
		if !w.opts.AllowDeferredKinds {
			w.err(ptr.Root.Child("spec").Child("implements"), diag.CodeKindNotImplemented,
				"kind %q is validated but not executed by this build: %s", impl, reason)
		}
	} else if !executedKinds[impl] {
		w.err(ptr.Root.Child("spec").Child("implements"), diag.CodeKindNotImplemented,
			"kind %q is not in the v1alpha1 catalogue", impl)
	}

	tmpl := &scope{
		key:       "/",
		kind:      "template",
		exprScope: expr.ScopeTemplate,
		nodes:     nil,
		nodesAt:   ptr.Root.Child("spec"),
	}
	cfg, _ := spec["config"].(map[string]canonValue)
	w.plan.Nodes = append(w.plan.Nodes, Node{
		ID: name, Kind: impl, Scope: "/", InstanceKey: "/" + name,
		ExecLocation:   locationOf(impl),
		Outputs:        spec["outputSchema"],
		ConfigBindings: w.configValues(cfg, ptr.Root.Child("spec").Child("config"), tmpl, impl),
	})

	if r := w.opts.Registries; r != nil && r.NodeTemplates != nil && name != "" {
		if r.NodeTemplates.Exists(name) {
			w.err(ptr.Root.Child("metadata").Child("name"), diag.CodeDuplicateKey,
				"node template %q is already registered", name)
		}
	}
}

// CompileNodeTemplate is the entry point for a NodeTemplate document, kept
// separate so callers cannot confuse it with a pipeline draft (the loader
// already separated the kinds; 01 § documents).
func CompileNodeTemplate(doc loader.Document, opts Options) (*Plan, diag.List) {
	if doc.Kind != loader.KindNodeTemplate {
		d := diag.List{}
		d.Addf(diag.SourceCompiler, diag.CodeUnknownDocument, ptr.Root,
			"CompileNodeTemplate needs a NodeTemplate document, got %q", doc.Kind)
		return nil, d
	}
	return Compile(doc, opts)
}

var _ = schema.Digest
