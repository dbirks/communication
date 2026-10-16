package compiler_test

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// The policy blocks — retry, onFailure and the composite predicates — are what
// the M4 runtime reads on every reconciler pass (§ 5.1 steps 3 and 8, § 6,
// § 7 C10/C12). They were compiled from field names the schema never defines
// (`retryPolicy`, `failurePolicy`) and from flat backoff fields the schema
// nests under `backoff`, so an authored policy reached no one: the plan simply
// carried defaults and the graph behaved as if nothing had been written. These
// tests pin the authored names, the nested shape, the defaults ADR-0023 leaves
// in place, and the diagnostic locations, so the same class of defect cannot
// return silently.

func sameRetry(a, b compiler.Retry) bool {
	return a.MaxAttempts == b.MaxAttempts && a.BaseSeconds == b.BaseSeconds &&
		a.Multiplier == b.Multiplier && a.MaxSeconds == b.MaxSeconds && a.Jitter == b.Jitter &&
		a.WorkspacePolicy == b.WorkspacePolicy &&
		strings.Join(a.RetriableErrors, ",") == strings.Join(b.RetriableErrors, ",")
}

func firstCode(t *testing.T, d diag.List, code diag.Code) *diag.Diagnostic {
	t.Helper()
	for i := range d {
		if d[i].Code == code {
			return &d[i]
		}
	}
	return nil
}

// compileValid is the API path: loader, then schema, then compiler.
func compileValid(t *testing.T, text string, opts compiler.Options) (*compiler.Plan, diag.List) {
	t.Helper()
	doc, d := loader.Load([]byte(text))
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	if d = schema.MustCompile().Validate(doc.Value); !d.Valid() {
		return nil, d
	}
	return compiler.Compile(doc, opts)
}

const policyDoc = `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: policy-authored
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
  - id: build
    kind: process.exec
    config:
      executable: go
      args: ["test", "./..."]
    retry:
      maxAttempts: 4
      backoff:
        baseSeconds: 7
        multiplier: 3
        maxSeconds: 90
        jitter: false
      retriableErrors: [infra, timeout]
      workspacePolicy: restore_checkpoint
    onFailure:
      onExecutionError: continue
  - id: carrier
    kind: process.exec
    dependsOn: [build]
    config:
      executable: sh
    retry:
      maxAttempts: 2
    onFailure:
      onExecutionError: route
      errorRoute: build
`

// TestAuthoredRetryReachesThePlan: contract § 9.2's retryPolicy is
// {maxAttempts, backoff{baseSeconds, multiplier, maxSeconds, jitter},
// retriableErrors, workspacePolicy} under the node key `retry`. The plan must
// carry exactly what the author wrote, because the runtime's retry decision,
// backoff delay and workspace choice are plan-driven and read nothing else.
func TestAuthoredRetryReachesThePlan(t *testing.T) {
	plan, d := compileValid(t, policyDoc, compiler.Options{})
	if !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatal("a document that authors its policies must compile")
	}
	build, ok := plan.FindNode("/", "build")
	if !ok {
		t.Fatal("no build node")
	}
	want := compiler.Retry{
		MaxAttempts: 4, BaseSeconds: 7, Multiplier: 3, MaxSeconds: 90,
		WorkspacePolicy: "restore_checkpoint", RetriableErrors: []string{"infra", "timeout"},
	}
	if !sameRetry(build.Retry, want) {
		t.Errorf("authored retry = %+v, want %+v", build.Retry, want)
	}
	if build.Retry.Jitter {
		t.Error("authored backoff.jitter: false did not reach the plan")
	}
	if build.Failure.OnExecutionError != "continue" || build.Failure.ErrorRoute != "" {
		t.Errorf("authored onFailure = %+v, want continue with no route", build.Failure)
	}
	// A retry block that names only maxAttempts keeps ADR-0023 § 7's exponential
	// defaults (base 30 s, multiplier 2, ±20 % jitter) and the default workspace
	// policy — the schema's continue_workspace, the only spelling a document can
	// author.
	carrier, _ := plan.FindNode("/", "carrier")
	if carrier.Retry.MaxAttempts != 2 || carrier.Retry.BaseSeconds != 30 || carrier.Retry.Multiplier != 2 || !carrier.Retry.Jitter {
		t.Errorf("retry defaults = %+v, want maxAttempts 2 with 30s/2x/jitter", carrier.Retry)
	}
	if carrier.Retry.WorkspacePolicy != "continue_workspace" {
		t.Errorf("default workspacePolicy = %q, want continue_workspace (ADR-0023 § 6)", carrier.Retry.WorkspacePolicy)
	}
	if len(carrier.Retry.RetriableErrors) != 0 {
		t.Errorf("retriableErrors = %v, want none authored", carrier.Retry.RetriableErrors)
	}
	if carrier.Failure.OnExecutionError != "route" || carrier.Failure.ErrorRoute != "build" {
		t.Errorf("route policy = %+v, want a route to build", carrier.Failure)
	}
}

