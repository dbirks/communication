/**
 * Reproducible OpenAPI type generation for `ui/src/api/schema.d.ts`.
 *
 * Why a script instead of the `openapi-typescript` binary directly: the app
 * builds on TypeScript 7 (native port), whose JS surface has no `ts.factory`,
 * and openapi-typescript 7.13 uses it (`dist/lib/ts.mjs`) — so the generator
 * must resolve *TypeScript 5.9.3*, which lives in the `tools/apigen` workspace
 * package. Running the binary from `ui/node_modules/.bin` picks the peer from
 * this package's own tree (7.0.2) and dies with
 * `Cannot read properties of undefined (reading 'createKeywordTypeNode')`.
 *
 * Usage:
 *   node scripts/gen-api.mjs            # write src/api/schema.d.ts
 *   node scripts/gen-api.mjs --check    # regenerate to a temp file and diff
 *
 * `--check` is the CI drift gate: the generated file is only trustworthy if
 * nobody hand-edits it, and the last M2 worker had to. Formatting is applied by
 * oxfmt in both paths, so the comparison is byte-for-byte.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(uiRoot, "..");
const specPath = join(repoRoot, "api", "openapi.yaml");
const committed = join(uiRoot, "src", "api", "schema.d.ts");
const apigenDir = join(uiRoot, "tools", "apigen");

const check = process.argv.includes("--check");
const require = createRequire(import.meta.url);

/** Absolute path of a package's bin script, resolved from `fromDir`'s tree. */
function binPathOf(packageName, binName, fromDir) {
  const manifest = require.resolve(`${packageName}/package.json`, { paths: [fromDir] });
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName];
  if (!bin) throw new Error(`${packageName} declares no bin "${binName}"`);
  return resolve(dirname(manifest), bin);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "signal"}`);
  }
}

const generator = binPathOf("openapi-typescript", "openapi-typescript", apigenDir);
const formatter = binPathOf("oxfmt", "oxfmt", uiRoot);

const outPath = check
  ? join(mkdtempSync(join(tmpdir(), "communication-gen-")), "schema.d.ts")
  : committed;

run(process.execPath, [generator, specPath, "-o", outPath], "openapi-typescript");
run(process.execPath, [formatter, outPath], "oxfmt");

if (!check) {
  console.log(`wrote ${committed}`);
  process.exit(0);
}

if (!existsSync(committed)) {
  console.error(`MISSING ${committed}: run \`pnpm gen:api\` and commit the result.`);
  process.exit(1);
}

const expected = readFileSync(outPath, "utf8");
const actual = readFileSync(committed, "utf8");
if (expected === actual) {
  console.log(`gen:api check passed: ${committed} matches api/openapi.yaml`);
  process.exit(0);
}

// Show the smallest useful diff: first differing line, plus how far apart the
// files are. A full unified diff of a 3500-line generated file is noise.
const expectedLines = expected.split("\n");
const actualLines = actual.split("\n");
let first = 0;
while (
  first < expectedLines.length &&
  first < actualLines.length &&
  expectedLines[first] === actualLines[first]
) {
  first += 1;
}
console.error(
  `DRIFT: ${committed} is not what api/openapi.yaml generates ` +
    `(${expectedLines.length} generated lines vs ${actualLines.length} on disk, ` +
    `first difference at line ${first + 1}).`,
);
console.error(`  generated: ${expectedLines[first] ?? "<eof>"}`);
console.error(`  on disk:   ${actualLines[first] ?? "<eof>"}`);
console.error("Run `pnpm gen:api` and commit the regenerated file. Never hand-edit schema.d.ts.");
process.exit(1);
