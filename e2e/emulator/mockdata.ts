// mockdata.ts — the design mocks' SAMPLE DATA, as a machine-checkable list.
//
// The two design handoffs (`docs/design/handoff-workflows/`,
// `docs/design/handoff-projects/`) draw every screen with invented content —
// their READMEs say it outright: "All data is made up. Never fake data the
// API doesn't serve." `checks.data` (fixtures.ts) proves the app never shows
// any of it: a MOCK_DATA string appearing in a screen's visible text is a
// `made-up-data` defect naming the string and where the mock used it.
// `mockdata-scan.mjs` runs the same list statically over `ui/src`, so a
// hardcoded mock value is caught without a browser at all.
//
// WHAT GOES IN: proper nouns and specific invented values — people, project
// and repository names, workflow names, issue titles and numbers, run ids,
// refs, digests, worker/volume ids, sample sentences (thread titles, run
// goals, transcript lines, trigger schedule values, timestamps), and sample
// text typed into fields inside the mock (a dialog's filled NAME is data,
// the NAME label is chrome).
// WHAT STAYS OUT: UI chrome — labels, headings, verbs, tab names, empty-state
// sentences and error copy the app is MEANT to reuse from the design — and
// anything generic enough to false-positive ("plan", "review", "Maintenance",
// "0.2", bare counts and ages). Also out: every mock string that is in fact
// real lab/product content, listed under EXCLUSIONS below; the check may
// never fire on data the server actually serves.
//
// EXTRACTION METHOD (reproducible): the mock HTML is untrusted — it was read,
// never executed. A static `python3 -I` script fed each `*.dc.html` (the two
// Reviews and Sidebar.dc.html) to html.parser, dropping <script>/<style> and
// emitting the visible text; that output was diffed against each folder's
// `screens.txt` (the handoff's own per-badge text dumps) and the READMEs.
// Every proper noun / specific value in that text was then taken, minus
// chrome, minus the exclusions, minus anything a `grep -rlF` over `ui/src`
// (non-test) showed to be legitimate product copy. Monetary costs: the mocks
// contain none (searched for `\$<n>`, USD, cost) — the only size-like value
// is the artifact's `4.2 KB`, a measurement a real plan.md could legitimately
// re-report, so it stays out.
//
// EXCLUSIONS — mock strings that are NOT made-up data here, with the reason:
//   • `app`, `tally` — the lab seeds these repos itself (seed.sh,
//     seed-github-loop.sh): they are real data, not mock leaks.
//   • `plan-with-approval` / `Plan with approval`, `security-review` /
//     `Security review`, `issue-to-pr` — real starter templates the app
//     serves from docs/samples/home/; the 1b STARTER cards legitimately show
//     them, as does the 1e page of the workflow the journeys create from one.
//   • `Survey a repository checkout, draft an implementation plan…` (the plan
//     card's description) and `Reply with the plan in markdown: numbered
//     steps…` (the 1g prompt field) — verbatim content of the real
//     docs/samples/home/plan-with-approval.yaml the Studio legitimately draws.
//   • `plan.md` — a REAL artifact: every plan-with-approval run publishes one
//     (the run-gate journey opens it). `4.2 KB` — see the note above.
//   • `Claude Code`, `Codex`, `Pi` — real agent profiles the product seeds
//     (M2 seeds exactly "Claude Code" and "Codex"; the NewProfileDialog names
//     all three launchers), so a thread row naming them is honest data.
//     `claude-code` and `qwen-chat` are NOT: no real launcher, profile or
//     model uses those ids — they are the mock's invented profile strings.
//   • step ids `survey`, `plan`, `approve`, `publish_plan`, `implement`,
//     `test`, `review` — vocabulary of the REAL sample/m4 definitions; they
//     render as live step chains whenever a real revision says so. `open_pr`
//     is kept: it exists only in the mock's dependency-bumps chain (the one
//     real occurrence in the tree is a test fixture the scan excludes).
//   • kind ids (`agent.acp`, `pipeline.child`, `process.exec`…), `0.1.0`
//     (a legitimate first semver), generic words (`plan` as a label chip,
//     `bug`, `feature`, `Delivery`/`Maintenance` folder names — plain English
//     that whole-word matching would hit on unrelated copy, e.g. the real
//     Secrets "Delivery" label), counts and relative ages (`2h`, `! 3`),
//     clock times and `22 Oct` dates (real resources are created on real
//     Oct 2026 days; only the mock's full ISO timestamps are distinctive
//     enough), and the design's own structural sentences (footnotes,
//     intro lines, error copy).
//   • `9c1e04f2` vs the pass ids: run ids a real pass mints are UUIDs; the
//     odds of a real short id starting with one of these fixed hex strings
//     are 16⁻⁶ per id — the mock's ids stay in.
export interface MockDatum {
  /** The exact visible text the mock invented (case-sensitive). */
  text: string;
  /** Where the mock shows it: file + a short context. */
  source: string;
}

