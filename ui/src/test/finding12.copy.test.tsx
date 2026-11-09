/**
 * Finding 12, word for word.
 *
 * The finding is the contract, so this file never retypes it: it reads the four
 * `REWRITE` lines out of `docs/design/handoff-redesign/findings/f12.txt` at test
 * time and compares them, character for character (with only the whitespace the
 * JSX source wraps on collapsed), against the strings the components actually
 * render. Copy that drifts from the finding fails here instead of in a review
 * comment, and a finding that gets re-worded — or a rewrite line that goes
 * missing — fails loudly rather than passing vacuously.
 *
 * The single liberty taken with the rendered side, and it is asserted rather
 * than assumed: the design system's leading state glyph (`×` on a conflict
 * line, finding 01's "never colour alone") is a marker rather than a sentence,
 * and the finding prints it on the TODAY line but not on the REWRITE line. It is
 * stripped from the rendered string and separately required to still be there.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import DecisionBar from "../components/ds/DecisionBar";
import type { DecisionConflict } from "../components/ds/DecisionBar";
import { RunNotFound } from "../components/workbench/RunNotFound";
import Home from "../pages/Home";
import { queryKeys } from "../api/queries";
import { mockFetch, meFixture, projectFixture, type RouteStub } from "./fakes";

// `node:fs` is reached by a runtime-resolved dynamic import and given local
// types: this project's tsconfig sets `types: ["vite/client"]`, so
// `@types/node` is out of the program and no new dependency may be added here
// (the same trick `lib/pipeline/graphDoc.test.ts` uses).
declare const process: { cwd(): string };

interface NodeFs {
  readFileSync: (path: string, encoding: string) => string;
}

interface NodePath {
  resolve: (...parts: string[]) => string;
}

/** Resolved at runtime only — a literal specifier would be typechecked away. */
async function nodeFs(): Promise<NodeFs> {
  const specifier = "node:fs";
  return import(specifier) as unknown as NodeFs;
}

async function nodePath(): Promise<NodePath> {
  const specifier = "node:path";
  return import(specifier) as unknown as NodePath;
}

const [fsMod, pathMod] = await Promise.all([nodeFs(), nodePath()]);
// vitest runs with the `ui` directory as cwd; the finding lives at the repo root.
const FINDING_PATH = pathMod.resolve(
  process.cwd(),
  "../docs/design/handoff-redesign/findings/f12.txt",
);
const findingText = fsMod.readFileSync(FINDING_PATH, "utf8");

/** The finding's action separator: `Back to Runs · Ask for access`. */
const MIDDLE_DOT = "·";

/** Every `REWRITE` line in the finding, marker removed, in printing order. */
function rewriteLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const hit = /^\s*REWRITE\s+(.+?)\s*$/.exec(line);
    if (hit) lines.push(hit[1] ?? "");
  }
  return lines;
}

/**
 * The one REWRITE line `predicate` picks out. Zero or several matches throw:
 * the proof must die when the finding changes shape instead of quietly having
 * nothing to compare against.
 */
function rewriteOf(predicate: (line: string) => boolean): string {
  const all = rewriteLines(findingText);
  const hits = all.filter(predicate);
  const [only] = hits;
  if (hits.length !== 1 || only === undefined) {
    throw new Error(
      `f12.txt: expected exactly one REWRITE line, found ${hits.length} of ${all.length}: ${JSON.stringify(hits)}`,
    );
  }
  return only;
}

/**
 * The finding's rulebook ends every error with an action, and the rewrite sets
 * the action down after the last `. ` — the tail is the action row, `·`-joined
 * when there is more than one door.
 */
function sentenceAndActions(line: string): { sentence: string; actions: string[] } {
  const cut = line.lastIndexOf(". ");
  if (cut < 0) throw new Error(`f12.txt: rewrite carries no action tail: ${JSON.stringify(line)}`);
  const tail = line.slice(cut + 2).trim();
  if (!tail) throw new Error(`f12.txt: rewrite has an empty action tail: ${JSON.stringify(line)}`);
  return {
    sentence: line.slice(0, cut + 1),
    actions: tail
      .split(MIDDLE_DOT)
      .map((action) => action.trim())
      .filter((action) => action !== ""),
  };
}

/**
 * The three verbs the finding says the bar always shows, read out of its own
 * prose ("the buttons always say Approve, Request changes or Reject") so the
 * test never asserts a verb list the finding did not write.
 */
function fixedVerbs(): string[] {
  const marker = "the buttons always say";
  const line = findingText.split(/\r?\n/).find((text) => text.includes(marker));
  if (!line)
    throw new Error(`f12.txt: no line naming the fixed buttons (${JSON.stringify(marker)})`);
  const clause = line.slice(line.indexOf(marker) + marker.length).split(".")[0] ?? "";
  const verbs = clause
    .split(/\s*,\s*|\s+or\s+/)
    .map((verb) => verb.trim())
    .filter((verb) => verb !== "");
  if (verbs.length !== 3) {
    throw new Error(
      `f12.txt: expected three fixed verbs, found ${verbs.length}: ${JSON.stringify(verbs)}`,
    );
  }
  return verbs;
}

/** Collapse the JSX's line-wrapping to the one-line string a reader sees. */
function oneLine(node: Element | string): string {
  const text = typeof node === "string" ? node : (node.textContent ?? "");
  return text.replace(/\s+/g, " ").trim();
}

