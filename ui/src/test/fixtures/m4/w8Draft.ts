/**
 * The W8 document — the "authored YAML with the seven deferred kinds plus the
 * config typos" of `docs/m4-contract.md` § 7.2 W8, and the findings the server
 * answers it with.
 *
 * Both halves live in one file on purpose: a finding whose `instance_location`
 * points into a *different* document would make the viewer mark unrelated lines,
 * which is exactly the failure the viewer exists to avoid. The errors are in
 * the order § 2.2 fixes — `(instance_location, schema_location, code, message)`
 * — and note that this sorts `/spec/nodes/10` before `/spec/nodes/2`: the
 * server sorts text, and so does the list here.
 */
import type { ValidateBody } from "../../../lib/pipeline/contract";

/** Authored (not canonical): an `until` body, the seven deferred kinds, and the
 * mistakes W8 pastes in. `draft`'s prompt is where the secret-literal detector
 * fires; no credential-shaped string is in this file, so the finding is
 * illustrated by its location and hint rather than by a pasted value.
 *
 * The duplicated `timeoutSeconds` on `plan` is a loader
 * error, so it exists only in the text — `w8DraftDocument` is what a parsed
 * document of the same shape looks like. */
export const w8DraftYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: w8-draft
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal: {type: string}
  policies:
    maxConcurrentNodes: 2
    maxChildDepth: 0
  nodes:
  - id: plan
    kind: agent.acp
    timeoutSeconds: 900
    timeoutSeconds: 1200
    config:
      profile: m4-planner
      prompt: 'Plan for \${{ inputs.goal }}'
  - id: summarize
    kind: human.approval
    dependsOn: [plan]
    config:
      summary: |
        Plan for \${{ inputs.goal }}
        \${{ nodes.plan.outputs.plan }}
        and then a third reference that pushes this binding past the per-expression
        bound the compiler enforces, which is what makes the whole summary one
        oversized expression rather than three small ones at all
      approverRoles: [maintainer]
      deadlineSeconds: 3600
      onTimeout: fail
  - id: draft
    kind: agent.acp
    dependsOn: [summarize]
    config:
      profile: m4-implementer
      prompt: |
        Implement it against the literal this draft pasted in place of a secretRef
        (the value is elided from the fixture — AGENTS.md forbids a credential-shaped
        string here, and the server would redact it in the response too).
        Reply with JSON {summary} only.
  - id: verify
    kind: until
    dependsOn: [draft]
    config:
      maxIterations: 3
      maxParallelism: 2
      passWhen: nodes.test.outputs.ok) == true
      body:
        nodes:
        - id: implement
          kind: agent.acp
          config:
            profile: m4-implementer
            prompt: |
              Carry on from \${{ loop.review_feedback }}
        - id: test
          kind: process.exec
          dependsOn: [implement]
          config:
            executable: go
            args: [test, ./...]
        - id: review
          kind: agent.acp
          dependsOn: [approve]
          config:
            profile: m4-reviewer
            prompt: 'Review \${{ inputs.goal }}'
  - id: fan
    kind: parallel
    dependsOn: [verify]
    config:
      maxConcurrency: 4
      body:
        nodes:
        - id: lint
          kind: process.exec
          config:
            executable: pnpm
            args: [lint]
  - id: meet
    kind: join
    dependsOn: [fan]
    config:
      waits_for: [fan]
      mode: all
  - id: sign_off
    kind: gate
    dependsOn: [meet]
    config:
      message: 'Promote \${{ inputs.goal }}?'
      approval:
        approverRoles: [owner]
        deadlineSeconds: 3600
  - id: commit
    kind: git.commit
    dependsOn: [sign_off]
    config:
      message: 'w8: draft'
  - id: push
    kind: git.publish
    dependsOn: [commit]
    config:
      remote: origin
      branch: w8
  - id: lookup
    kind: integration.query
    dependsOn: [push]
    config:
      provider: github
      query: 'pr for w8'
  - id: open_pr
    kind: integration.action
    dependsOn: [lookup]
    config:
      provider: github
      action: pr.open
