#!/usr/bin/env node
// mockdata-scan.mjs — the browser-free twin of the emulator's made-up-data
// check (mockdata.ts).
//
//   node e2e/emulator/mockdata-scan.mjs
//
// Greps every MOCK_DATA string through ui/src and prints each hit as
// `file:line: <text>` with the surrounding source line. A hit means the UI
// hardcodes a value the design mock invented — sample data the honesty rule
// ("All data is made up. Never fake data the API doesn't serve") forbids,
// whether or not the current screen happens to render it (a `placeholder=`
// never reaches innerText, so the browser check would miss exactly this).
//
// Matching mirrors the page-side rule: case-sensitive, whole-word (the match
// may not touch an [A-Za-z0-9_] character on either side). Comments are
// stripped first (masked out, positions preserved) because a doc comment that
// cites the design ("the design's `storefront` segment") is prose about the
// mock, not a hardcoded value; the string literals that remain are what the
// shipped UI carries. Excludes: *.test.* / *.spec.* files, __tests__ and
// test/ dirs, and test-only fixture trees (ui/src/test/**), which are
// fixtures the tests play with, not product source.
//
// Exit 0 = ui/src is clean of mock data. Exit 1 = hits printed. Exit 2 =
// usage/path error. Needs no lab, no Playwright — just Node (it imports the
// .ts list directly; Node >= 23 strips types).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { MOCK_DATA } from "./mockdata.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const uiSrc = path.resolve(here, "..", "..", "ui", "src");

const EXCLUDE_FILE = /(\.test\.|\.spec\.)/;
const EXCLUDE_DIR = /(^|\/)(__tests__|test|fixtures)(\/|$)/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(uiSrc, full);
    if (statSync(full).isDirectory()) {
      if (!EXCLUDE_DIR.test(rel)) yield* walk(full);
    } else if (
      !EXCLUDE_FILE.test(entry) &&
      /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json)$/.test(entry)
    ) {
      yield { full, rel };
    }
  }
}

/**
 * Mask comments (block and line) with spaces — newlines kept, every other
 * position unchanged — so searching the masked text still reports the true
 * column, and comment prose never counts as a hardcoded value. String-aware:
 * a `//` inside "...https://x" or a template literal does not start a comment.
 */
function maskComments(source) {
  const chars = source.split("");
  let i = 0;
  const state = { in: null }; // null | "'" | '"' | "`"
  const blank = (from, to) => {
    for (let j = from; j < to && j < chars.length; j++) if (chars[j] !== "\n") chars[j] = " ";
  };
  while (i < chars.length) {
    const c = chars[i];
    const next = chars[i + 1];
    if (state.in === null) {
      if (c === "/" && next === "/") {
        const start = i;
        while (i < chars.length && chars[i] !== "\n") i++;
        blank(start, i);
        continue;
      }
      if (c === "/" && next === "*") {
        const start = i;
        i += 2;
        while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) i++;
        i = Math.min(i + 2, chars.length);
        blank(start, i);
        continue;
      }
      if (c === '"' || c === "'" || c === "`") state.in = c;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === state.in) state.in = null;
    i++;
  }
  return chars.join("");
}

const WORD = /[A-Za-z0-9_]/;
/** The page-side whole-word rule, over a plain string. */
function wholeWordAt(text, at, needle) {
  const before = at > 0 ? text.charAt(at - 1) : "";
  const after = text.charAt(at + needle.length);
  return !WORD.test(before) && !WORD.test(after);
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

let hits = 0;
for (const { full, rel } of walk(uiSrc)) {
  const raw = readFileSync(full, "utf8");
  const masked = maskComments(raw);
  for (const datum of MOCK_DATA) {
    let from = 0;
    for (;;) {
      const at = masked.indexOf(datum.text, from);
      if (at < 0) break;
      from = at + 1;
      if (!wholeWordAt(masked, at, datum.text)) continue;
      const line = lineOf(raw, at);
      const sourceLine = raw.split("\n")[line - 1].trim();
      hits++;
      console.log(`HIT  ui/src/${rel}:${line}: "${datum.text}"`);
      console.log(`     ${sourceLine}`);
      console.log(`     mock source: ${datum.source}`);
    }
  }
}

if (hits > 0) {
  console.log(
    `\nmockdata-scan: ${hits} hit(s) — ui/src hardcodes mock sample data (mockdata.ts). ` +
      `Replace each with the value the API serves, or show an honest empty state.`,
  );
  process.exit(1);
}
console.log(
  `mockdata-scan: clean — no MOCK_DATA string appears in ui/src (${MOCK_DATA.length} strings scanned).`,
);
process.exit(0);