// TestUnauthoredPolicyIsDefaultedNotRetried: no retry block means one attempt,
// so a failure is terminal on the first try (§ 5.1 step 3), and stop is the
// authored default (§ 5.1 step 8).
func TestUnauthoredPolicyIsDefaultedNotRetried(t *testing.T) {
	plan, d := compileValid(t, `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: policy-defaults
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
  - id: plain
    kind: process.exec
    config:
      executable: ls
`, compiler.Options{})
	if !d.Valid() {
		t.Fatal(d)
	}
	n, _ := plan.FindNode("/", "plain")
	if n.Retry.MaxAttempts != 1 {
		t.Errorf("default maxAttempts = %d, want 1", n.Retry.MaxAttempts)
	}
	if n.Retry.WorkspacePolicy != "continue_workspace" {
		t.Errorf("default workspacePolicy = %q, want continue_workspace", n.Retry.WorkspacePolicy)
	}
	if n.Failure.OnExecutionError != "stop" {
		t.Errorf("default onExecutionError = %q, want stop", n.Failure.OnExecutionError)
	}
}

// TestPolicyDiagnosticsNameTheAuthoredField: § 9.1 row 25 — a machine-readable
// location is what makes a policy refusal actionable in an editor. A diagnostic
// pointing at a key the author never wrote is worse than none, because the
// editor highlights nothing and the author guesses.
func TestPolicyDiagnosticsNameTheAuthoredField(t *testing.T) {
	const head = `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: policy-diag
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
  - id: a
    kind: process.exec
    config:
      executable: ls
`
	cases := []struct {
		name   string
		tail   string
		code   diag.Code
		wantAt string
	}{
		{
			name:   "maxAttempts above the assignment ceiling",
			tail:   "\n    retry:\n      maxAttempts: 6\n",
			code:   diag.CodeBudgetAboveCeiling,
			wantAt: "/spec/nodes/0/retry/maxAttempts",
		},
		{
			name:   "a route target that is not a sibling",
			tail:   "\n    onFailure:\n      onExecutionError: route\n      errorRoute: ghost\n",
			code:   diag.CodeUnknownDependency,
			wantAt: "/spec/nodes/0/onFailure/errorRoute",
		},
		{
			name:   "a route with no target",
			tail:   "\n    onFailure:\n      onExecutionError: route\n",
			code:   diag.CodeUnknownDependency,
			wantAt: "/spec/nodes/0/onFailure/onExecutionError",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := compiler.Options{}
			if tc.code == diag.CodeBudgetAboveCeiling {
				b := compiler.DefaultBudgets()
				b.MaxAttempts = 2
				opts.Budgets = &b
			}
			_, d := compileValid(t, head+tc.tail, opts)
			got := firstCode(t, d, tc.code)
			if got == nil {
				t.Fatalf("no %s in %v", tc.code, codes(d))
			}
			if string(got.InstanceLocation) != tc.wantAt {
				t.Errorf("location = %s, want %s (%s)", got.InstanceLocation, tc.wantAt, got.Message)
			}
		})
	}
}

