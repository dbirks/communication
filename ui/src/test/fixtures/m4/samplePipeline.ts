/**
 * The corrected sample pipeline, verbatim from `docs/m4-contract.md` § 9.3 —
 * the same bytes as
 * `docs/compatibility/m4-spike/module/candidate/feature-development-contract.yaml`,
 * which was the document the Go spike validated and compiled against real
 * cel-go. Fixtures here are that document plus the § 2 / § 3 payload shapes it
 * would produce; nothing is invented.
 */
import type { DefinitionDocument } from "../../../lib/pipeline/definition";

export const samplePipelineYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: feature-development
  description: Plan, approve, implement, test, review, loop until verified, publish evidence.
spec:
  inputs:
    type: object
    required: [goal, repository]
    properties:
      goal: {type: string, minLength: 1}
      repository: {type: string, minLength: 1}
      acceptance_criteria:
        type: string
        default: Tests pass, the plan is followed, and the reviewer approves.
  outputs:
    type: object
    required: [implementation_summary]
    properties:
      implementation_summary: {type: string}
      review_approved: {type: boolean}
      iterations: {type: integer}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 14400
    maxNodeExecutions: 200
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: plan
    kind: agent.acp
    timeoutSeconds: 900
    retry:
      maxAttempts: 3
      backoff: {baseSeconds: 5, multiplier: 2, maxSeconds: 120, jitter: true}
      retriableErrors: [infra, interrupted, timeout, agent_error, invalid_output]
    config:
      profile: m4-planner
      sessionMode: new
      prompt: |
        Goal: \${{ inputs.goal }}
        Acceptance criteria: \${{ inputs.acceptance_criteria }}
        Reply with JSON {plan} only.
    outputs:
      type: object
      required: [plan]
      properties:
        plan: {type: string, minLength: 1}
  - id: approve
    kind: human.approval
    dependsOn: [plan]
    retry:
      maxAttempts: 1
    config:
      summary: |
        Plan for \${{ inputs.goal }}
        \${{ nodes.plan.outputs.plan }}
      approverRoles: [maintainer]
      deadlineSeconds: 86400
      onTimeout: fail
  - id: build_until_verified
    kind: until
    dependsOn: [approve]
    timeoutSeconds: 7200
    config:
      maxIterations: 4
      maxDurationSeconds: 7200
      passWhen: nodes.test.outputs.result.successful == true && nodes.review.status == 'succeeded' && nodes.review.outputs.approved == true
      carryForward: true
      body:
        nodes:
        - id: implement
          kind: agent.acp
          retry:
            maxAttempts: 2
            backoff: {baseSeconds: 10, multiplier: 2, maxSeconds: 120, jitter: true}
            retriableErrors: [infra, interrupted, timeout, agent_error]
          config:
            profile: m4-implementer
            sessionMode: resume_if_supported
            fallback: new
            workspace:
              mode: run_workspace
              repositories: ['\${{ inputs.repository }}']
            secretRefs: [project/test-database-url]
            prompt: |
              Implement the approved plan in repository \${{ inputs.repository }}.
              Goal: \${{ inputs.goal }}
              Previous reviewer feedback: \${{ has(previous.review_feedback) ? previous.review_feedback : '(first iteration: no prior review)' }}
              Reply with JSON {summary, files_changed} only.
          outputs:
            type: object
            required: [summary]
            properties:
              summary: {type: string}
              files_changed: {type: array, items: {type: string}}
        - id: test
          kind: process.exec
          dependsOn: [implement]
          timeoutSeconds: 900
          retry:
            maxAttempts: 2
            backoff: {baseSeconds: 5, multiplier: 2, maxSeconds: 60, jitter: false}
            retriableErrors: [infra, interrupted]
          config:
            executable: go
            args: [test, ./...]
            cwd: repos/app
            workspace:
              mode: run_workspace
              repositories: ['\${{ inputs.repository }}']
            outputExtraction: {mode: json_from_path, path: build/test-result.json}
          outputs:
            type: object
            required: [exit_code, result]
            properties:
              exit_code: {type: integer}
              result:
                type: object
                required: [successful]
                properties:
                  successful: {type: boolean}
                  packages: {type: array, items: {type: object}}
        - id: review
          kind: agent.acp
          dependsOn: [test]
          retry:
            maxAttempts: 2
            backoff: {baseSeconds: 10, multiplier: 2, maxSeconds: 120, jitter: true}
            retriableErrors: [infra, interrupted, timeout, agent_error, invalid_output]
          config:
            profile: m4-reviewer
            sessionMode: new
            workspace:
              mode: read_only
              repositories: ['\${{ inputs.repository }}']
            prompt: |
              Decide whether the acceptance criteria are met.
              Criteria: \${{ inputs.acceptance_criteria }}
              Test result: \${{ nodes.test.outputs.result }}
              Reply with JSON {approved, evidence, findings} only.
          outputs:
            type: object
            required: [approved, evidence]
            properties:
              approved: {type: boolean}
              evidence: {type: string}
              findings: {type: array, items: {type: string}}
      resultBindings:
        implementation_summary: \${{ nodes.implement.outputs.summary }}
        review_feedback: \${{ nodes.review.outputs.evidence }}
        approved: \${{ nodes.review.outputs.approved }}
    outputs:
      type: object
      required: [iterations, approved]
      properties:
        iterations: {type: integer}
        approved: {type: boolean}
        implementation_summary: {type: string}
        review_feedback: {type: string}
  - id: verdict
    kind: condition
    dependsOn: [build_until_verified]
    config:
      cases:
      - when: nodes.build_until_verified.outputs.approved == true
        route: verified
      default: needs_attention
  - id: publish_verified
    kind: artifact.publish
    dependsOn: [verdict]
    when: nodes.verdict.outputs.route == 'verified'
    config:
      name: review-evidence.md
      kind: markdown
      mediaType: text/markdown
      sensitivity: standard
      from:
        mode: output_json
        value: \${{ nodes.build_until_verified.outputs }}
  - id: publish_needs_attention
    kind: artifact.publish
    dependsOn: [verdict]
    when: nodes.verdict.outputs.route == 'needs_attention'
    config:
      name: needs-attention.json
      kind: json
      mediaType: application/json
      sensitivity: standard
      from:
        mode: output_json
        value: \${{ nodes.build_until_verified.outputs }}
  resultBindings:
    implementation_summary: \${{ nodes.build_until_verified.outputs.implementation_summary }}
    review_approved: \${{ nodes.build_until_verified.outputs.approved }}
    iterations: \${{ nodes.build_until_verified.outputs.iterations }}
