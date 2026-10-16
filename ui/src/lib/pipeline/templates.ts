/**
 * The two vetted sample pipelines, offered in the library's "Start from"
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
 * honesty that matters and is repeated there: both samples run on the
 * home-cluster worker with no `agent.acp` node, and neither is scheduled —
 * cron/timer triggers are M6, so a run starts by hand.
 */
import planWithApprovalYaml from "./templates/plan-with-approval.yaml.txt?raw";
import securityReviewYaml from "./templates/security-review.yaml.txt?raw";

export type TemplateId = "blank" | "plan-with-approval" | "security-review";

export interface PipelineTemplate {
  id: TemplateId;
  /** Option label in the picker. */
  label: string;
  /** One line, from `docs/samples/home/README.md`. */
  description: string;
  /** The sample document, or `null` for Blank (which creates no draft). */
  documentYaml: string | null;
}

export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "empty draft — write the YAML yourself",
    documentYaml: null,
  },
  {
    id: "plan-with-approval",
    label: "Plan with approval",
    description:
      "inputs goal, repository: survey the checkout, plan with a chat model, hold behind a maintainer approval, publish plan.md",
    documentYaml: planWithApprovalYaml,
  },
  {
    id: "security-review",
    label: "Security review",
    description:
      "input repository: sweep the checkout for credential-shaped literals and dangerous exec patterns, grade findings by severity, publish security-review.md",
    documentYaml: securityReviewYaml,
  },
];

export function templateById(id: string): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.find((template) => template.id === id);
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