function renderWith(
  routes: RouteStub[],
  children: ReactNode,
  prime?: (client: QueryClient) => void,
) {
  mockFetch(routes);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  prime?.(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const NOT_FOUND = {
  type: "https://communication.dev/errors/not-found",
  title: "Not found",
  status: 404,
  detail: "no such route on this build",
};
/** Today's stubs, with the read the serving image cannot answer. */
const OLD_SERVER_ROUTES: RouteStub[] = [
  { path: "/api/v1/me", body: meFixture },
  { path: "/api/v1/projects", body: { items: [projectFixture] } },
  { path: "/api/v1/agent-profiles", body: { items: [] } },
  { path: "/api/v1/runs", body: { runs: [] } },
  { path: "/api/v1/approvals", status: 404, body: NOT_FOUND },
  { path: "/api/v1/conversations", body: { items: [] } },
];

const RUN_ID = "01987b00-1111-7000-8000-aaaaaaaaaaaa";
const PROJECT_ID = "01987a61-2222-7000-8000-bbbbbbbbbbbb";
const PRIYA = { id: "01987a63-7777-7000-8000-cccc00000001", display_name: "Priya", email: null };

afterEach(cleanup);

describe("finding 12 · the finding itself", () => {
  it("still carries the four rewrites this file proves", () => {
    expect(rewriteLines(findingText)).toHaveLength(4);
  });
});

describe("finding 12 · Today's server-version note", () => {
  it("says the rewrite, word for word, when a cross-project read 404s", async () => {
    const expected = rewriteOf((line) => line.includes("server version"));
    renderWith(OLD_SERVER_ROUTES, <Home />);

    const note = await screen.findByTestId("home-not-available");
    expect(oneLine(note)).toBe(expected);
    // Nothing in the printed sentence is left for the reader to parse out of
    // the JSX: no jargon either, which is the finding's actual complaint.
    expect(oneLine(note)).not.toMatch(/cross-project|scaffold|404|endpoint|build|API/i);
  });
});

describe("finding 12 · the run-not-found answer", () => {
  it("prints the sentence and both action labels the rewrite lists", () => {
    const expected = rewriteOf((line) => line.includes("Back to Runs"));
    const { sentence, actions } = sentenceAndActions(expected);
    renderWith([], <RunNotFound runId={RUN_ID} projectId={PROJECT_ID} />);

    const summary = screen.getByTestId("run-not-found-summary");
    const back = screen.getByTestId("run-not-found-runs");
    const access = screen.getByTestId("run-not-found-access");

    expect(actions).toEqual(["Back to Runs", "Ask for access"]);
    expect(oneLine(summary)).toBe(sentence);
    expect(oneLine(back)).toBe(actions[0] ?? "");
    expect(oneLine(access)).toBe(actions[1] ?? "");
    // The whole answer, in the finding's own order and with its own separator.
    expect(`${oneLine(summary)} ${oneLine(back)} ${MIDDLE_DOT} ${oneLine(access)}`).toBe(expected);
  });
});

describe("finding 12 · the gate with model-written buttons", () => {
  it("shows no message at all — only the three fixed verbs the finding names", () => {
    expect(rewriteOf((line) => line.startsWith("(no message"))).toBe("(no message: fixed buttons)");
    const verbs = fixedVerbs();
    renderWith([], <DecisionBar approval={{ id: "01987a90-1111-7000-8000-aaaaaaaaaaaa" }} />);

    const bar = screen.getByTestId("decision-bar");
    const labels = Array.from(bar.querySelectorAll("button")).map((button) => oneLine(button));
    expect(labels).toEqual(verbs);
    // The bar's entire visible text is those three words — nothing between or
    // around them, so there is no parsing problem to explain above or below the
    // buttons. The buttons sit in a flex row whose gap is visual, so their text
    // nodes touch: compare the whitespace-free concatenation.
    expect(oneLine(bar).replace(/\s+/g, "")).toBe(
      verbs.map((verb) => verb.replace(/\s+/g, "")).join(""),
    );
    expect(bar.querySelector("p")).toBeNull();
  });
});

describe("finding 12 · two people decided at once", () => {
  it("names the decider, the age and the way out — the rewrite verbatim", async () => {
    const expected = rewriteOf((line) => line.includes("wasn't recorded"));
    const { sentence, actions } = sentenceAndActions(expected);
    const conflict: DecisionConflict = {
      approvalId: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
      verb: "approved",
      deciderId: PRIYA.id,
      // "20 seconds ago", the finding's own age.
      decidedAt: new Date(Date.now() - 20_000).toISOString(),
    };
    // The directory the sentence resolves the id through, primed so the name is
    // on screen in the first commit rather than one fetch later.
    renderWith(
      [{ path: "/api/v1/users", body: { items: [PRIYA] } }],
      <DecisionBar
        approval={{
          id: conflict.approvalId,
          run_id: RUN_ID,
        }}
        initialConflict={conflict}
      />,
      (client) => client.setQueryData(queryKeys.users, { items: [PRIYA] }),
    );

    const line = await screen.findByTestId("decision-conflict");
    const printed = oneLine(line);
    // The state glyph is the marker the finding prints on its TODAY line; the
    // rewrite itself starts at the name.
    expect(printed.startsWith("×")).toBe(true);
    expect(printed.replace(/^×\s*/, "")).toBe(expected);
    expect(printed).toContain(sentence);
    // The action is a link, and it is the finding's last three words.
    const link = screen.getByTestId("decision-conflict-run");
    expect(actions).toHaveLength(1);
    expect(oneLine(link)).toBe(actions[0] ?? "");
    expect(link.getAttribute("href")).toContain(RUN_ID);
    // The complaint the rewrite answers: no "winner", no status vocabulary.
    expect(printed.toLowerCase()).not.toMatch(/winner|409|conflict|cas|decided_by/);
  });
});
