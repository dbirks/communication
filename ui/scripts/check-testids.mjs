// Guard for the design-system restyle: no data-testid may disappear.
//
// The Playwright suites in `e2e/` and the vitest suites in `ui/src` find
// elements by test id, so a restyle that renames or drops one breaks them
// silently. This script compares the ids *defined* by the components (not the
// ones asserted by tests) against a git revision — HEAD by default — and fails
// when any id that existed there is gone. New ids are allowed.
//
// Ids come from the components in four shapes:
//   data-testid="x" | data-testid={"x"} | "data-testid": "x" | testid = "x"
// and template ids (`data-testid={`repo-row-${name}`}`) compare as the literal
// prefix `repo-row-*`.
//
// Usage: node scripts/check-testids.mjs [rev]   (rev default: HEAD)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rev = process.argv[2] ?? "HEAD";
const uiRoot = join(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = join(uiRoot, "..");
const srcDir = join(uiRoot, "src");

const isTest = (path) => /\.test\.tsx?$/.test(path);

/** Every non-test .ts/.tsx file under ui/src. */
function workSources() {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(full) && !isTest(full)) files.push(full);
    }
  };
  visit(srcDir);
  return files.map((path) => [relative(uiRoot, path), readFileSync(path, "utf8")]);
}

function revSources(revision) {
  const listing = execFileSync("git", ["grep", "-l", "testid", revision, "--", "ui/src"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((path) => !isTest(path));
  return listing.map((path) => [
    relative("ui", path.replace(/^[^:]+:/, "")),
    execFileSync("git", ["show", path], { cwd: repoRoot, encoding: "utf8" }),
  ]);
}

/** Ids defined by a set of sources, sorted. */
export function definedIds(sources) {
  const ids = new Set();
  for (const [, src] of sources) {
    for (const m of src.matchAll(/"?(?:data-testid|testid)"?\s*[=:]\s*\{?\s*"([^"]+)"/g)) {
      ids.add(m[1]);
    }
    for (const m of src.matchAll(/"?(?:data-testid|testid)"?\s*[=:]\s*\{?\s*`([^`$]*)\$\{/g)) {
      ids.add(`${m[1]}*`);
    }
  }
  return [...ids].sort();
}

const before = definedIds(revSources(rev));
const after = definedIds(workSources());

const lost = before.filter((id) => !after.includes(id));
const added = after.filter((id) => !before.includes(id));
console.log(`${rev}: ${before.length} test ids | work: ${after.length} test ids`);
if (added.length) console.log(`added: ${added.join(", ")}`);
if (lost.length) {
  console.error(`LOST test ids: ${lost.join(", ")}`);
  process.exit(1);
}
console.log(`OK: every test id defined in ${rev} is still defined in ui/src`);
