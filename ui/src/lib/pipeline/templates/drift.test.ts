/**
 * Drift guard for the six bundled sample documents.
 *
 * `ui/src/lib/pipeline/templates/*.yaml.txt` are copies of
 * `docs/samples/home/*.yaml` — each is one row of the sample list they name,
 * byte-for-byte, and every one of those files is compiled by the Go test.
 *
 * They exist only because Vite refuses to import a
 * file above the `ui/` fs root (`Denied ID: …/plan-with-approval.yaml?raw`) and
 * the build config is not this change's to touch, and they end in `.txt`
 * because `oxfmt` reindents a `.yaml` copy, which is exactly the drift this
 * test is here to catch. The copies are otherwise a liability:
 * the docs files are the bytes `internal/pipelines/samples_test.go` compiles
 * (loader + schema validator + compiler, zero diagnostics), so a silent edit
 * here would put an uncompiled pipeline behind the "Start from" picker. This
 * test compares the actual bytes, so the copies cannot drift.
 *
 * `node:fs` is reached by a runtime-resolved dynamic import and given local
 * types: this project's tsconfig sets `types: ["vite/client"]`, so
 * `@types/node` is out of the program and no new dependency may be added here.
 */
import { describe, expect, it } from "vitest";
import { PIPELINE_TEMPLATES, withMetadataName } from "../templates";

declare const process: { cwd(): string };

interface NodeFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Uint8Array;
}

/** Resolved at runtime only — a literal specifier would be typechecked away. */
async function nodeFs(): Promise<NodeFs> {
  const specifier = "node:fs";
  return import(specifier) as unknown as NodeFs;
}

