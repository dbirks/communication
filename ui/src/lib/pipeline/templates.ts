/**
 * The three vetted sample pipelines, offered in the library's "Start from"
 * picker so a new pipeline does not have to begin as a blank textarea.
 *
 * The YAML lives next to this file, imported with Vite's `?raw` suffix so the
 * document is inlined at build time — no fetch, no new dependency, and no
 * change to the build config. Two constraints shaped the location and the
 * extension: Vite refuses to import anything above the `ui/` fs root
 * (`Denied ID: …/docs/samples/home/plan-with-approval.yaml?raw`, because
 * `ui/pnpm-workspace.yaml` makes `ui/` that root), and `oxfmt` reindents any
 * `.yaml` it is pointed at — which would silently break byte equality with the
 * samples. So the copies are `*.yaml.txt`: invisible to the formatter, verbatim
 * to the bundler. Drift is not a review habit here —
 * `./templates/drift.test.ts` compares each copy to its `docs/samples/home/`
 * original byte-for-byte via `node:fs`, so the UI can only ship the exact bytes
 * `internal/pipelines/samples_test.go` compiles (loader + schema validator +
 * compiler, zero diagnostics) or CI goes red.
 *
 * One-line descriptions are the wording of `docs/samples/home/README.md`; the
 * honesty that matters and is repeated there: two samples run on the
 * home-cluster worker with no `agent.acp` node, `issue-to-pr` runs on pi
 * agents (the `pi` launcher, ADR-0059) with the allowlisted GitHub push token,
 * and none is scheduled — cron/timer triggers are M6, so a run starts by hand.
 */
import { parseGraph } from "./graphDoc";
import planWithApprovalYaml from "./templates/plan-with-approval.yaml.txt?raw";
import securityReviewYaml from "./templates/security-review.yaml.txt?raw";
import issueToPrYaml from "./templates/issue-to-pr.yaml.txt?raw";
import mattPocockSpecToPrYaml from "./templates/matt-pocock-spec-to-pr.yaml.txt?raw";
import pstackFeatureYaml from "./templates/pstack-feature.yaml.txt?raw";
import implementThenCodexReviewYaml from "./templates/implement-then-codex-review.yaml.txt?raw";

/**
 * The minimal skeleton every zero-document start posts as its first draft —
 * the Blank template and a "New draft" on a pipeline with no published
 * revision (which has nothing to clone). It is the document's top-level
 * shape only — `apiVersion`/`kind`/`metadata.name`/`spec` — with one node,
 * the smallest node list the schema's shape allows (a node needs only its
 * `id` and `kind`). It does not have to validate: a draft may be invalid,
 * and Validate is what judges it. `withMetadataName` rewrites the `name:`
 * line to the pipeline's slug, exactly as it does for the samples.
 */
export const BLANK_SKELETON_YAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: pipeline
spec:
  nodes:
    - id: first
      kind: process.exec
