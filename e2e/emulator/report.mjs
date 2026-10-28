#!/usr/bin/env node
// report.mjs — render one emulator pass into an HTML review page.
//
//   node emulator/report.mjs out/<passId>        (from e2e/, or any cwd)
//
// Reads out/<passId>/results.json (one JSON object per line: screens and
// defects, written by the emu fixture), writes out/<passId>/index.html —
// a per-screen PASS/FAIL table (sidescroll/parity/clip/target/overlap per
// width, plus the design-landmark column and the no-made-up-data column) up
// top, then the defects, then one row per screen with the app screenshot
// beside its design render (both scaled to 50%) — and prints the summary
// line `PASS <id>: <n> screens, <m> defects`.
//
// Exit code 0 when the pass has zero defects, 1 otherwise (loop.sh reads
// the defect count itself, but the code is the pass's verdict).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node emulator/report.mjs out/<passId>");
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
  console.error(`report: cannot read ${resultsFile}: ${error.message}`);
  process.exit(2);
}

const pass = process.env.EMU_PASS_ID ?? path.basename(dir);
const screens = lines.filter((entry) => entry.type === "screen");
const defects = lines.filter((entry) => entry.type === "defect");
const summary = `PASS ${pass}: ${screens.length} screens, ${defects.length} defects`;

const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The per-width checks on a screen record (reflow.ts + design.ts). */
const CHECK_NAMES = ["sidescroll", "parity", "clip", "target", "overlap"];

/** Design landmarks (design.ts) get a column of their own: they are the one
 * check of what a screen IS rather than how it lays out. Passes recorded before
 * the check existed have no `design` key — that renders as `n/a`, not a
 * failure. */
const designCell = (widths) => {
  const records = [widths[1280], widths[390]].filter(
    (screen) => screen && screen.checks && screen.checks.design !== undefined,
  );
  if (records.length === 0) return '<span class="muted">n/a</span>';
  return records.every((screen) => screen.checks.design === true)
    ? '<span class="ok">PASS</span>'
    : '<span class="bad">FAIL</span> <span class="muted">see the design defects</span>';
};

/** No made-up data (mockdata.ts) — evaluated at both widths like design; a
 * FAIL names the strings in the made-up-data defects below. Passes recorded
 * before the check existed have no `data` key — `n/a`, not a failure. */
const dataCell = (widths) => {
  const records = [widths[1280], widths[390]].filter(
    (screen) => screen && screen.checks && screen.checks.data !== undefined,
  );
  if (records.length === 0) return '<span class="muted">n/a</span>';
  return records.every((screen) => screen.checks.data === true)
    ? '<span class="ok">PASS</span>'
    : '<span class="bad">FAIL</span> <span class="muted">see the made-up-data defects</span>';
};

// Rows of the per-screen table: one per badge+name, a column per width.
const resultOrder = [];
const widthsByScreen = new Map();
for (const screen of screens) {
  const key = `${screen.badge}|${screen.name}`;
  if (!widthsByScreen.has(key)) {
    resultOrder.push(key);
    widthsByScreen.set(key, {});
  }
  widthsByScreen.get(key)[screen.width] = screen;
}

const checkCell = (screen) => {
  if (!screen) return '<span class="muted">not captured</span>';
  const failed = CHECK_NAMES.filter((check) => screen.checks?.[check] === false);
  return failed.length === 0
    ? '<span class="ok">PASS</span>'
    : `<span class="bad">FAIL</span> <span class="muted">${escape(failed.join(", "))}</span>`;
};

const resultRows = resultOrder
  .map((key) => {
    const [badge, name] = key.split("|");
    const widths = widthsByScreen.get(key);
    return `    <tr>
      <td>${escape(badge)}<br /><span class="muted">${escape(name)}</span></td>
      <td>${checkCell(widths[1280])}</td>
      <td>${checkCell(widths[390])}</td>
      <td>${designCell(widths)}</td>
      <td>${dataCell(widths)}</td>
    </tr>`;
  })
  .join("\n");

const defectRows = defects
  .map(
    (defect) => `    <tr>
      <td>${escape(defect.kind)}</td>
      <td>${escape(defect.journey)}</td>
      <td>${escape(defect.screen)}</td>
      <td>${escape(defect.viewport)}</td>
      <td>${escape(defect.detail)}</td>
      <td class="mono">${escape(defect.fingerprint)}</td>
      <td>${defect.screenshot ? `<a href="${escape(defect.screenshot)}">${escape(defect.screenshot)}</a>` : ""}</td>
    </tr>`,
  )
  .join("\n");

const screenRows = screens
  .map((screen) => {
    const design = screen.designRel
      ? `<img alt="design ${escape(screen.badge)}" src="${escape(screen.designRel)}" style="width:50%" />`
      : `<span class="missing">no design render for badge ${escape(screen.badge)}</span>`;
    return `    <tr>
      <td>${escape(screen.badge)}<br /><span class="muted">${escape(screen.name)} @ ${screen.width}px</span></td>
      <td><img alt="app ${escape(screen.badge)} ${screen.width}px" src="${escape(screen.shot)}" style="width:50%" /></td>
      <td>${design}</td>
    </tr>`;
  })
  .join("\n");

const verdict =
  defects.length === 0
    ? `<span class="ok">CLEAN</span>`
    : `<span class="bad">${defects.length} defect(s) — see the table above</span>`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escape(summary)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #1c1b1a; }
    .mono { font-family: ui-monospace, monospace; font-size: 12px; }
    .summary { font-family: ui-monospace, monospace; font-size: 15px; margin-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0 32px; }
    th, td { border: 1px solid #d6d3ce; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f4f2ef; }
    td img { max-width: 100%; border: 1px solid #d6d3ce; }
    .ok { color: #1a7f37; font-weight: 600; }
    .bad { color: #b42318; font-weight: 600; }
    .muted { color: #7a766f; font-size: 12px; }
    .missing { color: #7a766f; font-size: 12px; }
  </style>
</head>
<body>
  <p class="summary">${escape(summary)}</p>
  <p class="summary">${verdict}</p>
  <h2>Per-screen results</h2>
  <table>
    <thead>
      <tr><th>screen</th><th>1280</th><th>390</th><th>design</th><th>data</th></tr>
    </thead>
    <tbody>
${resultRows.length > 0 ? resultRows : '    <tr><td colspan="5" class="muted">no screens recorded</td></tr>'}
    </tbody>
  </table>
  <h2>Defects</h2>
  <table>
    <thead>
      <tr><th>kind</th><th>journey</th><th>screen</th><th>viewport</th><th>detail</th><th>fingerprint</th><th>screenshot</th></tr>
    </thead>
    <tbody>
${defectRows.length > 0 ? defectRows : '    <tr><td colspan="7" class="muted">none</td></tr>'}
    </tbody>
  </table>
  <h2>Screens (app vs. design)</h2>
  <table>
    <thead>
      <tr><th>screen</th><th>app (this pass)</th><th>design render</th></tr>
    </thead>
    <tbody>
${screenRows.length > 0 ? screenRows : '    <tr><td colspan="3" class="muted">no screens recorded</td></tr>'}
    </tbody>
  </table>
</body>
</html>
`;

writeFileSync(path.join(dir, "index.html"), html);
console.log(summary);
console.log(`report: ${path.join(dir, "index.html")}`);
process.exit(defects.length === 0 ? 0 : 1);