`;

/** The same document read as JSON, for the graph: eleven nodes, seven of which
 * the compiler will refuse (ADR-0024 § 2). */
export const w8DraftDocument = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "w8-draft" },
  spec: {
    policies: { maxConcurrentNodes: 2, maxChildDepth: 0 },
    nodes: [
      {
        id: "plan",
        kind: "agent.acp",
        config: { profile: "m4-planner", prompt: "Plan for ${{ inputs.goal }}" },
      },
      {
        id: "summarize",
        kind: "human.approval",
        dependsOn: ["plan"],
        config: {
          summary:
            "Plan for ${{ inputs.goal }} ${{ nodes.plan.outputs.plan }} and then a third reference that pushes this binding past the per-expression bound",
        },
      },
      {
        id: "draft",
        kind: "agent.acp",
        dependsOn: ["summarize"],
        config: {
          profile: "m4-implementer",
          prompt:
            "Implement it against the literal this draft pasted in place of a secretRef. Reply with JSON {summary} only.",
        },
      },
      {
        id: "verify",
        kind: "until",
        dependsOn: ["draft"],
        config: {
          maxIterations: 3,
          maxParallelism: 2,
          passWhen: "nodes.test.outputs.ok) == true",
          body: {
            nodes: [
              {
                id: "implement",
                kind: "agent.acp",
                config: {
                  profile: "m4-implementer",
                  prompt: "Carry on from ${{ loop.review_feedback }}",
                },
              },
              {
                id: "test",
                kind: "process.exec",
                dependsOn: ["implement"],
                config: { executable: "go", args: ["test", "./..."] },
              },
              {
                id: "review",
                kind: "agent.acp",
                dependsOn: ["approve"],
                config: { profile: "m4-reviewer", prompt: "Review ${{ inputs.goal }}" },
              },
            ],
          },
        },
      },
      {
        id: "fan",
        kind: "parallel",
        dependsOn: ["verify"],
        config: {
          maxConcurrency: 4,
          body: {
            nodes: [
              { id: "lint", kind: "process.exec", config: { executable: "pnpm", args: ["lint"] } },
            ],
          },
        },
      },
      { id: "meet", kind: "join", dependsOn: ["fan"], config: { waits_for: ["fan"], mode: "all" } },
      {
        id: "sign_off",
        kind: "gate",
        dependsOn: ["meet"],
        config: { message: "Promote ${{ inputs.goal }}?" },
      },
      {
        id: "commit",
        kind: "git.commit",
        dependsOn: ["sign_off"],
        config: { message: "w8: draft" },
      },
      {
        id: "push",
        kind: "git.publish",
        dependsOn: ["commit"],
        config: { remote: "origin", branch: "w8" },
      },
      {
        id: "lookup",
        kind: "integration.query",
        dependsOn: ["push"],
        config: { provider: "github", query: "pr for w8" },
      },
      {
        id: "open_pr",
        kind: "integration.action",
        dependsOn: ["lookup"],
        config: { provider: "github", action: "pr.open" },
      },
    ],
  },
} as unknown as import("../../../lib/pipeline/definition").DefinitionDocument;

/**
 * W8's answer to that document. Sorted the way § 2.2 sorts it, with the loader
 * finding first because loader rules gate the JSON the schema ever sees.
 */
export const w8Validation: ValidateBody = {
  valid: false,
  revision_digest: null,
  plan_digest: null,
  digest_scope: "v1alpha1-canonical-1",
  notes: ["aliases and merge keys were expanded before hashing; the export is regenerated"],
  errors: [
    {
      code: "duplicate_key",
      source: "loader",
      message: 'mapping key "timeoutSeconds" already defined earlier in this mapping',
      instance_location: "/spec/nodes/0",
      schema_location: null,
      hint: null,
    },
    {
      code: "expression_too_large",
      source: "compiler",
      message: "expression is 842 bytes, over the 512-byte bound",
      instance_location: "/spec/nodes/1/config/summary",
      schema_location: null,
      hint: null,
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind integration.action is not implemented until M6",
      instance_location: "/spec/nodes/10",
      schema_location: null,
      hint: null,
    },
    {
      code: "secret_literal_detected",
      source: "compiler",
      message: "the scanned scalar shape looks like a credential literal (value redacted)",
      instance_location: "/spec/nodes/2/config/prompt",
      schema_location: null,
      hint: "reference it instead: secretRefs: [project/database-url] — publish is refused while a literal is present (ADR-0021)",
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind parallel is not implemented until M5",
      instance_location: "/spec/nodes/4",
      schema_location: null,
      hint: null,
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind join is not implemented until M5",
      instance_location: "/spec/nodes/5",
      schema_location: null,
      hint: null,
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind gate is not implemented until M5",
      instance_location: "/spec/nodes/6",
      schema_location: null,
      hint: null,
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind git.commit is not implemented until M6",
      instance_location: "/spec/nodes/7",
      schema_location: null,
      hint: null,
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind git.publish is not implemented until M6",
      instance_location: "/spec/nodes/8",
      schema_location: null,
      hint: null,
    },
    {
      code: "kind_not_implemented",
      source: "compiler",
      message: "kind integration.query is not implemented until M6",
      instance_location: "/spec/nodes/9",
      schema_location: null,
      hint: null,
    },
    {
      code: "schema_shape",
      source: "schema",
      message: "/spec/nodes/3/config: unknown property maxParallelism (got integer)",
      instance_location: "/spec/nodes/3/config",
      schema_location: "#/$defs/node/$defs/config",
      hint: "there is no such property; the bound a for_each takes is maxConcurrency",
    },
    {
      code: "cel_compile_error",
      source: "schema",
      message: "invalid expression syntax: unexpected token ) at offset 24",
      instance_location: "/spec/nodes/3/config/passWhen",
      schema_location: "#/$defs/cel",
      hint: null,
    },
    {
      code: "depends_on_outside_scope",
      source: "compiler",
      message: 'body node "review" depends on "summarize", which lives outside the until scope',
      instance_location: "/spec/nodes/3/config/body/nodes/2",
      schema_location: null,
      hint: "a body node may only name a body node; the scope node itself carries the outside dependency",
    },
    {
      code: "undeclared_root",
      source: "schema",
      message:
        'undeclared reference "loop": the in-body root is named previous, and iteration 1 has no previous',
      instance_location: "/spec/nodes/3/config/body/nodes/0/config/prompt",
      schema_location: "#/$defs/cel",
      hint: "use has(previous.x) ? previous.x : fallback to make iteration 1 legal",
    },
  ],
};

/** A document with no findings at all, for the valid-draft state. */
export const validValidation: ValidateBody = {
  valid: true,
  revision_digest: "sha256:3f2f6e6a7ad1b1d8f4f3f4e4f9dfaf2b6bb2f43f4e4b41d8e4f4d2f4f4d4f4ab",
  plan_digest: "sha256:0d0c7b3a6a5b4f2e1d0c9b8a7f6e5d4c3b2a190817161514131211100f0e0d0c",
  digest_scope: "v1alpha1-canonical-1",
  errors: [],
  notes: [],
};
