package compiler_test

import (
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