// TestWorkspaceLostIsNeverRetriable documents ADR-0023 § 7's rule as the
// compiler states it. The schema's enum already refuses the name; the compiler
// says so too, in a document that skipped validation, because the runtime would
// otherwise promise a retry nothing can perform.
func TestWorkspaceLostIsNeverRetriable(t *testing.T) {
	text := `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: workspace-lost
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
  - id: a
    kind: process.exec
    config:
      executable: ls
    retry:
      maxAttempts: 3
      retriableErrors: [infra, workspace_lost]
`
	doc, d := loader.Load([]byte(text))
	if !d.Valid() {
		t.Fatal(d)
	}
	if d = schema.MustCompile().Validate(doc.Value); d.Valid() {
		t.Fatal("the schema admitted workspace_lost into retriableErrors")
	}
	_, d = compiler.Compile(doc, compiler.Options{})
	got := firstCode(t, d, diag.CodeUnsupportedPolicy)
	if got == nil {
		t.Fatalf("no unsupported_policy over the unvalidated document: %v", codes(d))
	}
	if string(got.InstanceLocation) != "/spec/nodes/0/retry/retriableErrors" {
		t.Errorf("location = %s", got.InstanceLocation)
	}
}

const forEchoDoc = `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: fan
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
  - id: seed
    kind: process.exec
    config:
      executable: ls
    outputs:
      type: object
      properties:
        items3:
          type: array
          items:
            type: object
  - id: fan_out
    kind: for_each
    dependsOn: [seed]
    config:
      items: ${{ nodes.seed.outputs.items3 }}
      maxConcurrency: 2
      onChildFailure: stop
      body:
        nodes:
        - id: invoke
          kind: pipeline.invoke
          config:
            pipeline: issue-implementation
            waitFor: completion
            inputs:
              issue: ${{ item.number }}
  - id: after
    kind: process.exec
    dependsOn: [fan_out]
    config:
      executable: ls
    when: nodes.fan_out.status == 'succeeded'
`

// TestForEachCompilesWithoutAPredicate is the regression pin for the composite
// predicate defect: passWhen/failWhen exist in configUntil and nowhere else, so
// reading them for every composite compiled an empty expression for each
// for_each body and refused a legal document with cel_compile_error.
func TestForEachCompilesWithoutAPredicate(t *testing.T) {
	plan, d := compileValid(t, forEchoDoc, compiler.Options{})
	if !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatalf("a legal for_each must compile: %d diagnostics", len(d))
	}
	fan, ok := plan.FindNode("/", "fan_out")
	if !ok {
		t.Fatal("no fan_out node")
	}
	if fan.PassWhen != nil || fan.FailWhen != nil {
		t.Errorf("for_each carries predicates %v / %v; its scope ends when every index is terminal (ADR-0023 § 8)", fan.PassWhen, fan.FailWhen)
	}
	if fan.SubScope != "/fan_out/" {
		t.Errorf("subscope = %q", fan.SubScope)
	}
	sc, ok := plan.FindScope("/fan_out/")
	if !ok {
		t.Fatal("the for_each body scope is missing from the plan")
	}
	if sc.MaxConcurrency != 2 || sc.OnChildFailure != "stop" {
		t.Errorf("body scope = concurrency %d, child failure %q", sc.MaxConcurrency, sc.OnChildFailure)
	}
	if len(fan.ResultBindings) != 0 {
		t.Errorf("resultBindings = %+v, want none authored", fan.ResultBindings)
	}
	invoke, ok := plan.FindNode("/fan_out/", "invoke")
	if !ok {
		t.Fatal("no invoke node in the body")
	}
	if !strings.HasPrefix(invoke.InstanceKey, "/fan_out[") {
		t.Errorf("instance key = %q, want an indexed body path", invoke.InstanceKey)
	}
	if invoke.ExecLocation != compiler.LocationControlPlane {
		t.Errorf("invoke location = %q, want control_plane", invoke.ExecLocation)
	}
	// The until predicate path must still compile: the fix is presence-scoped,
	// not a removal.
	until, d := compileValid(t, untilDoc, compiler.Options{})
	if !d.Valid() {
		t.Fatal(d)
	}
	loop, _ := until.FindNode("/", "iterate")
	if loop.PassWhen == nil {
		t.Error("an until lost its passWhen")
	}
}

const untilDoc = `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: loop
spec:
  inputs:
    type: object
    properties:
      goal: {type: string}
  nodes:
  - id: iterate
    kind: until
    config:
      maxIterations: 3
      passWhen: nodes.try.outputs.done == true
      resultBindings:
        verdict: ${{ nodes.try.outputs.done }}
      body:
        nodes:
        - id: try
          kind: process.exec
          config:
            executable: ls
          outputs:
            type: object
            properties:
              done:
                type: boolean
`

