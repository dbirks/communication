/**
 * Design 2f, round 12: the transcript's step list is the SAVED DRAFT's steps,
 * not the model's prose marks. When an answer carries the `Open draft` link
 * (the same link `AssistantPanel` reads for the composer's draft door), the
 * list renders from the draft's document — its top-level nodes in order, each
 * with the agent profile (or the kind label) that runs it — and the model's
 * own ✓ / ● / · lines are never drawn for the list (its prose stays, minus
 * the duplicate step lines).
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

/** The label the server tags the saved draft's link with (AssistantPanel reads the same). */
export const OPEN_DRAFT_LINK_LABEL = "Open draft";

/**
 * The draft id an answer's `Open draft` link points at
 * (`/workflows/:pipelineId/drafts/:draftId`), or `null` when the answer
 * names no draft — no such link, or a link whose route carries no draft id
 * (e.g. the pipeline page itself).
 */
export function openDraftIdOf(links: readonly { label: string; route: string }[]): string | null {
  const link = links.find((candidate) => candidate.label === OPEN_DRAFT_LINK_LABEL);
  if (link === undefined) return null;
  const match = /^\/workflows\/[^/?#]+\/drafts\/([^/?#]+)/.exec(link.route);
  return match !== null && match[1].length > 0 ? decodeURIComponent(match[1]) : null;
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