const WF = "docs/design/handoff-workflows/Workflows Review.dc.html";
const PR = "docs/design/handoff-projects/Projects Review.dc.html";
const SB = "docs/design/handoff-projects/Sidebar.dc.html";

export const MOCK_DATA: readonly MockDatum[] = [
  /* ------------------------------------------------------- people */
  {
    text: "David Birks",
    source: `${SB} — sidebar user; ${PR} 1a MEMBERS, ACTIVITY; ${WF} 1a/1d "draft v1 · by David Birks"`,
  },
  { text: "Priya Shah", source: `${PR} 1a — MEMBERS row "role: contributor"` },

  /* ------------------------------------------- projects, orgs, repos */
  {
    text: "Northwind",
    source: `${SB} — sidebar PROJECTS; ${PR} 1b project H1; ${WF} 1b row "Northwind · storefront"`,
  },
  {
    text: "NORTHWIND",
    source: `${WF} 2b — USED-IN card header (uppercased form of the same mock project)`,
  },
  {
    text: "Lumen Docs",
    source: `${SB} — sidebar PROJECTS; ${WF} 2a used-in row; ${PR} 1f thread row`,
  },
  {
    text: "LUMEN DOCS",
    source: `${WF} 2b — USED-IN card header (uppercased form of the same mock project)`,
  },
  {
    text: "Internal Tools",
    source: `${SB} — sidebar PROJECTS; ${PR} 1f/1g thread row "Internal Tools / cli"`,
  },
  {
    text: "storefront",
    source: `${SB} — Northwind's repo; ${PR} 1b/1e and ${WF} 2a/2c/2e throughout`,
  },
  { text: "payments-api", source: `${SB} — Northwind's repo; ${PR} 1b REPOSITORIES; ${WF} 1b row` },
  {
    text: "docs-site",
    source: `${WF} 2a — USED IN 2 REPOS row; ${PR} 1g thread row "Lumen Docs / docs-site"`,
  },
  {
    text: "northwind/storefront",
    source: `${WF} 2e — trigger detail "northwind/storefront · checked every minute"; ${PR} 1a remote URL`,
  },
  { text: "northwind/payments-api", source: `${PR} 1a/1b — REPOSITORIES remote URL line` },
  {
    text: "Customer storefront and the payments services behind it",
    source: `${PR} 1a/1b/1c — the mock project's description under the H1`,
  },

  /* ----------------------------------------------- workflow names */
  {
    text: "feature-delivery",
    source: `${WF} 2e/1b — repo workflow row; also ${PR} 1a run rows. The lab seeds "feature-development" — a different whole word`,
  },
  {
    text: "Feature delivery",
    source: `${WF} 1a/1b — folder row title (title-case of the same mock workflow)`,
  },
  {
    text: "dependency-bumps",
    source: `${WF} 1a/1b — Maintenance-folder workflow; ${PR} 1b WORKFLOWS row`,
  },
  {
    text: "Dependency bumps",
    source: `${WF} 1a — folder row title (title-case of the same mock workflow)`,
  },
  {
    text: "open_pr",
    source: `${WF} 1a — the mock dependency-bumps chain "bump › test › open_pr" (see EXCLUSIONS: real chains never name a step this)`,
  },
  {
    text: "retry-payments-plan",
    source: `${WF} 1c — generated id line "id: retry-payments-plan · change" in the New workflow dialog`,
  },
  {
    text: "Retry payments plan",
    source: `${WF} 1c — NAME field value typed into the New workflow dialog`,
  },
  {
    text: "Scan a checkout, review findings with a chat model and publish a report",
    source: `${WF} 1a — Security review starter card description; the REAL sample description is different wording`,
  },

  /* ------------------------------------------- trigger schedule values */
  {
    text: "0 6 * * 1",
    source: `${WF} 2e/2b — the mock schedule trigger's cron (every lab schedule so far is "* * * * *")`,
  },
  {
    text: "Every Monday at 06:00 UTC",
    source: `${WF} 2e/2b — cronInWords reading of that mock cron`,
  },
  {
    text: "Mondays 06:00",
    source: `${WF} 2a/2b — trigger sentence "issue labeled plan · Mondays 06:00 UTC"-style summary`,
  },
  {
    text: "mondays 06:00",
    source: `${WF} 1b — Dependency bumps row trigger line "Northwind · payments-api mondays 06:00"`,
  },
  {
    text: "cron mon 06:00",
    source: `${PR} 1b/1c — WORKFLOWS row "dependency-bumps r2 · cron mon 06:00 · payments-api"`,
  },
  {
    text: "Plan this week’s upgrades",
    source: `${WF} 2e — goal input carried by the mock schedule trigger (curly apostrophe as in the mock)`,
  },

  /* -------------------------------------------------- issue titles */
  { text: "Retry failed card payments", source: `${PR} 1d/1e — issue #142 title` },
  {
    text: "retrying failed card payments",
    source: `${PR} 1a callout "Plan for retrying failed card payments in storefront"; 1b decision body`,
  },
  {
    text: "Plan: retry failed card payments",
    source: `${PR} 1c/1e — WORK IN THIS REPO item title`,
  },
  { text: "Saved cards on checkout", source: `${PR} 1d/1e — issue #138 title` },
  { text: "Flaky checkout.spec.ts on CI", source: `${PR} 1d/1e — issue #131 title` },
  {
    text: "checkout.spec.ts",
    source: `${PR} 1b "checkout.spec.ts timed out", 1e issue, 1g transcript — the mock repo's test file (the lab's repos are a Python CLI: hello.py)`,
  },

  /* ------------------------------------------------- thread titles */
  { text: "Fix flaky checkout test", source: `${PR} 1a/1b/1f/1g — the live thread's title` },
  { text: "Write the docs search page", source: `${PR} 1f/1g — thread row in Lumen Docs` },
  {
    text: "Explain the refund webhook flow",
    source: `${PR} 1b/1f/1g — thread row on payments-api`,
  },
  { text: "Rename CLI flags", source: `${PR} 1f/1g — archived thread row in Internal Tools` },

  /* ------------------------------------------------- run goals/titles */
  {
    text: "Add saved cards to checkout",
    source: `${PR} 1b/1c — RUNNING NOW row title; issue #138's goal`,
  },

  /* ----------------------------------------- transcript sample copy */
  { text: "fails about one run in five on CI", source: `${PR} 1g — the thread's opening message` },
  {
    text: "running the test 20 times to reproduce",
    source: `${PR} 1g — "Agent is …" live-thread preview line`,
  },
  {
    text: "waits for the payment iframe",
    source: `${PR} 1g — the mock agent's prose "The test waits for the payment iframe…"`,
  },
  { text: "pnpm test checkout --repeat 20", source: `${PR} 1g — tool row in the mock transcript` },
  {
    text: "thread/fix-flaky-checkout-test",
    source: `${PR} 1d/1e/1g — the mock thread's branch ref`,
  },

  /* -------------------------------------------------- issue numbers */
  { text: "#142", source: `${PR} 1d/1e — OPEN ISSUES row (Retry failed card payments)` },
  { text: "#138", source: `${PR} 1d/1e — OPEN ISSUES row (Saved cards on checkout)` },
  { text: "#131", source: `${PR} 1d/1e — OPEN ISSUES row (Flaky checkout.spec.ts on CI)` },

  /* ------------------------ run ids, digests, refs, worker/volume ids */
  {
    text: "9c1e04",
    source: `${PR} 1a — the waiting run's short id ("run 9c1e04", "#9c1e04"); matches its # form too`,
  },
  { text: "9c1e04f2", source: `${PR} 1a/1d/1e — run branch ref "run/9c1e04f2/storefront"` },
  { text: "4b7d21", source: `${PR} 1a — the FAILED run "#4b7d21"` },
  { text: "a7f310", source: `${PR} 1a — the RUNNING run "#a7f310"` },
  { text: "e02b9a", source: `${PR} 1a/1d — the COMPLETED "#e02b9a" dependency-bumps run` },
  { text: "33c0d8", source: `${PR} 1a — the CANCELLED run "#33c0d8"` },
  { text: "#9c1e", source: `${WF} 2a/2e and ${PR} 1b/1e — last-run / workspace short run ref` },
  { text: "#71aa", source: `${WF} 2a/1e — the docs-site "✓ #71aa done · 1d" run` },
  { text: "#a7f3", source: `${PR} 1e — "● run #a7f3 in progress" on issue #138` },
  { text: "8f2c1a", source: `${WF} 1a/1c — the Feature delivery revision digest` },
  { text: "8f2c1a90", source: `${WF} 1d — the same digest, long form (r1 · 0.1.0 · 8f2c1a90)` },
  { text: "41d07e", source: `${WF} 1a — the Dependency bumps revision digest` },
  { text: "7f3a2c91", source: `${PR} 1a — WORKSPACES "worker 7f3a2c91" id` },
  { text: "vol-91ab", source: `${PR} 1a — WORKSPACES "volume vol-91ab" id` },
  { text: "a1b2c3d", source: `${PR} 1a — workspace "base a1b2c3d → head e4f5a6b"` },
  { text: "e4f5a6b", source: `${PR} 1a/1d — workspace/repo "head e4f5a6b" commit` },
  { text: "77c1d0e", source: `${PR} 1d — STATUS "clean · head 77c1d0e"` },

  /* ------------------------------------------- fake profiles/models */
  {
    text: "qwen3-8-27b",
    source: `${WF} 1f/1g — the plan step's MODEL ("model · qwen3-8-27b"); the real sample uses david-birks/qwen3-8-flash-next`,
  },
  {
    text: "claude-code",
    source: `${PR} 1a/1f — "profile: claude-code"; no real launcher or profile has this id`,
  },
  { text: "qwen-chat", source: `${PR} 1a — "profile: qwen-chat" on the from-run conversation row` },

  /* -------------------------------------------- frozen ISO timestamps */
  {
    text: "2026-10-22T19:04:11.482Z",
    source: `${PR} 1a — conversation row "updated:" (raw ISO the design brief forbids showing)`,
  },
  { text: "2026-10-22T17:41:02.110Z", source: `${PR} 1a — the from-run conversation's "updated:"` },

  /* -------------------------------------- sample text typed into a field */
  {
    text: "Insert a code reviewer after the tests",
    source: `${WF} 1f — the assistant box's filled request above "Propose"`,
  },
];

