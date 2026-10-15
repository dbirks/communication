// Guard for the design-system token table: no colour utility may name a token
// that does not exist.
//
// Why this exists as a check and not as a rule in prose: the M4 pipeline
// surface asked Tailwind for `border-node-border`, `bg-canvas-bg` and
// `bg-tree-active`, because those role names appear in
// `docs/design/design-system.md` under "Token extensions M5 needs" — a block the
// design brief says to apply "in a ui/ brief", and no brief had. The build was
// green, the tests were green, and the browser drew graph edges with
// `stroke: none`. An invisible edge is a missing fact, not a thin one (03 § 3),
// and nothing in the chain could see it. The same shape hit `--indent-step`
// (execution-tree rows lost their indentation) and `text-muted-2`, a class that
// names no token at all and therefore styles nothing.
//
// So: read the components, read `src/styles/tokens.css`, and fail on any colour
// utility whose colour name is neither a Tailwind keyword nor a token defined in
// the table. Sizes, spacing and radii are scale or arbitrary-value utilities and
// are Tailwind's business, not the token table's, so they are out of scope.
//
// Usage: node scripts/check-tokens.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = join(fileURLToPath(import.meta.url), "..", "..");
const srcDir = join(uiRoot, "src");

/** Every non-test .ts/.tsx file under ui/src. */
function workSources() {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) files.push(full);
    }
  };
  visit(srcDir);
  return files;
}

// `border-l-accent` and `ring-t-line` put a logical side between the utility and
// the colour, so the side is consumed by the pattern rather than parsed as part
// of the colour name.
const COLOR_CLASS =
  /(?:[a-z-]+:)*(?:bg|border|text|ring|divide|fill|stroke|outline|decoration|caret|accent|shadow)-(?:[lrtbsexy]-)?((?:[a-z][a-z0-9]*)(?:-[a-z0-9]+)*)(?=[\s"'`])/g;

/** Suffixes these utilities take that are not colours. */
const NOT_A_COLOR = new Set(
  `0 2 4 x y t r b l s e x2 t2 b2 l2 r2 dashed dotted double hidden none solid inset collapse
   left right center justify start end xs sm base lg xl 2xl 3xl 4xl 5xl bold semibold medium
   normal light thin italic uppercase lowercase capitalize truncate wrap nowrap pre balance
   pretty mono ui mark clip fixed gradient linear radial repeat no cover contain transparent
   current inherit white black auto full nums tabular slashed ordinal lining oldstyle sub
   super raised subtle glow`
    .split(/\s+/)
    .filter(Boolean),
);

const tokens = readFileSync(join(srcDir, "styles/tokens.css"), "utf8");
const colors = new Set([...tokens.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const all = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// A colour-prefixed utility can legitimately resolve through a non-colour
// namespace: `text-body`/`text-title-l` are the type scale, `shadow-raised` is
// depth, `h-(--row-condensed)` is layout.
const TYPE_SCALE = new Set([...tokens.matchAll(/--text-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

const missing = new Set();
for (const file of workSources()) {
  const text = readFileSync(file, "utf8");
  const rel = relative(uiRoot, file);
  // Only inside className values — prose and comments mention words like
  // `text-center` that are not colours.
  const blocks = [
    ...text.matchAll(/className="([^"]*)"/g),
    ...text.matchAll(/className=\{`([^`]*)`\}/g),
    ...text.matchAll(/className=\{"([^"]*)"\}/g),
    ...text.matchAll(/(?:class|cls)="([^"]*)"/g),
  ];
  for (const block of blocks) {
    for (const match of (block[1] ?? "").matchAll(COLOR_CLASS)) {
      const name = (match[1] ?? "").split("/")[0];
      if (NOT_A_COLOR.has(name)) continue;
      // `text-<scale>` and `shadow-<depth>` are not colours.
      if (TYPE_SCALE.has(name)) continue;
      // Numeric suffixes are scale utilities (`border-2`, `ring-1`) or arbitrary
      // values, except the state palette, which is named with digits.
      if (/\d/.test(name) && !/^(st|seg|fill|line)-/.test(name)) continue;
      if (!colors.has(`--color-${name}`)) missing.add(`${name}  (${rel})`);
    }
  }
  // Every custom property a component reads must be declared in the table.
  for (const m of text.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    if (m[1].startsWith("--tw-")) continue;
    if (!all.has(m[1])) missing.add(`${m[1]}  (${rel})`);
  }
}

// A cheap floor: if the table were emptied, the loop above would have nothing to
// check and pass.
if (colors.size < 40) {
  console.error(`tokens.css defines only ${colors.size} colours — the table is not intact`);
  process.exit(1);
}

if (missing.size > 0) {
  console.error(`colour utilities naming a token that does not exist (${missing.size}):`);
  for (const line of [...missing].sort()) console.error(`  ${line}`);
  console.error("\nAdd the role to ui/src/styles/tokens.css, or use a token that exists.");
  process.exit(1);
}
console.log(`token check passed: every colour class in ${workSources().length} files is defined`);
