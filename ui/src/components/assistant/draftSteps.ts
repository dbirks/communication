/**
 * Design 2f, round 12 + round-13 fix (rcn-review13-2f): the transcript's step
 * list is the SAVED DRAFT's steps, not the model's prose marks. When an
 * answer carries the saved-draft link, the list renders from the draft's
 * document — its top-level nodes in order, each with the agent profile (or
 * the kind label) that runs it — and the model's own ✓ / ● / · lines are
 * never drawn for the list (its prose stays, minus the duplicate step
 * lines).
 *
 * Round 13 made the recognition TARGET-based: the round-13 lab turn shipped
 * the draft link with a label that was not exactly `Open draft` (the chip
 * read a truncated raw path) and the whole 2f state — step list, `Open
 * draft` beside the composer — disappeared, because the app keyed on the
 * label's wording. A link's TARGET that points at a library draft page is
 * the draft, whatever it is called.
 *
 * Marks (design 2f): the step the open question concerns is `●` when it can
 * be determined, later steps `·`, settled steps `✓`. While a question card is
 * open, `✓` is never shown — nothing is settled until the question is
 * answered.
 *
 * Pure: this module decides WHAT the list shows; `MessageList` renders it.
 */
import { parse } from "yaml";
import { kindWord } from "../../lib/pipeline/definition";

/** The label the server tags the saved draft's link with — stable wording, kept for the door's button and the chip's base label. */
export const OPEN_DRAFT_LINK_LABEL = "Open draft";

/**
 * The draft page target: `/workflows/{pipelineId}/drafts/{draftId}` (the
 * canonical route the app mounts, plus the legacy `/library/…` alias that
 * still redirects to it). The match is on the TARGET, never on the link's
 * label — recognition by wording is what round 13 lost.
 */
