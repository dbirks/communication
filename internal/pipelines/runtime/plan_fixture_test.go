package runtime_test

import (
	"github.com/dbirks/communication/internal/pipelines/canon"
	"github.com/dbirks/communication/internal/pipelines/compiler"
)

// Hand-built plans. Why these exist: two defects in the concurrent compiler
// (owned by another worker per the brief's boundary — "do NOT edit the
// compiler") make authored documents lose information:
//
//	a. retry/failure blocks are read from the wrong document keys
//	   (retryPolicy/failurePolicy instead of the schema's retry/onFailure),
//	   so every compiled Retry is the default and every FailurePolicy is
//	   stop;
//	b. a for_each document cannot compile at all: the composite pass always
//	   reads config "passWhen" and an absent one is an empty CEL expression,
//	   a syntax error (the schema admits no passWhen for for_each).
//
// The runtime consumes exactly the compiler's exported Plan, so tests state
// the plan the FIXED compiler would produce, struct by struct. When the
// compiler lands its fixes these builders can be replaced by loadPlan.
const scopeRootTest = "/"

func planFanout(onChildFailure string, items int, maxConc int) *compiler.Plan {
	bodyScope := "/fan_out/"
	seedSchema := canon.Value(map[string]canon.Value{
		"type": "object",
		"properties": map[string]canon.Value{"items25": map[string]canon.Value{
			"type":  "array",
			"items": map[string]canon.Value{"type": "object"},
		}},
	})
	seed := compiler.Node{
		ID: "seed", Kind: "process.exec", Scope: scopeRootTest,
		Path: []string{"seed"}, InstanceKey: "/seed",
		ExecLocation: compiler.LocationWorker,
		Failure:      compiler.FailurePolicy{OnExecutionError: "stop"},
		Retry:        compiler.Retry{MaxAttempts: 1},
		Outputs:      seedSchema,
		ConfigBindings: []compiler.Binding{{
			Pointer: "/spec/nodes/0/config/executable", Position: "bindingValue", Literal: canon.Value("seed"),
		}},
	}
	fanOut := compiler.Node{
		ID: "fan_out", Kind: "for_each", Scope: scopeRootTest,
		Path: []string{"fan_out"}, InstanceKey: "/fan_out", Indexed: []string{"fan_out"},
		ExecLocation:  compiler.LocationControlPlane,
		DependsOn:     []string{"seed"},
		Failure:       compiler.FailurePolicy{OnExecutionError: "stop"},
		Retry:         compiler.Retry{MaxAttempts: 1},
		EngineOutputs: []string{"children", "items"},
		SubScope:      bodyScope,
		ConfigBindings: []compiler.Binding{{
			Pointer: "/spec/nodes/1/config/items", Position: "bindingValue",
			ExprIDs: []string{"e1"}, Template: "%e1",
		}},
	}
	invoke := compiler.Node{
		ID: "invoke", Kind: "pipeline.invoke", Scope: bodyScope,
		Path: []string{"fan_out", "invoke"}, InstanceKey: "/fan_out[0]/invoke",
		Indexed:      []string{"fan_out"},
		ExecLocation: compiler.LocationControlPlane,
		Failure:      compiler.FailurePolicy{OnExecutionError: "stop"},
		Retry:        compiler.Retry{MaxAttempts: 1},
		SubScope:     "",
		ConfigBindings: []compiler.Binding{
			{Pointer: "/spec/nodes/1/config/body/nodes/0/config/pipeline", Position: "bindingValue", Literal: canon.Value("issue-implementation")},
			{Pointer: "/spec/nodes/1/config/body/nodes/0/config/inputs/issue", Position: "bindingValue", ExprIDs: []string{"e2"}, Template: "%e2"},
		},
	}
	return &compiler.Plan{
		Version: compiler.PlanVersion, DigestScope: canon.DigestScope, CELVersion: "v0.31.0-test",
		Document: compiler.DocumentInfo{APIVersion: "communication.dev/v1alpha1", Kind: "Pipeline", Name: "fan-out"},
		Inputs: canon.Value(map[string]canon.Value{
			"type": "object", "required": []canon.Value{"goal"},
			"properties": map[string]canon.Value{"goal": map[string]canon.Value{"type": "string"}},
		}),
		Policies: compiler.Policies{MaxConcurrentNodes: 8, MaxNodeExecutions: 200, MaxChildDepth: 2, CancelPolicy: "cascade"},
		Scopes: []compiler.Scope{
			{
				Key: scopeRootTest, Kind: "root",
				EntryNodes: []string{"seed"}, TerminalNodes: []string{"fan_out"},
				TopologicalOrder: []string{"seed", "fan_out"}, ExpressionScope: "pipeline",
			},
			{
				Key: bodyScope, Kind: "for_each", Owner: "fan_out", Parent: scopeRootTest,
				EntryNodes: []string{"invoke"}, TerminalNodes: []string{"invoke"},
				TopologicalOrder: []string{"invoke"}, ExpressionScope: "for_each",
				MaxConcurrency: maxConc, OnChildFailure: onChildFailure,
				IndexedSegments: []string{"fan_out"},
			},
		},
		Nodes: []compiler.Node{seed, fanOut, invoke},
		Expressions: []compiler.Expression{
			{
				ID: "e1", Pointer: "/spec/nodes/1/config/items", Scope: scopeRootTest,
				Position: "bindingValue", Source: "nodes.seed.outputs.items25",
				NormalizedAST: "nodes.seed.outputs.items25",
				Refs:          []compiler.Ref{{Root: "nodes", Path: []string{"seed", "outputs", "items25"}}},
				ResultType:    "dyn", Cost: compiler.CostEstimate{Nodes: 4, ActualLimit: 200},
			},
			{
				ID: "e2", Pointer: "/spec/nodes/1/config/body/nodes/0/config/inputs/issue", Scope: bodyScope,
				Position: "bindingValue", Source: "item.number",
				NormalizedAST: "item.number",
				Refs:          []compiler.Ref{{Root: "item", Path: []string{"number"}}},
				ResultType:    "dyn", Cost: compiler.CostEstimate{Nodes: 2, ActualLimit: 200},
			},
		},
		Budgets: compiler.DefaultBudgets(),
	}
}

