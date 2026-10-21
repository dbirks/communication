/**
 * The Steps page's kind families and per-kind config summaries (design 3b).
 *
 * A step is a node template: the family is a presentation grouping over the
 * v1alpha1 `kind` catalogue. `configSummary` is the one-line "what does it
 * do" a 40px row carries — profile for agent steps, command for exec, and so
 * on. It is computed from the revision's `config` object only: nothing here
 * invents values, an absent key renders nothing.
 */

export type StepFamily = "AGENT" | "CHECK" | "GATE" | "PUBLISH" | "LOOP" | "WORKFLOW" | "OTHER";

/** Presentation order: the artboard's group order, OTHER last. */
export const FAMILY_ORDER: StepFamily[] = [
  "AGENT",
  "CHECK",
  "GATE",
  "PUBLISH",
  "LOOP",
  "WORKFLOW",
  "OTHER",
];

const FAMILY_OF_KIND: Record<string, StepFamily> = {
  "agent.acp": "AGENT",
  "model.chat": "AGENT",
  "process.exec": "CHECK",
  condition: "CHECK",
  "human.approval": "GATE",
  "git.publish": "PUBLISH",
  "artifact.publish": "PUBLISH",
  until: "LOOP",
  for_each: "LOOP",
  "pipeline.invoke": "WORKFLOW",
};

export function familyOf(kind: string): StepFamily {
  return FAMILY_OF_KIND[kind] ?? "OTHER";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The row's config summary from a revision's `config` (never from a
 * revision that has not loaded — the caller renders nothing until it has
 * the content). `null` = nothing recognizable to summarize.
 */
export function configSummary(kind: string, config: Record<string, unknown>): string | null {
  switch (kind) {
    case "agent.acp": {
      const profile = str(config["profile"]);
      const mode = str(config["workspace_mode"]);
      return profile ? (mode ? `${profile} · ${mode}` : profile) : null;
    }
    case "model.chat": {
      const model = str(config["model"]);
      return model ? `model ${model}` : null;
    }
    case "process.exec": {
      const exe = str(config["executable"]);
      const args = config["args"];
      const joined = Array.isArray(args) ? args.map((a) => str(a) ?? String(a)).join(" ") : "";
      const command = [exe, joined].filter(Boolean).join(" ");
      return command !== "" ? command : null;
    }
    case "condition": {
      const cases = config["cases"];
      return Array.isArray(cases) && cases.length > 0 ? `${cases.length} cases` : null;
    }
    case "human.approval": {
      const timeout = str(config["timeout"]);
      return timeout ? `timeout ${timeout}` : null;
    }
    case "until": {
      const max = config["maxIterations"];
      return typeof max === "number" ? `max ${max}` : null;
    }
    case "for_each": {
      const items = str(config["items"]);
      return items ? `items ${items}` : null;
    }
    case "pipeline.invoke": {
      const pipeline = str(config["pipeline"]);
      return pipeline ? pipeline : null;
    }
    default: {
      // Any other kind: fall back to the first string-valued config key.
      for (const [key, value] of Object.entries(config)) {
        const s = str(value);
        if (s) return `${key} ${s}`;
      }
      return null;
    }
  }
}

/**
 * The "Edit for all → version x.y.z" suggestion: a patch bump of the
 * current version label (`1.0.0` → `1.0.1`). A non-semantic label gets no
 * invented structure — the caller shows the label untouched with no bump
 * (`bumpSemver("draft")` → null).
 */
export function bumpSemver(label: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(label.trim());
  if (!match) return null;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
