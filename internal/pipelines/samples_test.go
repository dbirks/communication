package samples_test

// Tests for the two home-cluster sample pipelines under docs/samples/home/.
//
// A sample the user pastes into the Library draft editor is only real if the
// same three steps a publish performs accept it: loader → schema validator →
// compiler (see internal/pipelines/runtime/harness_test.go's loadPlan for the
// identical sequence, and docs/m4-contract.md § 2 routes 5-7 for the publish
// path). These tests assert ZERO diagnostics at each step — a warning-severity
// diagnostic is still a document that surprised somebody — plus the handful of
// properties that make the samples what they claim to be: worker-executable node
// kinds only (no agent.acp, which this cluster has no ACP credentials for) and
// every model.chat node naming the one model the operator allowlists.
//
// Known gap these samples do NOT paper over: configModelChat.messages is
// `items: {type: object}` in the shipped schema asset, so the binding-position
// walker cannot place config.messages[i].content (schema.Position returns
// "unknown") and the compiler records it as a literal — the ${{ … }} in a
// message reaches the model verbatim. The samples are authored against the
// intended shape (03 § node table: "messages, model/provider, JSON schema"),
// so they start interpolating the moment the asset types message role/content
// as bindingText. That needs a schema change and an ADR; until then the
// published artifact and the approval summary — both real binding positions —
// carry the run's content.

import (
	"os"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/diag"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// sampleModel is the only model the home-cluster worker's
// COMMUNICATION_MODEL_CHAT_MODELS allowlist is documented to serve.
const sampleModel = "qwen3-8-flash-next"

type sample struct {
	path  string
	kinds []string // node kinds, in document order
}

var samples = []sample{
	{
		path: "../../docs/samples/home/plan-with-approval.yaml",
		kinds: []string{
			"process.exec", "model.chat", "human.approval", "artifact.publish",
		},
	},
	{
		path: "../../docs/samples/home/security-review.yaml",
		kinds: []string{"process.exec", "model.chat", "artifact.publish"},
	},
}

// compileSample runs the publish path's three steps and fails the test listing
// every diagnostic any step produced.
func compileSample(t *testing.T, path string) *compiler.Plan {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	doc, d := loader.Load(b)
	report(t, "loader", path, d)
	if !d.Valid() {
		t.Fatalf("%s: loader refused the document (%d diagnostics)", path, len(d))
	}
	d = schema.MustCompile().Validate(doc.Value)
	report(t, "schema", path, d)
	if !d.Valid() {
		t.Fatalf("%s: schema refused the document (%d diagnostics)", path, len(d))
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	report(t, "compiler", path, d)
	if !d.Valid() {
		t.Fatalf("%s: compiler refused the document (%d diagnostics)", path, len(d))
	}
	return plan
}

func report(t *testing.T, step, path string, d diag.List) {
	t.Helper()
	for _, x := range d {
		t.Errorf("%s: %s %s: %s (%s)", path, step, x.Code, x.Message, x.InstanceLocation)
	}
}

// TestSamplePipelinesCompileWithZeroDiagnostics is the gate: both documents
// parse, validate against the shipped schema asset and compile.
func TestSamplePipelinesCompileWithZeroDiagnostics(t *testing.T) {
	for _, s := range samples {
		s := s
		t.Run(sampleName(s.path), func(t *testing.T) {
			plan := compileSample(t, s.path)
			if got := nodeKinds(plan); len(got) != len(s.kinds) {
				t.Fatalf("%s: nodes = %v, want %v", s.path, got, s.kinds)
			} else {
				for i, k := range s.kinds {
					if got[i] != k {
						t.Errorf("%s: node %d kind = %q, want %q", s.path, i, got[i], k)
					}
				}
			}
			if _, err := plan.Digest(); err != nil {
				t.Errorf("%s: plan digest: %v", s.path, err)
			}
			if len(plan.Expressions) == 0 {
				t.Errorf("%s: no compiled expressions — nothing binds inputs to nodes", s.path)
			}
		})
	}
}

// TestSamplePipelinesUseNoAgentACPNodes guards the reason the samples exist:
// the home-cluster worker holds no ACP harness credentials, so a sample that
// leaned on agent.acp could be published and could never run.
func TestSamplePipelinesUseNoAgentACPNodes(t *testing.T) {
	for _, s := range samples {
		for _, n := range compileSample(t, s.path).Nodes {
			if n.Kind == "agent.acp" {
				t.Errorf("%s: node %q is agent.acp, which this worker cannot execute", s.path, n.ID)
			}
		}
	}
}

// TestSampleModelChatNodesNameTheAllowlistedModel: every model.chat node must
// pick a model by name — the endpoint is operator configuration, the node
// chooses only the model (ADR-0024 D11).
func TestSampleModelChatNodesNameTheAllowlistedModel(t *testing.T) {
	for _, s := range samples {
		plan := compileSample(t, s.path)
		seen := 0
		for _, n := range plan.Nodes {
			if n.Kind != "model.chat" {
				continue
			}
			seen++
			var model any
			for _, b := range n.ConfigBindings {
				if strings.HasSuffix(b.Pointer, "/config/model") {
					model = b.Literal
				}
			}
			if model != sampleModel {
				t.Errorf("%s: node %q config.model = %v, want %q", s.path, n.ID, model, sampleModel)
			}
		}
		if seen == 0 {
			t.Errorf("%s: no model.chat node — the sample no longer shows the kind it exists for", s.path)
		}
	}
}

func nodeKinds(plan *compiler.Plan) []string {
	out := make([]string, 0, len(plan.Nodes))
	for _, n := range plan.Nodes {
		out = append(out, n.Kind)
	}
	return out
}

func sampleName(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			return path[i+1:]
		}
	}
	return path
}