`;

/** Route 13's `canonical_document` for the same pipeline, as the server serves it. */
export const samplePipelineDocument = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: {
    name: "feature-development",
    description: "Plan, approve, implement, test, review, loop until verified, publish evidence.",
  },
  spec: {
    inputs: {
      type: "object",
      required: ["goal", "repository"],
      properties: {
        goal: { type: "string", minLength: 1 },
        repository: { type: "string", minLength: 1 },
        acceptance_criteria: {
          type: "string",
          default: "Tests pass, the plan is followed, and the reviewer approves.",
        },
      },
    },
    outputs: {
      type: "object",
      required: ["implementation_summary"],
      properties: {
        implementation_summary: { type: "string" },
        review_approved: { type: "boolean" },
        iterations: { type: "integer" },
      },
    },
    policies: {
      maxConcurrentNodes: 1,
      maxDurationSeconds: 14400,
      maxNodeExecutions: 200,
      maxChildDepth: 0,
      workspaceMode: "worktree",
      cancelPolicy: "cascade",
    },
    nodes: [
      {
        id: "plan",
        kind: "agent.acp",
        timeoutSeconds: 900,
        retry: {
          maxAttempts: 3,
          backoff: { baseSeconds: 5, multiplier: 2, maxSeconds: 120, jitter: true },
          retriableErrors: ["infra", "interrupted", "timeout", "agent_error", "invalid_output"],
        },
        config: {
          profile: "m4-planner",
          sessionMode: "new",
          prompt:
            "Goal: ${{ inputs.goal }}\nAcceptance criteria: ${{ inputs.acceptance_criteria }}\nReply with JSON {plan} only.\n",
        },
        outputs: {
          type: "object",
          required: ["plan"],
          properties: { plan: { type: "string", minLength: 1 } },
        },
      },
      {
        id: "approve",
        kind: "human.approval",
        dependsOn: ["plan"],
        retry: { maxAttempts: 1 },
        config: {
          summary: "Plan for ${{ inputs.goal }}\n${{ nodes.plan.outputs.plan }}\n",
          approverRoles: ["maintainer"],
          deadlineSeconds: 86400,
          onTimeout: "fail",
        },
      },
      {
        id: "build_until_verified",
        kind: "until",
        dependsOn: ["approve"],
        timeoutSeconds: 7200,
        config: {
          maxIterations: 4,
          maxDurationSeconds: 7200,
          passWhen:
            "nodes.test.outputs.result.successful == true && nodes.review.status == 'succeeded' && nodes.review.outputs.approved == true",
          carryForward: true,
          body: {
            nodes: [
              {
                id: "implement",
                kind: "agent.acp",
                retry: {
                  maxAttempts: 2,
                  backoff: { baseSeconds: 10, multiplier: 2, maxSeconds: 120, jitter: true },
                  retriableErrors: ["infra", "interrupted", "timeout", "agent_error"],
                },
                config: {
                  profile: "m4-implementer",
                  sessionMode: "resume_if_supported",
                  fallback: "new",
                  workspace: { mode: "run_workspace", repositories: ["${{ inputs.repository }}"] },
                  secretRefs: ["project/test-database-url"],
                  prompt:
                    "Implement the approved plan in repository ${{ inputs.repository }}.\nGoal: ${{ inputs.goal }}\nPrevious reviewer feedback: ${{ has(previous.review_feedback) ? previous.review_feedback : '(first iteration: no prior review)' }}\nReply with JSON {summary, files_changed} only.\n",
                },
                outputs: {
                  type: "object",
                  required: ["summary"],
                  properties: {
                    summary: { type: "string" },
                    files_changed: { type: "array", items: { type: "string" } },
                  },
                },
              },
              {
                id: "test",
                kind: "process.exec",
                dependsOn: ["implement"],
                timeoutSeconds: 900,
                retry: {
                  maxAttempts: 2,
                  backoff: { baseSeconds: 5, multiplier: 2, maxSeconds: 60, jitter: false },
                  retriableErrors: ["infra", "interrupted"],
                },
                config: {
                  executable: "go",
                  args: ["test", "./..."],
                  cwd: "repos/app",
                  workspace: { mode: "run_workspace", repositories: ["${{ inputs.repository }}"] },
                  outputExtraction: { mode: "json_from_path", path: "build/test-result.json" },
                },
                outputs: {
                  type: "object",
                  required: ["exit_code", "result"],
                  properties: {
                    exit_code: { type: "integer" },
                    result: {
                      type: "object",
                      required: ["successful"],
                      properties: {
                        successful: { type: "boolean" },
                        packages: { type: "array", items: { type: "object" } },
                      },
                    },
                  },
                },
              },
              {
                id: "review",
                kind: "agent.acp",
                dependsOn: ["test"],
                retry: {
                  maxAttempts: 2,
                  backoff: { baseSeconds: 10, multiplier: 2, maxSeconds: 120, jitter: true },
                  retriableErrors: [
                    "infra",
                    "interrupted",
                    "timeout",
                    "agent_error",
                    "invalid_output",
                  ],
                },
                config: {
                  profile: "m4-reviewer",
                  sessionMode: "new",
                  workspace: { mode: "read_only", repositories: ["${{ inputs.repository }}"] },
                  prompt:
                    "Decide whether the acceptance criteria are met.\nCriteria: ${{ inputs.acceptance_criteria }}\nTest result: ${{ nodes.test.outputs.result }}\nReply with JSON {approved, evidence, findings} only.\n",
                },
                outputs: {
                  type: "object",
                  required: ["approved", "evidence"],
                  properties: {
                    approved: { type: "boolean" },
                    evidence: { type: "string" },
                    findings: { type: "array", items: { type: "string" } },
                  },
                },
              },
            ],
          },
          resultBindings: {
            implementation_summary: "${{ nodes.implement.outputs.summary }}",
            review_feedback: "${{ nodes.review.outputs.evidence }}",
            approved: "${{ nodes.review.outputs.approved }}",
          },
        },
        outputs: {
          type: "object",
          required: ["iterations", "approved"],
          properties: {
            iterations: { type: "integer" },
            approved: { type: "boolean" },
            implementation_summary: { type: "string" },
            review_feedback: { type: "string" },
          },
        },
      },
      {
        id: "verdict",
        kind: "condition",
        dependsOn: ["build_until_verified"],
        config: {
          cases: [
            { when: "nodes.build_until_verified.outputs.approved == true", route: "verified" },
          ],
          default: "needs_attention",
        },
      },
      {
        id: "publish_verified",
        kind: "artifact.publish",
        dependsOn: ["verdict"],
        when: "nodes.verdict.outputs.route == 'verified'",
        config: {
          name: "review-evidence.md",
          kind: "markdown",
          mediaType: "text/markdown",
          sensitivity: "standard",
          from: { mode: "output_json", value: "${{ nodes.build_until_verified.outputs }}" },
        },
      },
      {
        id: "publish_needs_attention",
        kind: "artifact.publish",
        dependsOn: ["verdict"],
        when: "nodes.verdict.outputs.route == 'needs_attention'",
        config: {
          name: "needs-attention.json",
          kind: "json",
          mediaType: "application/json",
          sensitivity: "standard",
          from: { mode: "output_json", value: "${{ nodes.build_until_verified.outputs }}" },
        },
      },
    ],
    resultBindings: {
      implementation_summary: "${{ nodes.build_until_verified.outputs.implementation_summary }}",
      review_approved: "${{ nodes.build_until_verified.outputs.approved }}",
      iterations: "${{ nodes.build_until_verified.outputs.iterations }}",
    },
  },
} as unknown as DefinitionDocument;

/** The fan-out pipeline: `for_each` over 25 modules, one child run per item
 * (`03`'s invoke_policy: per_item). This is the W4/W7 shape. */
export const fanOutPipelineDocument = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "module-verification", description: "Verify every module in parallel." },
  spec: {
    policies: { maxConcurrentNodes: 3, maxChildDepth: 1, cancelPolicy: "cascade" },
    nodes: [
      { id: "inventory", kind: "process.exec", config: { executable: "ls", args: ["modules"] } },
      {
        id: "verify_each",
        kind: "for_each",
        dependsOn: ["inventory"],
        config: {
          items: "${{ nodes.inventory.outputs.rows }}",
          maxConcurrency: 3,
          invokePolicy: "per_item",
          body: { nodes: [] },
          child: { pipeline: "module-check", inputs: { module: "${{ item.name }}" } },
        },
      },
      {
        id: "collect",
        kind: "artifact.publish",
        dependsOn: ["verify_each"],
        config: {
          name: "verification.json",
          kind: "json",
          from: { mode: "output_json", value: "${{ nodes.verify_each.outputs }}" },
        },
      },
    ],
  },
} as unknown as DefinitionDocument;