/** Just the texts, in list order — the payload `findMockTexts` scans for. */
export const MOCK_DATA_TEXTS: readonly string[] = MOCK_DATA.map((d) => d.text);

/** The mock record(s) naming a hit text (there can be several with variants). */
export function sourcesFor(text: string): string {
  const hits = MOCK_DATA.filter((d) => d.text === text).map((d) => d.source);
  return hits.length > 0 ? hits.join(" | ") : "unknown source";
}

/**
 * Page-side collector (serialized by `page.evaluate` — it may reference
 * nothing but its argument and the page): every MOCK_DATA text that appears
 * in `document.body.innerText` — the page's VISIBLE text — case-sensitively
 * and whole-word. Whole-word means the match may not touch an
 * [A-Za-z0-9_] character on either side, so `9c1e04` does not fire inside a
 * real UUID that merely starts with it and `#142` does not fire inside
 * `#1420`; text a person actually sees is exactly what gets matched.
 */
export function findMockTexts(texts: readonly string[]): string[] {
  const bodyText: string = document.body ? document.body.innerText : "";
  const wordChar = (ch: string | undefined): boolean =>
    ch !== undefined && ch !== "" && /[A-Za-z0-9_]/.test(ch);
  const hits: string[] = [];
  for (const text of texts) {
    let from = 0;
    for (;;) {
      const at = bodyText.indexOf(text, from);
      if (at < 0) break;
      const before = at > 0 ? bodyText.charAt(at - 1) : "";
      const after = bodyText.charAt(at + text.length);
      if (!wordChar(before) && !wordChar(after)) {
        hits.push(text);
        break;
      }
      from = at + 1;
    }
  }
  return hits;
}