/** `join` without `@types/node`. */
function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** Up from vitest's cwd (`ui/`) to the repo root, which owns `docs/`. */
function docsDir(fs: NodeFs, start: string): string {
  for (let dir = start; dir.length > 1; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    const candidate = join(dir, "docs", "samples", "home");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no docs/samples/home above ${start} — did the sample authority move?`);
}

function bundledBytes(slug: string): Uint8Array {
  const template = PIPELINE_TEMPLATES.find((candidate) => candidate.id === slug);
  expect(template, `template ${slug} is offered`).toBeDefined();
  return new TextEncoder().encode(template?.documentYaml ?? "");
}

function bundledDescription(slug: string): string {
  const template = PIPELINE_TEMPLATES.find((candidate) => candidate.id === slug);
  return template?.description ?? "";
}

const SAMPLES = [
  "plan-with-approval",
  "security-review",
  "issue-to-pr",
  "matt-pocock-spec-to-pr",
  "pstack-feature",
  "implement-then-codex-review",
] as const;

describe("bundled pipeline templates", () => {
  it.each(SAMPLES)("is byte-identical to docs/samples/home/%s.yaml", async (slug) => {
    const fs = await nodeFs();
    const original = fs.readFileSync(join(docsDir(fs, process.cwd()), `${slug}.yaml`));
    // Byte-for-byte, as an array of octets: a changed comment, a dropped
    // trailing newline or a CRLF conversion all fail here.
    expect(Array.from(bundledBytes(slug))).toEqual(Array.from(original));
  });

  it.each(SAMPLES)("quotes a card line its README row carries: %s", async (slug) => {
    // The gallery's one-line description is NOT a second copy writers maintain:
    // `docs/samples/home/README.md` owns it, and this reads the docs file so a
    // reworded row that the card never picked up goes red here.
    const fs = await nodeFs();
    const readme = new TextDecoder().decode(
      fs.readFileSync(join(docsDir(fs, process.cwd()), "README.md")),
    );
    expect(readme).toContain(bundledDescription(slug));
  });

  it("ships the six samples plus Blank, and only Blank is the skeleton", () => {
    expect(PIPELINE_TEMPLATES.map((template) => template.id)).toEqual([
      "blank",
      "plan-with-approval",
      "security-review",
      "issue-to-pr",
      "matt-pocock-spec-to-pr",
      "pstack-feature",
      "implement-then-codex-review",
    ]);
    // Blank seeds its first draft from the inlined skeleton, not from a
    // sample; the six samples stay byte-identical to `docs/samples/home/`.
    expect(PIPELINE_TEMPLATES.map((template) => template.source)).toEqual([
      "skeleton",
      "docs/samples/home",
      "docs/samples/home",
      "docs/samples/home",
      "docs/samples/home",
      "docs/samples/home",
      "docs/samples/home",
    ]);
    expect(PIPELINE_TEMPLATES[0]?.documentYaml).toContain("kind: Pipeline");
  });
});

describe("template card facts", () => {
  // The Workflows card grid reads these four lists, so they are the card's
  // contract: a description long enough to need a third line, an agent word that
  // names a launcher instead of a product, or an icon that is not a Tabler name
  // all show up as a card that lies about the pipeline behind it.
  const AGENTS = ["Claude Code", "Codex", "Pi"];

  it("keeps every description one short line", () => {
    for (const template of PIPELINE_TEMPLATES) {
      expect(template.description, `${template.id} has a description`).not.toBe("");
      expect(template.description).not.toMatch(/\n/);
      expect(template.description.length, `${template.id}'s description`).toBeLessThanOrEqual(110);
    }
  });

  it("names agents from the product vocabulary only", () => {
    for (const template of PIPELINE_TEMPLATES) {
      for (const agent of template.agents) {
        expect(AGENTS, `${template.id} names ${agent}`).toContain(agent);
      }
      // An agent list is only ever non-empty when the document actually carries
      // an `agent.acp` node — the credential-free samples say so on the card.
      const namesAgentNode = /kind: agent\.acp/.test(template.documentYaml);
      expect(template.agents.length > 0, `${template.id}'s agent chips`).toBe(namesAgentNode);
    }
  });

  it("carries a Tabler icon name and the needs a run has", () => {
    for (const template of PIPELINE_TEMPLATES) {
      expect(template.icon).toMatch(/^Icon[A-Z]/);
      for (const need of template.needs) {
        expect(need).not.toBe("");
        // Needs read as the card's dashed `needs …` chip, so they are words for a
        // person, not an env var name.
        expect(need, `${template.id} needs ${need}`).not.toMatch(/[A-Z_]{4,}|\$\{\{/);
      }
      expect(template.collections.every((name) => name !== "")).toBe(true);
    }
    // The three collection-era templates say which bundle they attach, and the
    // Codex one says what it fails closed without.
    expect(
      PIPELINE_TEMPLATES.find((template) => template.id === "matt-pocock-spec-to-pr")?.collections,
    ).toEqual(["Matt Pocock skills"]);
    expect(
      PIPELINE_TEMPLATES.find((template) => template.id === "pstack-feature")?.collections,
    ).toEqual(["pstack (Claude Code)"]);
    expect(
      PIPELINE_TEMPLATES.find((template) => template.id === "implement-then-codex-review")?.needs,
    ).toContain("Codex login");
  });

  it("counts the nodes the cards advertise", () => {
    // The card's `TEMPLATE · N STEPS` line and the dialog's `N steps` line both
    // read `stepCount`, so a wrong count is wrong twice. The three new samples
    // are the chains ADR-0084 names.
    expect(
      PIPELINE_TEMPLATES.find((template) => template.id === "matt-pocock-spec-to-pr")?.stepCount,
    ).toBe(5);
    expect(PIPELINE_TEMPLATES.find((template) => template.id === "pstack-feature")?.stepCount).toBe(
      6,
    );
    expect(
      PIPELINE_TEMPLATES.find((template) => template.id === "implement-then-codex-review")
        ?.stepCount,
    ).toBe(4);
  });
});

describe("withMetadataName", () => {
  const plan = PIPELINE_TEMPLATES[1]?.documentYaml ?? "";

  it("moves only the metadata name", () => {
    const rewritten = withMetadataName(plan, "nightly-sweep");
    expect(rewritten.split("\n").length).toBe(plan.split("\n").length);
    // Every other line — comments, the artifact's `name: plan.md`, bindings —
    // is untouched, so the document that compiles is still the one that ran.
    const moved = rewritten
      .split("\n")
      .filter((line, index) => line !== plan.split("\n")[index])
      .map((line) => line.trim());
    expect(moved).toEqual(["name: nightly-sweep"]);
  });

  it("quotes a slug YAML would otherwise type as something else", () => {
    // A leading digit is an int in YAML; `metadata.name` is a string.
    expect(
      withMetadataName(plan, "40-sweep")
        .match(/^ {2}name: .*$/m)?.[0]
        .trim(),
    ).toBe('name: "40-sweep"');
    expect(
      withMetadataName(plan, "true")
        .match(/^ {2}name: .*$/m)?.[0]
        .trim(),
    ).toBe('name: "true"');
  });

  it("leaves a document with no metadata block alone", () => {
    expect(withMetadataName("kind: Pipeline\nspec: {}\n", "whatever")).toBe(
      "kind: Pipeline\nspec: {}\n",
    );
  });
});
