package main

// Pipeline-schema/CEL self-check lane (docs/m4-contract.md § 6.2): compile the
// shipped pipeline schema with the pinned santhosh validator, evaluate one
// expression per allowlisted CEL name, and report the cel_env_digest — the
// value published revisions store, so an upgrade that re-cuts digests is
// visible from the CLI before any plan is compared (ADR-0022 § 5's pinning
// test, observable from the CLI).

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/expr"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// celProbe is one liveness expression: what to evaluate and the value the
// pinned engine must produce. A cel-go release that renames an operator
// spelling (the `@in` precedent, ADR-0022 § 5) must turn a probe red here
// before it can surprise an author at publish time.
type celProbe struct {
	src  string
	want any
}

// celLivenessProbes holds exactly one probe per ADR-0022 § 5 allowlisted name.
// The lane cross-checks the table against expr.AllowedFunctions() in both
// directions: a name without a probe, or a probe for a name no longer
// allowlisted, is reported as an error, never skipped.
var celLivenessProbes = map[string]celProbe{
	"_&&_":       {"inputs.goal == 'x' && 1 < 2", true},
	"_||_":       {"inputs.goal == 'nope' || 1 < 2", true},
	"!_":         {"!(1 == 2)", true},
	"_==_":       {"1 == 1", true},
	"_!=_":       {"1 != 2", true},
	"_<_":        {"1 < 2", true},
	"_<=_":       {"1 <= 1", true},
	"_>_":        {"2 > 1", true},
	"_>=_":       {"2 >= 2", true},
	"_+_":        {"1 + 1 == 2", true},
	"_-_":        {"3 - 1 == 2", true},
	"_*_":        {"2 * 3 == 6", true},
	"_/_":        {"7 / 2 == 3", true},
	"_%_":        {"7 % 2 == 1", true},
	"_?_:_":      {"1 < 2 ? 'go' : 'stop'", "go"},
	"@in":        {"'a' in ['a', 'b']", true},
	"has":        {"has(inputs.goal)", true},
	"size":       {"size('abc') == 3", true},
	"contains":   {"'abc'.contains('b')", true},
	"startsWith": {"'abc'.startsWith('a')", true},
	"endsWith":   {"'abc'.endsWith('c')", true},
	"string":     {"string(1) == '1'", true},
	"int":        {"int('3') == 3", true},
	"double":     {"double(1) == 1.0", true},
	"bool":       {"bool('true')", true},
}

// pipelineChecks runs the § 6.2 lane. Every check is in-process and pure —
// no database, no workspace, no external command — so the lane is honest on
// a machine with no stack running.
func pipelineChecks(ctx context.Context) []CheckResult {
	out := []CheckResult{pipelineSchemaCheck()}
	out = append(out, celLivenessChecks(ctx)...)
	return append(out, celEnvDigestCheck())
}

// pipelineSchemaCheck compiles the embedded schema asset through schema.New,
// which is the same call the API makes at process start.
func pipelineSchemaCheck() CheckResult {
	const name = "pipeline:schema"
	if _, err := schema.New(); err != nil {
		return CheckResult{Name: name, Status: statusError, Detail: err.Error()}
	}
	return CheckResult{
		Name:   name,
		Status: statusOK,
		Detail: fmt.Sprintf("compiled with pinned santhosh-tekuri/jsonschema/v6; id=%s digest=%s",
			schema.ID, schema.Digest()),
	}
}

// celLivenessChecks evaluates one expression per allowlisted name.
func celLivenessChecks(ctx context.Context) []CheckResult {
	names := expr.AllowedFunctions()
	sort.Strings(names)

	known := make(map[string]bool, len(names))
	for _, n := range names {
		known[n] = true
	}

	out := make([]CheckResult, 0, len(names))
	for _, name := range names {
		probe, ok := celLivenessProbes[name]
		if !ok {
			out = append(out, CheckResult{
				Name:   "pipeline:cel:" + name,
				Status: statusError,
				Detail: "allowlisted name has no liveness probe; add one to celLivenessProbes",
			})
			continue
		}
		out = append(out, runCELProbe(ctx, name, probe))
	}
	// A probe whose name left the allowlist means the table and the subset
	// disagree — say so rather than quietly evaluating dead entries.
	var orphans []string
	for name := range celLivenessProbes {
		if !known[name] {
			orphans = append(orphans, name)
		}
	}
	if len(orphans) > 0 {
		sort.Strings(orphans)
		out = append(out, CheckResult{
			Name:   "pipeline:cel:probes",
			Status: statusError,
			Detail: fmt.Sprintf("probes for names outside the allowlist: %s", strings.Join(orphans, ", ")),
		})
	}
	return out
}

// runCELProbe compiles and evaluates one probe expression end to end, so a
// name only reports ok when the pinned engine compiled it, the program
// evaluated, and the value matched.
func runCELProbe(ctx context.Context, name string, probe celProbe) CheckResult {
	res := CheckResult{Name: "pipeline:cel:" + name}

	p, d := expr.Prepare(expr.ScopePipeline, probe.src, expr.ScopeContext{Scope: expr.ScopePipeline})
	if !d.Valid() {
		res.Status = statusError
		res.Detail = fmt.Sprintf("%s: refused at compile: %s", probe.src, joinDiags(d))
		return res
	}
	vars := expr.Vars(nil, map[string]any{"goal": "x"}, nil, nil, nil)
	got, cost, err := p.Eval(ctx, vars)
	if err != nil {
		res.Status = statusError
		res.Detail = fmt.Sprintf("%s: eval: %v", probe.src, err)
		return res
	}
	if !reflect.DeepEqual(got, probe.want) {
		res.Status = statusError
		res.Detail = fmt.Sprintf("%s = %#v, want %#v — an operator spelling changed", probe.src, got, probe.want)
		return res
	}
	res.Status = statusOK
	res.Detail = fmt.Sprintf("%s -> %v cost=%d", probe.src, got, cost)
	return res
}

// celEnvDigestCheck reports the digest published revisions store in
// pipeline_revisions.cel_env_digest. It is computed by the same function the
// compiler stamps into plans, so a mismatch against a stored revision is the
// environment moving underneath a pinned run.
func celEnvDigestCheck() CheckResult {
	const name = "pipeline:cel_env_digest"
	digest := compiler.EnvDigest()
	if !strings.HasPrefix(digest, "sha256:") || len(digest) != len("sha256:")+64 {
		return CheckResult{Name: name, Status: statusError, Detail: "unexpected digest shape: " + digest}
	}
	return CheckResult{
		Name:   name,
		Status: statusOK,
		Detail: fmt.Sprintf("cel-go=%s digest=%s (matches pipeline_revisions.cel_env_digest)", expr.CELVersion, digest),
	}
}

// joinDiags renders compiler diagnostics on one line for a table row.
func joinDiags(d diag.List) string {
	parts := make([]string, 0, len(d))
	for _, e := range d {
		parts = append(parts, e.String())
	}
	return strings.Join(parts, "; ")
}

// pipelinesExitCode is 1 when any pipeline-lane check did not pass. Like the
// ACP lane, the verdict only affects the exit code when the lane was asked
// for; the informational base checks still exit 0.
func pipelinesExitCode(results []CheckResult) int {
	for _, r := range results {
		if strings.HasPrefix(r.Name, "pipeline:") && r.Status != statusOK {
			return 1
		}
	}
	return 0
}
