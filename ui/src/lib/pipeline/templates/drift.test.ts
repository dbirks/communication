/**
 * Drift guard for the two bundled sample documents.
 *
 * `ui/src/lib/pipeline/templates/*.yaml.txt` are copies of
 * `docs/samples/home/*.yaml` — they exist only because Vite refuses to import a
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

const SAMPLES = ["plan-with-approval", "security-review"] as const;

describe("bundled pipeline templates", () => {
  it.each(SAMPLES)("is byte-identical to docs/samples/home/%s.yaml", async (slug) => {
    const fs = await nodeFs();
    const original = fs.readFileSync(join(docsDir(fs, process.cwd()), `${slug}.yaml`));
    // Byte-for-byte, as an array of octets: a changed comment, a dropped
    // trailing newline or a CRLF conversion all fail here.
    expect(Array.from(bundledBytes(slug))).toEqual(Array.from(original));
  });

  it("ships the two samples plus Blank, and only Blank has no document", () => {
    expect(PIPELINE_TEMPLATES.map((template) => template.id)).toEqual([
      "blank",
      "plan-with-approval",
      "security-review",
    ]);
    expect(PIPELINE_TEMPLATES[0]?.documentYaml).toBeNull();
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