// TestCompositePredicatesAreRefusedWhereTheyDoNotBelong: the schema is the
// first door (configForEach admits no passWhen), but the compiler states it too,
// because a predicate it silently dropped changes when a scope ends.
func TestCompositePredicatesAreRefusedWhereTheyDoNotBelong(t *testing.T) {
	text := strings.Replace(forEchoDoc,
		"maxConcurrency: 2", "maxConcurrency: 2\n      passWhen: true == true", 1)
	_, d := compileValid(t, text, compiler.Options{})
	if d.Valid() {
		t.Fatal("the schema accepted a passWhen on a for_each")
	}
	if firstCode(t, d, diag.CodeSchemaShape) == nil {
		t.Errorf("want the schema to refuse it, got %v", codes(d))
	}
	doc, ld := loader.Load([]byte(text))
	if !ld.Valid() {
		t.Fatal(ld)
	}
	_, d = compiler.Compile(doc, compiler.Options{})
	got := firstCode(t, d, diag.CodeUnsupportedPolicy)
	if got == nil {
		t.Fatalf("the compiler accepted a for_each passWhen: %v", codes(d))
	}
	if string(got.InstanceLocation) != "/spec/nodes/1/config/passWhen" {
		t.Errorf("location = %s", got.InstanceLocation)
	}
	if !strings.Contains(got.Message, "until") {
		t.Errorf("message %q does not name the kind that does have predicates", got.Message)
	}
}

// TestUntilWithoutPassWhenIsRefused: passWhen is mandatory in configUntil, and
// a loop with no predicate would end after one iteration under the runtime's
// "a missing predicate is satisfied" reading — a silent semantic, so the
// compiler's defensive arm names it.
func TestUntilWithoutPassWhenIsRefused(t *testing.T) {
	text := strings.Replace(untilDoc, "      passWhen: nodes.try.outputs.done == true\n", "", 1)
	_, d := compileValid(t, text, compiler.Options{})
	if d.Valid() {
		t.Fatal("the schema accepted an until with no passWhen")
	}
	if firstCode(t, d, diag.CodeSchemaShape) == nil {
		t.Errorf("want schema_shape from the schema, got %v", codes(d))
	}
	doc, ld := loader.Load([]byte(text))
	if !ld.Valid() {
		t.Fatal(ld)
	}
	_, d = compiler.Compile(doc, compiler.Options{})
	got := firstCode(t, d, diag.CodeSchemaShape)
	if got == nil {
		t.Fatalf("the compiler accepted an until with no passWhen: %v", codes(d))
	}
	if !strings.Contains(got.Message, "passWhen") {
		t.Errorf("message %q does not name the missing key", got.Message)
	}
	if string(got.InstanceLocation) != "/spec/nodes/0/config" {
		t.Errorf("location = %s", got.InstanceLocation)
	}
}

