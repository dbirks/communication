package compiler_test

import (
	"os"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
)

// The M4 review prompt must interpolate the evidence a reviewer can act on.
// Which roots are interpolable inside an until body is a compiler rule, not a
// preference (ADR-0022 § 2), so both halves are proven here against the real
// seed document: earlier body nodes in the same iteration ARE readable, and the
// parent scope's plan output is NOT.

// seedDoc1 reads document 1 of the published seed set — the bytes the § 7.0 seed
// posts (the until loop is /spec/nodes/2, its body is implement/test/review).
func seedDoc1(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(seedPipelineYAML)
	if err != nil {
		t.Skipf("seed pipeline set unreadable: %v", err)
	}
	return strings.Split(string(raw), "\n---\n")[0]
}

const (
	// reviewPromptAt is the seed's review node config.prompt pointer.
	reviewPromptAt = "/spec/nodes/2/config/body/nodes/2/config/prompt"
	// untilBodyScope is the until loop's body scope key.
	untilBodyScope = "/build_until_verified/"
)

// refsAt returns the compiled expressions in one scope at one pointer, as the
// plan records them.
func refsAt(t *testing.T, plan *compiler.Plan, scope, at string) (refs []string, found bool) {
	t.Helper()
	for _, e := range plan.Expressions {
		if e.Scope != scope || e.Pointer != at {
			continue
		}
		found = true
		for _, r := range e.Refs {
			refs = append(refs, r.Key())
		}
	}
	return refs, found
}

func hasRef(refs []string, want string) bool {
	for _, r := range refs {
		if r == want {
			return true
		}
	}
	return false
}

// TestSeedReviewPromptReadsSameIterationBodyNodes proves the readable half: the
// review prompt interpolates the implement node's own outputs and the test
// node's result, both earlier in the same body scope, and the loop's inputs.
func TestSeedReviewPromptReadsSameIterationBodyNodes(t *testing.T) {
	plan, d := compileValid(t, seedDoc1(t), compiler.Options{})
	if !d.Valid() {
		for _, x := range d {
			t.Errorf("%s %s %s", x.Code, x.InstanceLocation, x.Message)
		}
		t.Fatalf("the published seed document must stay valid: %d diagnostics", len(d))
	}
	refs, found := refsAt(t, plan, untilBodyScope, reviewPromptAt)
	if !found {
		t.Fatalf("no compiled expression at %s in scope %s", reviewPromptAt, untilBodyScope)
	}
	for _, want := range []string{
		"inputs.goal", "inputs.acceptance_criteria",
		"nodes.implement.outputs.summary", "nodes.implement.outputs.files_changed",
		"nodes.test.outputs.result",
	} {
		if !hasRef(refs, want) {
			t.Errorf("the review prompt does not read %s (refs %v)", want, refs)
		}
	}
}

// TestSeedReviewPromptCannotReadParentScopePlan proves the refusing half: a
// plan-scope node output is invisible inside the until body, which is why the
// review prompt states the goal and criteria from inputs rather than quoting
// plan.summary.
func TestSeedReviewPromptCannotReadParentScopePlan(t *testing.T) {
	doc1 := seedDoc1(t)
	// The review prompt's own line pair — `Acceptance criteria:` also appears in
	// the plan node's prompt, where nodes.plan IS visible.
	const needle = "Test result: ${{ nodes.test.outputs.result }}"
	if strings.Count(doc1, needle) != 1 {
		t.Skipf("seed review prompt needle is not unique (count %d)", strings.Count(doc1, needle))
	}
	spliced := strings.Replace(doc1, needle,
		needle+"\n              Plan: ${{ nodes.plan.outputs.plan.summary }}", 1)
	_, d := compileValid(t, spliced, compiler.Options{})
	if d.Valid() {
		t.Fatal("nodes.plan compiled inside the until body; ADR-0022 § 2 scopes nodes to their own DAG")
	}
	got := firstCode(t, d, diag.CodeUnknownDependency)
	if got == nil || !strings.Contains(got.Message, "not visible in scope") {
		t.Fatalf("want unknown_dependency naming the scope rule, got %v", codes(d))
	}
}