const DRAFT_ROUTE = /^\/(?:workflows|library)\/[^/?#]+\/drafts\/([^/?#]+)/;

/**
 * The draft id a route names (`/workflows/:id/drafts/:draftId`), or `null`
 * when the route names no draft — no such segment at all (the workflow page
 * itself, an older transcript's link), or a segment that decodes to nothing.
 */
export function draftRouteOf(route: string): string | null {
  const match = DRAFT_ROUTE.exec(route);
  return match !== null && match[1].length > 0 ? decodeURIComponent(match[1]) : null;
}

/**
 * Is this link the saved draft's link? TARGET first: any route that points
 * at a library draft page is the draft, whatever the model or server
 * phrased its label (round-13: a raw-path label lost the whole 2f state).
 * The round-12 wording — the bare workflow page labelled exactly `Open
 * draft` — still counts as a fallback for older transcripts, whose routes
 * carry no draft id the step list can read.
 */
export function isDraftLink(link: { label: string; route: string }): boolean {
  return (
    DRAFT_ROUTE.test(link.route) ||
    link.label.trim().toLowerCase() === OPEN_DRAFT_LINK_LABEL.toLowerCase()
  );
}

/**
 * The draft id an answer's saved-draft link points at, or `null` when the
 * answer names no draft — no such link at all, or only the older wording
 * whose bare route carries no draft id to read.
 */
export function openDraftIdOf(links: readonly { label: string; route: string }[]): string | null {
  for (const link of links) {
    if (!isDraftLink(link)) continue;
    const draftId = draftRouteOf(link.route);
    if (draftId !== null) return draftId;
  }
  return null;
}

/** The saved-draft link in one answer's links (target-first, same rule as `openDraftIdOf`), or `null`. */
export function draftLinkOf(
  links: readonly { label: string; route: string }[],
): { label: string; route: string } | null {
  const link = links.find((candidate) => isDraftLink(candidate));
  return link === undefined ? null : link;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

function humanizeSegment(word: string): string {
  const clean = decodeURIComponent(word).replace(/[-_]+/g, " ").trim();
  if (clean.length === 0) return "";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * A readable label for a link chip from the route alone — never a raw path
 * (round-13's truncated `/workflo…` chip). Known shapes get their app words
 * plus a short id; anything else humanises its first segment.
 */
export function humanRouteLabel(route: string): string {
  if (DRAFT_ROUTE.test(route)) return OPEN_DRAFT_LINK_LABEL;
  const parts = route.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return "Home";
  const [head, second = ""] = parts;
  const withId = (word: string, id: string): string =>
    id.length > 0 ? `${word} ${shortId(decodeURIComponent(id))}` : `${word} page`;
  switch (head) {
    case "workflows":
    case "library":
      return withId("Workflow", second);
    case "p":
      return withId("Project", second);
    case "runs":
      return withId("Run", second);
    case "threads":
      return withId("Thread", second);
    case "steps":
      return withId("Step", second);
    case "profiles":
      return withId("Agent profile", second);
    case "approvals":
      return withId("Approval", second);
    case "artifacts":
      return withId("Artifact", second);
    case "settings":
      return second.length > 0 ? `Settings · ${humanizeSegment(second)}` : "Settings";
    case "inbox":
      return "Inbox";
    case "board":
      return "Board";
    case "login":
      return "Sign in";
  }
  return humanizeSegment(head) || "Link";
}

/**
 * The chip's label, never a raw path: the server's words when it supplied
 * them; when the label is empty or IS a path (round 13: the chip read
 * `/workflo…`), a humanised form of the route — and the saved draft's
 * target always reads as `Open draft`.
 */
export function readableLinkLabel(link: { label: string; route: string }): string {
  const label = link.label.trim();
  if (label.length > 0 && !label.startsWith("/")) return label;
  return humanRouteLabel(link.route);
}

/**
 * The draft's own readable name for the chip's `Open draft · <name>`
 * wording: `metadata.name` from the draft document — the slug — read off
 * the document the app fetches anyway for the step list.
 */
export function draftNameOf(documentYaml: string): string | null {
  let parsed: unknown;
  try {
    parsed = parse(documentYaml);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const name = (parsed as { metadata?: { name?: unknown } }).metadata?.name;
  if (typeof name !== "string") return null;
  const clean = name.trim();
  return clean.length > 0 ? clean : null;
}

export type DraftStepState = "done" | "current" | "later";

export interface DraftStepRow {
  /** The node's own id — the name an expression and the API say. */
  name: string;
  /** The agent profile that runs the node, or its kind label. */
  profile: string | null;
  state: DraftStepState;
}

/** An open question card, narrowed to the members that identify its binding. */
export interface DraftStepQuestion {
  prompt: string;
  options: { label: string; value: string }[];
}

/**
 * The draft's top-level nodes in document order, one row per node. `null`
 * when the document names no readable step list (unreadable YAML, no
 * `spec.nodes`, no named nodes) — the caller then keeps the model's own
 * lines, never an empty list.
 *
 * `openQuestion` is the answer's open question card, or `null` when the
 * answer saved the draft with nothing still asked:
 *
 * - a question open: `current` (●) on the first node the question concerns
 *   when determinable (its id or profile rides in the prompt or the option
 *   labels / values), otherwise `later` (·) on every node — never `done`;
 * - no question: `done` (✓) on every node.
 */
export function draftStepRows(
  documentYaml: string,
  openQuestion: DraftStepQuestion | null,
): DraftStepRow[] | null {
  let parsed: unknown;
  try {
    parsed = parse(documentYaml);
  } catch {
    return null;
  }
  const nodes =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { spec?: { nodes?: unknown } }).spec?.nodes
      : undefined;
  if (!Array.isArray(nodes)) return null;

  const rows: DraftStepRow[] = [];
  for (const raw of nodes) {
    if (raw === null || typeof raw !== "object") continue;
    const node = raw as { id?: unknown; kind?: unknown; config?: unknown };
    if (typeof node.id !== "string" || node.id.length === 0) continue;
    const kind = typeof node.kind === "string" ? node.kind : "";
    let profile: string | null = null;
    if (node.config !== null && typeof node.config === "object") {
      const configProfile = (node.config as { profile?: unknown }).profile;
      if (typeof configProfile === "string" && configProfile.length > 0) profile = configProfile;
    }
    if (profile === null && kind.length > 0) profile = kindWord(kind);
    rows.push({ name: node.id, profile, state: "later" });
  }
  if (rows.length === 0) return null;

  if (openQuestion === null) {
    for (const row of rows) row.state = "done";
    return rows;
  }

  const questionText = [
    openQuestion.prompt,
    ...openQuestion.options.map((option) => `${option.label} ${option.value}`),
  ]
    .join(" ")
    .toLowerCase();
  let bound = false;
  for (const row of rows) {
    if (bound) continue;
    const name = row.name.toLowerCase();
    const profile = row.profile?.toLowerCase() ?? "";
    if (
      (name.length > 0 && questionText.includes(name)) ||
      (profile.length > 0 && questionText.includes(profile))
    ) {
      row.state = "current";
      bound = true;
    }
  }
  return rows;
}