// TestSelfInvokeIsRefusedAtValidate is contract § 7 C8f's first arm: a pipeline
// whose invoke names its own metadata.name cannot terminate — every pass arms
// another run of itself — so validate says child_depth_exceeded rather than
// publishing an unschedulable graph and letting the run die on
// runs_depth_check. The refusal is document-local (validate carries only the
// bytes), so it must not wait for InvokeDepthCheck or the assignment ceilings,
// which the validate route does not have.
func TestSelfInvokeIsRefusedAtValidate(t *testing.T) {
	// Control: the SAME legal graph, whose name is `fan`, invoking a different
	// published pipeline. A rule that fired on any invoke would break this.
	if _, d := compileValid(t, forEchoDoc, compiler.Options{}); !d.Valid() {
		t.Fatalf("an invoke of another pipeline must stay valid: %v", codes(d))
	}

	self := strings.Replace(forEchoDoc, "  name: fan\n", "  name: issue-implementation\n", 1)
	_, d := compileValid(t, self, compiler.Options{})
	if d.Valid() {
		t.Fatal("validate accepted a pipeline that invokes itself")
	}
	got := firstCode(t, d, diag.CodeChildDepthExceeded)
	if got == nil {
		t.Fatalf("want child_depth_exceeded, got %v", codes(d))
	}
	if got.Source != diag.SourceCompiler {
		t.Errorf("source = %s, want compiler", got.Source)
	}
	if string(got.InstanceLocation) != "/spec/nodes/1/config/body/nodes/0/config/pipeline" {
		t.Errorf("location = %s, want the invoke's own pipeline field", got.InstanceLocation)
	}
	if !strings.Contains(got.Message, "issue-implementation") {
		t.Errorf("message %q does not name the target it refused", got.Message)
	}

	// An expression target is unresolvable at publish (§ 5.5), so the rule
	// stays quiet rather than inventing a self-reference.
	exprTarget := strings.Replace(
		strings.Replace(forEchoDoc, "  name: fan\n", "  name: issue-implementation\n", 1),
		"pipeline: issue-implementation", "pipeline: '${{ inputs.goal }}'", 1)
	if _, d := compileValid(t, exprTarget, compiler.Options{}); firstCode(t, d, diag.CodeChildDepthExceeded) != nil {
		t.Errorf("an expression target was called a self-invoke: %v", codes(d))
	}
}

// selfInvokeNode is C8f's probe body: a for_each whose only body node invokes
// the document's own pipeline name — the same splice the e2e driver performs on
// the § 7.0 seed header.
const selfInvokeNode = `  - id: fan
    kind: for_each
    config:
      items: '${{ inputs.goal }}'
      maxConcurrency: 1
      onChildFailure: collect_and_continue
      body:
        nodes:
        - id: invoke
          kind: pipeline.invoke
          timeoutSeconds: 60
          config:
            pipeline: 'issue-implementation'
            inputs:
              number: '1'
`

const seedPipelineYAML = "../../../docs/compatibility/probes/m4/pipeline.yaml"

// TestSeedHeaderSelfInvokeProbeIsRefused runs C8f's probe over the REAL seed
// document: take document 1's published header, rename it to the fan-out
// child's name, and splice the self-invoke body. The published set itself must
// stay valid; the self-invoke must not be. This is the offline half of the live
// gate — the lab only ever sees the POSTed bytes.
func TestSeedHeaderSelfInvokeProbeIsRefused(t *testing.T) {
	raw, err := os.ReadFile(seedPipelineYAML)
	if err != nil {
		t.Skipf("seed pipeline set unreadable: %v", err)
	}
	doc1 := strings.Split(string(raw), "\n---\n")[0]
	if !strings.Contains(doc1, "\n  nodes:") {
		t.Skip("document 1 has no nodes block")
	}
	const policies = "\n  policies:\n    maxConcurrentNodes: 1\n    maxDurationSeconds: 3600\n" +
		"    maxNodeExecutions: 50\n    maxChildDepth: 0\n    workspaceMode: worktree\n" +
		"    cancelPolicy: cascade\n"
	// build is c13_doc: the published header, only name/policies/nodes swapped.
	build := func(name, nodes string) string {
		head := doc1[:strings.Index(doc1, "\n  nodes:")]
		if j := strings.Index(head, "\n  policies:"); j >= 0 {
			head = head[:j]
		}
		head = regexp.MustCompile(`(?m)^  name: .*$`).ReplaceAllString(head, "  name: "+name)
		return head + policies + "  nodes:\n" + nodes
	}
	// Control: the untouched published document 1 compiles clean.
	if _, d := compileValid(t, doc1, compiler.Options{}); !d.Valid() {
		for _, x := range d {
			t.Logf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatalf("the published seed document must stay valid: %d diagnostics", len(d))
	}
	_, d := compileValid(t, build("issue-implementation", selfInvokeNode), compiler.Options{})
	if d.Valid() {
		t.Fatal("validate accepted a pipeline named issue-implementation that invokes issue-implementation")
	}
	got := firstCode(t, d, diag.CodeChildDepthExceeded)
	if got == nil {
		t.Fatalf("want child_depth_exceeded, got %v", codes(d))
	}
	if got.InstanceLocation.String() != "/spec/nodes/0/config/body/nodes/0/config/pipeline" {
		t.Errorf("location = %s", got.InstanceLocation)
	}
}