`;

export type TemplateId =
  | "blank"
  | "plan-with-approval"
  | "security-review"
  | "issue-to-pr"
  | "matt-pocock-spec-to-pr"
  | "pstack-feature"
  | "implement-then-codex-review";

/**
 * What the Workflows card says about the harnesses a template leans on: the
 * agent products its `agent.acp` nodes name (never a launcher id — a reader
 * picks "Claude Code", the profile picks the launcher), the APM collections its
 * profiles attach (ADR-0084), and the host facts a run needs that this
 * organization may not have yet. A template with an empty `agents` list runs
 * with no agent credentials at all; that is a selling point, not a gap, and the
 * `needs` lines say so in the reader's words.
 */
export interface PipelineTemplate {
  id: TemplateId;
  /** Option label in the picker. */
  label: string;
  /** One line (≤110 chars), from `docs/samples/home/README.md`. */
  description: string;
  /** Where the document comes from: the samples live in `docs/samples/home`, the skeleton is inlined above. */
  source: string;
  /**
   * The document a "New pipeline" from this template posts as its first
   * draft — never `null`: even Blank seeds the skeleton so a pipeline can
   * get its first draft through the UI.
   */
  documentYaml: string;
  /**
   * How many nodes the document renders on the Studio canvas — computed with
   * the same `parseGraph` the canvas parses with, so the number the library
   * advertises is the number Studio draws. `null` when the document does not
   * parse; the list never invents a count.
   */
  stepCount: number | null;
  /** Agent products the document names, in the order a reader meets them; empty when no node is `agent.acp`. */
  agents: string[];
  /** APM collection names the profiles attach (ADR-0084); empty when none. */
  collections: string[];
  /**
   * Host facts a run needs that the organization may not have: a login on the
   * worker, a token allowlisted to the profile. The card renders these dashed
   * and prefixed `needs ` — they are a prerequisite, not a feature.
   */
  needs: string[];
  /** The card's Tabler icon (the component name, resolved by the page). */
  icon: string;
}

export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "skeleton draft — the top-level shape and one node, then write the YAML yourself",
    source: "skeleton",
    documentYaml: BLANK_SKELETON_YAML,
    stepCount: stepCountOf(BLANK_SKELETON_YAML),
    agents: [],
    collections: [],
    needs: [],
    icon: "IconPlus",
  },
  {
    id: "plan-with-approval",
    label: "Plan with approval",
    description:
      "survey the checkout, plan with a model call, hold behind a maintainer approval, publish plan.md",
    source: "docs/samples/home",
    documentYaml: planWithApprovalYaml,
    stepCount: stepCountOf(planWithApprovalYaml),
    // No agent.acp node: the thinking step is one model.chat completion, so the
    // card names no agent and needs no harness login.
    agents: [],
    collections: [],
    needs: ["model endpoint"],
    icon: "IconNotebook",
  },
  {
    id: "security-review",
    label: "Security review",
    description:
      "sweep the checkout for credential-shaped literals and dangerous exec patterns, publish security-review.md",
    source: "docs/samples/home",
    documentYaml: securityReviewYaml,
    stepCount: stepCountOf(securityReviewYaml),
    agents: [],
    collections: [],
    needs: ["model endpoint"],
    icon: "IconShieldLock",
  },
  {
    id: "issue-to-pr",
    label: "Issue to draft PR",
    description:
      "plan a GitHub issue, approve the plan, implement with a pi agent, push and open a draft PR",
    source: "docs/samples/home",
    documentYaml: issueToPrYaml,
    stepCount: stepCountOf(issueToPrYaml),
    agents: ["Pi"],
    collections: [],
    needs: ["Pi agent key", "GitHub token"],
    icon: "IconGitPullRequest",
  },
  {
    id: "matt-pocock-spec-to-pr",
    label: "Matt Pocock: spec → tickets → PR",
    description:
      "write a spec with Matt Pocock's to-spec, approve it, cut tickets with to-tickets, implement, open a draft PR",
    source: "docs/samples/home",
    documentYaml: mattPocockSpecToPrYaml,
    stepCount: stepCountOf(mattPocockSpecToPrYaml),
    agents: ["Claude Code"],
    collections: ["Matt Pocock skills"],
    needs: ["Claude Code login", "GitHub token"],
    icon: "IconClipboardText",
  },
  {
    id: "pstack-feature",
    label: "pstack feature (poteto-mode)",
    description:
      "plan the feature on pstack's poteto-mode playbook, approve, implement, interrogate the diff, report",
    source: "docs/samples/home",
    documentYaml: pstackFeatureYaml,
    stepCount: stepCountOf(pstackFeatureYaml),
    agents: ["Claude Code"],
    collections: ["pstack (Claude Code)"],
    needs: ["Claude Code login"],
    icon: "IconStack2",
  },
  {
    id: "implement-then-codex-review",
    label: "Implement, then Codex review",
    description:
      "implement on Claude Code, review the diff on a read-only Codex profile, approve, publish review.md",
    source: "docs/samples/home",
    documentYaml: implementThenCodexReviewYaml,
    stepCount: stepCountOf(implementThenCodexReviewYaml),
    agents: ["Claude Code", "Codex"],
    collections: [],
    needs: ["Claude Code login", "Codex login"],
    icon: "IconEyeCheck",
  },
];

export function templateById(id: string): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.find((template) => template.id === id);
}

/** Node count of a template document as the Studio canvas would draw it. */
function stepCountOf(document: string): number | null {
  const parsed = parseGraph(document);
  return parsed.ok ? parsed.model.nodes.length : null;
}

/** The template document's own top-level chain — the node ids a reader sees
 * on the Studio canvas in definition order, a scope node folded to one
 * `loop: <child> · <child>…` cell, joined with `›`. Empty when the document
 * does not parse: a card then shows nothing rather than an invented step. */
export function templateChain(template: PipelineTemplate): string {
  const parsed = parseGraph(template.documentYaml);
  if (!parsed.ok) return "";
  const { nodes } = parsed.model;
  return nodes
    .filter((node) => node.scope.length === 0)
    .map((node) => {
      if (!node.isScope) return node.id;
      const children = nodes
        .filter((child) => child.scope.length > 0 && child.scope[0] === node.id)
        .map((child) => child.id)
        .join(" · ");
      return children ? `loop: ${children}` : node.id;
    })
    .join(" › ");
}

/** A description trimmed to its first sentence — the short form a card or
 * dialog line quotes. It is a cut of the metadata, never a second
 * hand-written copy that can drift from the sample it names. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^(.+?[.!?])(?:\s|$)/u.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

/**
 * The template's document with the single `name:` line under `metadata:`
 * rewritten to the new pipeline's slug, so the pasted document agrees with the
 * definition the server just created. Only that line moves: the samples'
 * comments, node ids and bindings stay byte-for-byte what the Go test compiled.
 * A document with no `metadata:` block is returned untouched.
 */
export function withMetadataName(document: string, name: string): string {
  const lines = document.split("\n");
  let inMetadata = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!inMetadata) {
      if (/^metadata:[ \t]*(#.*)?$/.test(line)) inMetadata = true;
      continue;
    }
    // The block ends at the first line that is neither blank nor indented.
    if (line !== "" && !/^[ \t]/.test(line)) break;
    const match = /^([ \t]+)name:[ \t]*.*$/.exec(line);
    if (!match) continue;
    lines[index] = `${match[1]}name: ${quoteScalar(name)}`;
    return lines.join("\n");
  }
  return document;
}

/** Plain style for a slug; quoted when the slug could otherwise parse as
 * something else — a leading digit is an int/float in YAML, and the empty
 * string, `true`, `null` and `~` are not slugs a name should silently become. */
function quoteScalar(value: string): string {
  if (
    /^[A-Za-z][A-Za-z0-9._ -]*$/.test(value) &&
    !/^(?:true|false|null|yes|no|on|off)$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}
