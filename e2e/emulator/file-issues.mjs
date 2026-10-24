#!/usr/bin/env node
// file-issues.mjs — turn a pass's defect records into GitHub issues.
//
//   node emulator/file-issues.mjs out/<passId>            (files the issues)
//   node emulator/file-issues.mjs --dry-run out/<passId>  (prints them)
//
// One issue per defect FINGERPRINT that has not been filed yet: the
// fingerprint is stable across passes (it strips uuids/numbers from the
// detail), so a defect that keeps recurring does not keep filing — it is
// already open (or closed) and is skipped. A fix must close the issue; the
// next pass re-files it if the defect returns.
//
// Only shells out to `gh`; never reads or prints anything from the browser
// (no cookies, tokens, env values) — the issue body is built exclusively
// from the recorded defect fields.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO = "dbirks/communication";
const LABEL = "emulator";
const DRY_RUN = process.argv.includes("--dry-run");
const arg = process.argv.slice(2).find((item) => !item.startsWith("-"));

if (!arg) {
  console.error("usage: node emulator/file-issues.mjs [--dry-run] out/<passId>");
  process.exit(2);
}
const dir = path.resolve(process.cwd(), arg);
const resultsFile = path.join(dir, "results.json");

let lines = [];
try {
  lines = readFileSync(resultsFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
} catch (error) {
  console.error(`file-issues: cannot read ${resultsFile}: ${error.message}`);
  process.exit(2);
}

/** One defect per fingerprint (a pass can record the same defect twice). */
const unique = [
  ...new Map(
    lines.filter((entry) => entry.type === "defect").map((d) => [d.fingerprint, d]),
  ).values(),
];

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// The label, once (gh label create is a no-op failure when it exists).
if (!DRY_RUN) {
  try {
    gh(["label", "create", LABEL, "--color", "BFD4F2", "-R", REPO]);
  } catch {
    // already exists — that is the expected steady state
  }
}

let filed = 0;
let skipped = 0;
for (const defect of unique) {
  let already = false;
  try {
    const list = gh([
      "issue",
      "list",
      "-R",
      REPO,
      "--label",
      LABEL,
      "--state",
      "all",
      "--search",
      defect.fingerprint,
      "--json",
      "number",
    ]);
    already = JSON.parse(list.length > 0 ? list : "[]").length > 0;
  } catch {
    // gh failed (no auth, network) — treat as unknown: still file, so a
    // transient gh outage does not swallow the defect
  }
  if (already) {
    skipped += 1;
    console.log(`skip  ${defect.fingerprint} (${defect.kind} on ${defect.screen}) — already filed`);
    continue;
  }

  const title = `[emulator] ${defect.kind} on ${defect.screen}: ${defect.detail.slice(0, 80)}`;
  const body = [
    "Emulator defect — filed automatically by `e2e/emulator/file-issues.mjs`.",
    "",
    `- **journey**: ${defect.journey}`,
    `- **screen**: ${defect.screen}`,
    `- **viewport**: ${defect.viewport}`,
    `- **kind**: ${defect.kind}`,
    `- **pass**: ${defect.pass ?? path.basename(dir)}`,
    "",
    "**detail**",
    "```",
    defect.detail,
    "```",
    "",
    `fingerprint: ${defect.fingerprint}`,
    "",
    `screenshot: ${defect.screenshot ? `${path.basename(dir)}/${defect.screenshot}` : "(none)"}`,
    "",
    "<!-- The pass output (screenshots + results.json) lives in e2e/emulator/out/<pass>/ on the lab. -->",
  ].join("\n");

  if (DRY_RUN) {
    filed += 1;
    console.log(`would file  ${defect.fingerprint}`);
    console.log(`  title: ${title}`);
    console.log(body);
    console.log("---");
    continue;
  }
  try {
    const url = gh([
      "issue",
      "create",
      "-R",
      REPO,
      "--label",
      LABEL,
      "--title",
      title,
      "--body",
      body,
    ]);
    filed += 1;
    console.log(
      `filed ${defect.fingerprint} (${defect.kind} on ${defect.screen}) -> ${url.split("\n").pop()}`,
    );
  } catch (error) {
    console.error(`FAILED to file ${defect.fingerprint}: ${String(error.message).split("\n")[0]}`);
  }
}

console.log(
  `file-issues: ${filed} ${DRY_RUN ? "would be filed" : "filed"}, ${skipped} already filed`,
);