// planInvokeOne is the minimal parent for the child-run bookkeeping tests:
// one pipeline.invoke at the root, no expressions at all.
func planInvokeOne() *compiler.Plan {
	return &compiler.Plan{
		Version: compiler.PlanVersion, DigestScope: canon.DigestScope, CELVersion: "v0.31.0-test",
		Document: compiler.DocumentInfo{APIVersion: "communication.dev/v1alpha1", Kind: "Pipeline", Name: "invoke-one"},
		Inputs: canon.Value(map[string]canon.Value{
			"type": "object", "properties": map[string]canon.Value{"goal": map[string]canon.Value{"type": "string"}},
		}),
		Policies: compiler.Policies{MaxConcurrentNodes: 4, MaxNodeExecutions: 200, MaxChildDepth: 2, CancelPolicy: "cascade"},
		Scopes: []compiler.Scope{{
			Key: scopeRootTest, Kind: "root",
			EntryNodes: []string{"invoke"}, TerminalNodes: []string{"invoke"},
			TopologicalOrder: []string{"invoke"}, ExpressionScope: "pipeline",
		}},
		Nodes: []compiler.Node{{
			ID: "invoke", Kind: "pipeline.invoke", Scope: scopeRootTest,
			Path: []string{"invoke"}, InstanceKey: "/invoke",
			ExecLocation: compiler.LocationControlPlane,
			Failure:      compiler.FailurePolicy{OnExecutionError: "stop"},
			Retry:        compiler.Retry{MaxAttempts: 1},
			ConfigBindings: []compiler.Binding{
				{Pointer: "/spec/nodes/0/config/pipeline", Position: "bindingValue", Literal: canon.Value("issue-implementation")},
			},
		}},
		Budgets: compiler.DefaultBudgets(),
	}
}
