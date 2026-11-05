/**
 * Run-origin threads were named server-side by their raw ids —
 * `run 01a1a992 /plan attempt 1` — the legacy `attemptConversationTitle`
 * (internal/store/postgres/agentturn_seams.go) that built the stored title
 * from a run-id prefix and the node instance key. The design names things in
 * words (screens 1g/2a), with a short run reference as secondary metadata at
 * most, so a row still carrying that legacy stored title is rendered in the
 * same humanised form the new server-side title carries:
 * `<Node label> · run #<4-char ref>` (the summary wire carries no workflow
 * name, so the row's own run reference stands in for it) with
 * `run #<ref> · attempt N` as the muted secondary line.
 *
 * The row speaks only from its own fields — the wire's `run_link`
 * (ADR-0043) — never by reading ids back out of the title; the stored title
 * contributes only the LEGACY PATTERN that says "this is a row the server
 * still named in ids". A title a person wrote (including one that merely
 * starts with the word "run") is shown verbatim, exactly as it was.
 */
import type { components } from "../../api/schema";

type RunLink = components["schemas"]["ConversationRunLink"];

/** The legacy server naming, verbatim: `run <id[:8]> <node key> attempt <n>`. */
const LEGACY_RUN_THREAD_TITLE = /^run [0-9a-f]{8} \S+ attempt \d+$/;

/** The node's words from its instance key: the last path segment with its
 *  iteration brackets dropped, underscores as spaces, capitalised —
 *  `plan` → "Plan", `/build_until_verified[1]/code_review` → "Code review".
 *  The server-side twin (`attemptConversationTitle`) says the same. "" when
 *  the key carries no node id to name. */
export function humanizeNodeLabel(key: string | null | undefined): string {
  const last = (key ?? "").trim().split("/").pop() ?? "";
  const bare = last.split("[")[0].replace(/_/g, " ").trim();
  if (!bare) return "";
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export interface RunThreadTitle {
  /** The worded title the row renders instead of the stored one (≤ 200). */
  title: string;
  /** The muted secondary line: `run #01a1 · attempt 1`. */
  secondary: string;
}

/**
 * The worded form of a run-origin row whose stored title is still the
 * server's legacy id pattern. `null` when the title is not that pattern (a
 * person's title stays verbatim) or the row's `run_link` carries no node key
 * or run id to name the label and reference from — then the row keeps
 * exactly what the wire sent.
 */
export function legacyRunThreadTitle(
  title: string | null | undefined,
  runLink: RunLink | null | undefined,
): RunThreadTitle | null {
  const text = (title ?? "").replace(/\s+/g, " ").trim();
  if (!LEGACY_RUN_THREAD_TITLE.test(text) || !runLink) return null;
  const label =
    humanizeNodeLabel(runLink.node_instance_key) || humanizeNodeLabel(runLink.node_id ?? null);
  if (!label) return null;
  const ref = (runLink.run_id ?? "").replace(/-/g, "").slice(0, 4);
  if (ref.length < 4) return null;
  const m = text.match(/attempt (\d+)$/);
  const attempt = runLink.attempt_number ?? (m ? Number(m[1]) : 1);
  const worded = `${label} · run #${ref}`;
  return {
    title: worded.length > 200 ? worded.slice(0, 200) : worded,
    secondary: `run #${ref} · attempt ${attempt}`,
  };
}
