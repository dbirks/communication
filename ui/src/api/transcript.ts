/**
 * Transcript projection (ADR-0016 §7): the conversation's `domain_events` rows
 * folded into something a person can read.
 *
 * The journal is the transcript, so this is a pure fold over the frames the SSE
 * stream delivered — replayed frames are deduplicated by `global_seq`, streamed
 * agent chunks merge into one message per turn, and a `conversation.tool.update`
 * mutates the tool call already on screen instead of adding a row. Nothing here
 * decides state: the turn's status comes from the events and from
 * `getConversation.active_turn`, never from a client-side guess, and
 * `interrupted` is rendered as "stopped, outcome unknown" (`10-ui-design-handoff
 * .md` J7) rather than as a resume.
 */
import { deciderLabel } from "./actors";
import { fallbackName } from "./names";
import type {
  ConversationTurn,
  ConversationTurnStatus,
  EventEnvelope,
  PermissionOption,
  PermissionRequestStatus,
} from "./types";

/**
 * The turn's origin vocabulary (`conversation_turns.submitted_via`, migration
 * 00017, ADR-0062): WHAT actually queued the prompt. `human` is a person
 * typing (or starting the run the turn belongs to); the other three are
 * automations, and for those `submitted_by` is the person who authorised the
 * automation — on whose behalf the turn runs — never a person who typed it.
 */
export type TurnSubmittedVia = NonNullable<ConversationTurn["submitted_via"]>;

/** The automation kinds spelled for a reader; `human` is deliberately absent. */
const AUTOMATION_VIA_WORDS: Partial<Record<TurnSubmittedVia, string>> = {
  schedule: "schedule",
  issue_trigger: "issue trigger",
  child_run: "child run",
};

/**
 * Words for the automation that submitted a turn, or `null` when no automation
 * did: `human` and an absent value (a pre-ADR-0062 producer sent none, and a
 * turn nobody qualified is not evidence of a machine) both keep today's plain
 * author rendering. A kind this build has never seen is named by its own wire
 * value rather than falling through to the plain author — the honest failure
 * direction is a strange-looking label, never a claim that a person typed an
 * unattended prompt.
 */
export function automationViaWords(via: string | null | undefined): string | null {
  if (!via || via === "human") return null;
  return AUTOMATION_VIA_WORDS[via as TurnSubmittedVia] ?? via;
}

/**
 * The submitter line for a turn: the person's name when a person submitted it,
 * and who the automation ran on behalf of when one did (ADR-0062). The
 * on-behalf-of reading always carries the automation's name — a bare "on behalf
 * of Ada" would hide the fact that nobody typed this prompt.
 */
export function submitterCopy(name: string, via: string | null | undefined): string {
  const automation = automationViaWords(via);
  return automation ? `on behalf of ${name} · ${automation}` : name;
}

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      turnId: string;
      authorUserId: string;
      /**
       * What queued this prompt, joined off the turn row when the surface holds
       * one (`getConversation.active_turn`); absent for every turn the journal
       * is all the page has, and for a pre-ADR-0062 control plane.
       */
      submittedVia?: TurnSubmittedVia;
      text: string;
      at: string;
    }
  | {
      kind: "agent";
      id: string;
      turnId: string;
      text: string;
      truncated: boolean;
      final: boolean;
      /** When the message's first chunk committed — the speaker line's time. */
      at: string;
    }
  | { kind: "thought"; id: string; turnId: string; text: string; truncated: boolean }
  | {
      kind: "tool";
      id: string;
      turnId: string;
      toolCallId: string;
      title: string;
      toolKind: string;
      status: string;
      inputPreview: string;
      outputPreview: string;
      truncated: boolean;
      /** `occurred_at` of the first `conversation.tool.*` event for the call. */
      startedAt: string | null;
      /** `occurred_at` of the last `conversation.tool.*` event for the call. */
      lastAt: string | null;
      /** `occurred_at` of the event that first reported a terminal status; null while running. */
      finishedAt: string | null;
    }
  | {
      kind: "permission";
      id: string;
      turnId: string;
      requestId: string;
      title: string;
      toolKind: string;
      options: PermissionOption[];
      status: PermissionRequestStatus;
      decisionOptionId: string | null;
      decidedBy: string | null;
      deadlineAt: string | null;
      /** `occurred_at` of the `conversation.permission.requested` frame. The
       * worker set `deadline_at = requested + its PermissionTTL`, so
       * `deadline_at − requested_at` is the approval window the expired card
       * can name without knowing the worker's configuration. */
      requestedAt?: string;
    }
  | {
      kind: "system";
      id: string;
      text: string;
      at: string;
      /** Set on a `conversation.notice` line: the worker's machine name for
       * what the note is about (`workspace`, `mail_readonly`, or a kind this
       * build has no words for). A surface that knows more than the frame
       * does — which repository the note names, which profile ran the turn —
       * upgrades the sentence from this (`transcriptPresentation.ts`); every
       * other reader keeps the fold's plain line.
       *
       * The kind is never printed on its own: it is the wire's vocabulary, and
       * a system line is read by a person.
       */
      noticeKind?: string;
      /**
       * The wire's own words for this line (`stop_reason end_turn`,
       * `launcher_id claude`), rendered only as a `title` tooltip.
       *
       * Review 2e: the transcript printed "Turn completed (end_turn)" and
       * "Agent session connected (claude)" — protocol text a member cannot
       * act on. The plain sentence is now the visible text (see
       * `stopReasonWords`), and this carries what the harness actually said:
       * still in the DOM for whoever can read it, never in the reading line.
       * Absent means the line has no machine detail to hide.
       */
      raw?: string;
    };

/** What the journal says about one turn (merged with `active_turn` for display). */
export interface TurnRecord {
  turnId: string;
  status: ConversationTurnStatus;
  stopReason: string | null;
  /** `lease_expired` | `worker_gone` | `shutdown` for an interrupted turn. */
  interruptReason: string | null;
  requestedBy: string | null;
  sessionOrigin: string | null;
  startedAt: string | null;
}

export interface Transcript {
  items: TranscriptItem[];
  turns: TurnRecord[];
  /** Highest `global_seq` folded in, i.e. what a reconnect would resume from. */
  throughSeq: number;
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function options(payload: Record<string, unknown>): PermissionOption[] {
  const raw = payload["options"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const option = entry as Record<string, unknown>;
    const optionId = str(option, "option_id");
    if (!optionId) return [];
    return [{ option_id: optionId, label: str(option, "label"), kind: str(option, "kind") }];
  });
}

/** The `conversation.tool.*` statuses the journal treats as final. */
const TOOL_TERMINAL = new Set(["completed", "failed"]);

/**
 * The right slot of a tool row (the design's diffstat slot — timing only).
 *
 * The number is journal time, honest by construction: start is the
 * `occurred_at` of the first `conversation.tool.*` event for the call, finish
 * the `occurred_at` of the event that first reported a terminal status. There
 * is no diffstat: no event or API field carries added/removed line counts,
 * and parsing `+N −M` out of agent prose would be a guess dressed as data.
 * A finished call with no usable times renders nothing (null), never 0s.
 */
export function toolTimingLabel(item: Extract<TranscriptItem, { kind: "tool" }>): string | null {
  if (TOOL_TERMINAL.has(item.status)) {
    if (!item.startedAt || !item.finishedAt) return null;
    return formatElapsed(Date.parse(item.finishedAt) - Date.parse(item.startedAt));
  }
  return "● running";
}

/** A journal elapsed span as a compact slot: `<1s`, `14s`, `1m 05s`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The disconnect causes the worker reports (`internal/agent/acp/disconnect.go`
 * and ADR-0068's `agent_switched`) in words. An unmapped reason adds no clause:
 * the line says the session closed, which is true of every one of them, and the
 * machine word stays in the tooltip rather than being guessed at.
 */
const DISCONNECT_WORDS: Record<string, string> = {
  shutdown: "the worker shut down",
  replaced: "a new session replaced it",
  process_exited: "the agent process exited",
  agent_process_exited: "the agent process exited",
  acp_connection_closed: "the connection to the agent closed",
  agent_switched: "the thread's agent was switched",
};

const INTERRUPT_COPY: Record<string, string> = {
  lease_expired: "the worker stopped checking in mid-turn",
  worker_gone: "the worker disappeared",
  shutdown: "the worker shut down",
};

/** A tool preview that says nothing: empty, or a JSON container with no members. */
const EMPTY_PREVIEW = new Set(["{}", "[]", "null", '""', "''"]);

/**
 * Whether a streamed tool input/output preview is worth a line on screen.
 *
 * ACP harnesses send an empty argument object as `{}` for a no-argument tool
 * call, and the worker forwards it verbatim. Rendering it puts a machine artifact
 * on a card that a person reads as "the agent did something with this input",
 * which is not a fact — the fact is that there was no input. The same holds for
 * `[]`/`null`, and for the empty object in any whitespace arrangement, so a JSON
 * parse decides, not a string compare against one spelling.
 */
export function meaningfulPreview(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text || EMPTY_PREVIEW.has(text)) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        return Object.keys(parsed as Record<string, unknown>).length === 0 ? "" : raw;
      }
    } catch {
      // A truncated preview is still meaningful prose; show it.
    }
  }
  return raw;
}

/** A JSON object, which is all any caller here is willing to read. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether an object is a plan rather than some other payload.
 *
 * `goal` and `steps` are the two members `PlanView` renders a plan from
 * (`docs/m4-contract.md` § 7's planner output); an object with neither is a
 * result, an error body, or a tool echo, and dressing one up as a plan would
 * invent structure the agent never served.
 */
function looksLikePlan(value: Record<string, unknown>): boolean {
  return "goal" in value || "steps" in value;
}

/** A plan lifted out of an agent message, in the JSON text `PlanView` accepts. */
export interface PlanDocument {
  /** The plan object as JSON: the message itself, or its `plan` member. */
  body: string;
}

/**
 * The plan an agent message served, or null when the message is prose.
 *
 * A planner turn answers with structured output, and the whole message is then
 * JSON: either the plan object itself or the `{"plan":{"goal":…,"steps":[…]}}`
 * envelope the extractor keeps. Printed raw that is one wall of escaped text
 * (`live-conversation-3.png`), so the fold offers the plan to `PlanView` — but
 * only when the *entire* text parses and names a `goal` or `steps`, because a
 * half-read message is a fabricated reading: a chunk still streaming, a JSON
 * fragment inside prose, or a tool echo all stay the text they are.
 */
export function planDocumentOf(text: string): PlanDocument | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  const parsed = record(parseJson(trimmed));
  if (!parsed) return null;
  if (looksLikePlan(parsed)) return { body: trimmed };
  // A `plan` member is either the object or the JSON string the extractor
  // carried (§ 7's `structuredOutput` shape); both name the same plan.
  const declared = parsed["plan"];
  const wrapped =
    record(declared) ?? (typeof declared === "string" ? record(parseJson(declared)) : null);
  return wrapped && looksLikePlan(wrapped) ? { body: JSON.stringify(wrapped) } : null;
}

/** `JSON.parse` as a value-or-null answer; never a throw, never a warning. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The honest sentence for an interrupted turn (`10-ui-design-handoff.md` J7:
 * never "resumed without loss"). Exported so the turn-status line and the
 * transcript say the same thing.
 */
export function interruptedCopy(reason: string | null): string {
  const cause = reason ? INTERRUPT_COPY[reason] : undefined;
  return cause
    ? `Turn stopped — outcome unknown (${cause}); you can send a new prompt`
    : "Turn stopped — outcome unknown; you can send a new prompt";
}

/**
 * The plain sentence for a harness stop reason (`review 2e`).
 *
 * `conversation.turn.completed`'s `stop_reason` is the ACP `stopReason` verbatim
 * (`internal/domain/agent.go`: `end_turn`, `cancelled`, `max_tokens`, `refusal`,
 * `other`, plus `max_turn_requests` for a turn that used up its request budget),
 * and a harness may answer with a value this build has never seen. Every
 * reading starts with the word "completed" — that is what the journal says of
 * the turn — and adds WHY only when the reason carries one, because
 * "completed (max_tokens)" is the protocol talking past the reader while
 * "completed — the agent hit its token limit" is the same fact in English. An
 * unknown reason adds no invented cause: the line stays "completed" and the
 * machine word rides the tooltip.
 */
export function stopReasonWords(reason: string | null | undefined): string {
  switch (reason) {
    case "end_turn":
    case "cancelled":
    case null:
    case undefined:
    case "":
      return "completed";
    case "max_tokens":
      return "completed — the agent hit its token limit";
    case "max_turn_requests":
      return "completed — the agent ran out of requests";
    case "refusal":
      return "completed — the agent declined to continue";
    case "other":
      return "completed — the agent gave no reason";
    default:
      return "completed — the agent gave a reason this app does not know";
  }
}

/** The note's own words, minus the wire's: the `workspace: ` the worker's note
 * seam writes is a machine's prefix, and an ADR reference is not a sentence a
 * member can act on. Nothing else is rewritten — a note this build has no
 * better words for is the honest line the worker wrote. */
function noteWords(text: string): string {
  return text
    .replace(/^workspace:\s*/i, "")
    .replace(/\s*\((?:[^)]*\bADR-\d+[^)]*)\)/gi, "")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * The transcript's muted system line for a `conversation.notice` frame.
 *
 * Kinds the app has its own words for are said in those words; anything else
 * renders as the worker's line, never as an error and never as agent output
 * (09-api-events-data: a consumer that quotes "what the agent said" reads
 * `conversation.message.agent` rows only). The repository a note names is not
 * on the frame, so the read-only kind keeps a repository-free sentence here —
 * the surface that holds the thread's own repository names it.
 */
function noticeWords(kind: string, text: string): string {
  if (kind === "mail_readonly") return "Read-only: this agent can't change this repository.";
  if (kind === "agent_retry") return RETRY_SERIES_BASE;
  const words = noteWords(text);
  if (!words) return "System note";
  return kind === "workspace" ? `Workspace: ${words}` : words;
}

/** The base words for the launcher's retry status (kind `agent_retry`). The
 * fold collapses a run of retry lines into ONE muted line; the attempt count
 * is appended by the fold, which is the only place that sees the whole run.
 */
const RETRY_SERIES_BASE = "Retrying the model…";

/** The worker's own line that counts as one model attempt (as opposed to the
 * series' closing "Retry finished, resuming." line, which the model resuming
 * is not an attempt). Anchored on the whole line, the same narrow shape the
 * worker classifies on.
 */
const RETRY_ATTEMPT_LINE = /^Retrying \(attempt \d+\/\d+, waiting \d+s\)(…|\.\.\.)$/;

/** The series' total after the slash, in either spelling the launcher uses
 * (`Retrying (attempt 3/3, waiting 8s)…` and the shorter
 * `Retrying (attempt 3/3…)`). The count is the worker's own, never a guess. */
const RETRY_ATTEMPT_TOTAL = /attempt\s+\d+\s*\/\s*(\d+)/;

/**
 * The end-of-turn line for a turn whose model retries ran out with nothing said
 * (deployed finding 2026-11-11, the pi thread whose README summary never came).
 *
 * The journal said `conversation.turn.completed`, so the transcript printed
 * "Turn completed" over an empty answer: the agent's whole message stream was
 * whitespace, and the retry-status notices are the evidence of WHY. Saying
 * "completed" there is a claim the turn made no — nobody got an answer, and the
 * model was unavailable. The retry count is the series' own total when the
 * launcher named one; with no count in the lines the sentence says no number.
 */
export function noAnswerAfterRetries(retries: number): string {
  const count = retries > 0 ? ` (${retries} ${retries === 1 ? "retry" : "retries"})` : "";
  return `Turn ended without an answer — the model was unavailable${count}.`;
}

/** Agent text worth an answer: an empty stream and a whitespace-only one both
 * left the reader with nothing, which is what the "no answer" line is for. */
function agentAnswered(item: Extract<TranscriptItem, { kind: "agent" }> | undefined): boolean {
  return Boolean(item && item.text.trim() !== "");
}

/** The collapsed line's words: the base plus the attempt count the fold saw. */
export function retrySeriesWords(attempts: number): string {
  if (attempts <= 0) return RETRY_SERIES_BASE;
  return `${RETRY_SERIES_BASE} (${attempts} attempt${attempts === 1 ? "" : "s"})`;
}

/** Plain-language line for the journal rows that are not message content. */
function systemLine(
  event: EventEnvelope,
  payload: Record<string, unknown>,
  nameOf: (userId: string) => string,
  agentName?: (launcherId: string) => string,
): { text: string; raw?: string; noticeKind?: string } | null {
  switch (event.type) {
    case "conversation.created":
      // The Projects handoff's first copy rule: “Conversations” becomes
      // “Threads” everywhere (docs/design/handoff-projects/README.md § 1) — the
      // event type is the wire's and stays `conversation.created`; the sentence
      // a person reads is the app's.
      return { text: `Thread started with ${str(payload, "agent_profile_name") || "an agent"}` };
    case "conversation.control.transferred": {
      // A uuid in a sentence nobody can act on is not information: the journal
      // identifies principals by id, the transcript names them.
      const to = str(payload, "to_user_id");
      const reason = str(payload, "reason");
      const toKind = str(payload, "to_kind");
      // `to_kind` is `human`, `run_attempt` or `none` (`09`). Only a human has a
      // display name to resolve, so the other two get their own sentence rather
      // than an empty one.
      if (toKind === "run_attempt")
        return { text: "Control passed to a run attempt — no human is driving" };
      if (toKind !== "human" || !to) return { text: "Control returned — nobody is driving" };
      if (reason === "returned") return { text: `Control returned to ${nameOf(to)}` };
      if (reason === "taken") return { text: `Control taken by ${nameOf(to)}` };
      return { text: `Control transferred to ${nameOf(to)} (${reason})` };
    }
    case "conversation.notice": {
      // A worker-authored system line (a repository that failed to prepare, a
      // mail answer running over a read-only mount). It is never folded into
      // what the agent said, and it names its kind so a surface with more
      // facts than the frame can say them.
      const kind = str(payload, "kind");
      return {
        text: noticeWords(kind, str(payload, "text")),
        raw: kind ? `kind ${kind}` : "kind (none reported)",
        noticeKind: kind,
      };
    }
    case "conversation.scope_changed": {
      // ADR-0067 amendment: the controller moved the thread's repository
      // scope. The journal row is the transcript's own evidence, the way the
      // agent-switch divider is — a scope change a viewer cannot replay cannot
      // have happened. The to-name is what the row names (null = the whole
      // project, the unbound answer a pre-ADR-0067 row gives), and the actor
      // is the envelope's human, never a bare uuid.
      const actor =
        str(payload, "actor_user_id") || (event.actor?.kind === "human" ? event.actor.id : "");
      const to = str(payload, "to_repository_name");
      const who = actor ? nameOf(actor) : "Someone";
      return {
        text: to
          ? `${who} moved this thread to ${to}`
          : `${who} moved this thread to the whole project`,
        raw: `repository_id ${str(payload, "from_repository_id") || "null"} → ${
          str(payload, "to_repository_id") || "null"
        }`,
      };
    }
    case "conversation.turn.started": {
      const origin = str(payload, "session_origin");
      if (origin === "resumed") return { text: "Turn started on a resumed agent session" };
      if (origin === "reused") return { text: "Turn continued on the live agent session" };
      return { text: "Turn started on a new agent session" };
    }
    case "conversation.turn.completed": {
      // Review 2e: "Turn completed (end_turn)" is the wire's sentence. The
      // reader's is the plain word for the reason, and the reason rides the
      // tooltip.
      const reason = str(payload, "stop_reason");
      return {
        text: `Turn ${stopReasonWords(reason)}`,
        raw: reason ? `stop_reason ${reason}` : "stop_reason (none reported)",
      };
    }
    case "conversation.turn.cancelled":
      return { text: "Turn cancelled" };
    case "conversation.turn.failed":
      return {
        text: `Turn failed${str(payload, "message") ? `: ${str(payload, "message")}` : ""}`,
      };
    case "conversation.turn.interrupted":
      return { text: interruptedCopy(str(payload, "reason") || null) };
    case "agent.session.connected": {
      // Review 2e: "Agent session connected (claude)" named the launcher.
      // The agent is the profile the person chose, so name that.
      const launcher = str(payload, "launcher_id");
      const name = agentName ? agentName(launcher) : launcher || "the agent";
      return {
        text: `Connected to ${name || "the agent"}`,
        raw: launcher ? `launcher_id ${launcher}` : "launcher_id (none reported)",
      };
    }
    case "agent.session.disconnected": {
      const reason = str(payload, "reason");
      return {
        text: `The agent session closed${DISCONNECT_WORDS[reason] ? ` — ${DISCONNECT_WORDS[reason]}` : ""}`,
        raw: reason ? `reason ${reason}` : "reason (none reported)",
      };
    }
    default:
      return null;
  }
}
/** Fold journal frames into transcript items in the order they were committed. */
export function projectTranscript(
  events: readonly EventEnvelope[],
  /**
   * Display name for a user id. The journal only ever carries ids, so a page
   * that wants names (always) passes its actor-directory resolver; the default
   * is the honest "someone (abc12345)" fallback, never a bare uuid.
   */
  nameOf: (userId: string) => string = fallbackName,
  /**
   * The `ConversationTurn` rows this surface holds (today: `getConversation`'s
   * `active_turn`). A journal `conversation.message.user` frame carries only
   * `submitted_by`, which since ADR-0062 is not always the person who typed —
   * the turn row is what says whether it was. A turn no row names keeps the
   * old rendering: an unknown origin is never guessed to be an automation.
   */
  turnRows: readonly ConversationTurn[] = [],
  /**
   * Names the agent a `launcher_id` belongs to (review 2e). The surface that
   * holds the conversation's profile row passes one; the default prints the
   * launcher id the event carried, which is the wire's word — honest, and the
   * only thing this build can say when no read names the launcher.
   */
  agentName?: (launcherId: string) => string,
): Transcript {
  const viaByTurn = new Map<string, TurnSubmittedVia>();
  for (const row of turnRows) {
    if (row.submitted_via) viaByTurn.set(row.id, row.submitted_via);
  }
  const items: TranscriptItem[] = [];
  const turns = new Map<string, TurnRecord>();
  const agentByTurn = new Map<string, Extract<TranscriptItem, { kind: "agent" }>>();
  const thoughtByTurn = new Map<string, Extract<TranscriptItem, { kind: "thought" }>>();
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  const permissions = new Map<string, Extract<TranscriptItem, { kind: "permission" }>>();
  /**
   * The model-retry series seen per turn: a key exists for every turn that
   * streamed at least one `agent_retry` notice, and the value is the highest
   * attempt total those lines named (0 when none named one). It is what lets a
   * completed turn with no answer say the model was unavailable instead of
   * pretending the turn finished well (see `noAnswerAfterRetries`).
   */
  const retriedTurns = new Map<string, number>();
  const seen = new Set<number>();
  let throughSeq = 0;

  const push = (item: TranscriptItem) => {
    items.push(item);
    return item;
  };

  const turnRecord = (turnId: string, event: EventEnvelope): TurnRecord => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const record: TurnRecord = {
      turnId,
      status: "queued",
      stopReason: null,
      interruptReason: null,
      requestedBy: null,
      sessionOrigin: null,
      startedAt: event.occurred_at,
    };
    turns.set(turnId, record);
    return record;
  };

  /**
   * The moment the turn reaches a terminal state, its agent message can
   * never receive another chunk: the reader's "writing…" state ends with
   * the turn, not with a final-chunk flag that a lossy or truncated stream
   * may never deliver — the defect that left "● writing…" on the row after
   * the transcript already printed "Turn completed". A terminal journal
   * record is proof no chunk follows: the turn row and its terminal event
   * commit in one transaction (ADR-0014, the same reading `describeTurn`
   * stands on). A final frame that still arrives keeps the flag it sets.
   */
  const markAgentFinal = (turnId: string) => {
    const item = agentByTurn.get(turnId);
    if (item) item.final = true;
  };

  for (const event of events) {
    // Replay-safe: the same `global_seq` must never be folded twice.
    if (seen.has(event.global_seq)) continue;
    seen.add(event.global_seq);
    if (event.global_seq > throughSeq) throughSeq = event.global_seq;

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const turnId = str(payload, "turn_id");
    const at = event.occurred_at;

    switch (event.type) {
      case "conversation.message.user": {
        const submittedVia = turnId ? viaByTurn.get(turnId) : undefined;
        push({
          kind: "user",
          id: event.event_id,
          turnId,
          authorUserId: str(payload, "submitted_by"),
          ...(submittedVia ? { submittedVia } : {}),
          text: str(payload, "text"),
          at,
        });
        if (turnId) turnRecord(turnId, event).status = "queued";
        break;
      }
      case "conversation.message.agent": {
        const text = str(payload, "text");
        const existing = turnId ? agentByTurn.get(turnId) : undefined;
        if (existing) {
          existing.text += text;
          existing.truncated = existing.truncated || bool(payload, "truncated");
          existing.final = existing.final || bool(payload, "final");
          break;
        }
        const item: Extract<TranscriptItem, { kind: "agent" }> = {
          kind: "agent",
          id: event.event_id,
          turnId,
          text,
          truncated: bool(payload, "truncated"),
          final: bool(payload, "final"),
          at,
        };
        push(item);
        if (turnId) agentByTurn.set(turnId, item);
        break;
      }
      case "conversation.thought": {
        const text = str(payload, "text");
        const existing = turnId ? thoughtByTurn.get(turnId) : undefined;
        if (existing) {
          existing.text += text;
          existing.truncated = existing.truncated || bool(payload, "truncated");
          break;
        }
        const item: Extract<TranscriptItem, { kind: "thought" }> = {
          kind: "thought",
          id: event.event_id,
          turnId,
          text,
          truncated: bool(payload, "truncated"),
        };
        push(item);
        if (turnId) thoughtByTurn.set(turnId, item);
        break;
      }
      case "conversation.tool.call": {
        const callId = str(payload, "tool_call_id");
        const status = str(payload, "status") || "pending";
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          id: event.event_id,
          turnId,
          toolCallId: callId,
          title: str(payload, "title"),
          toolKind: str(payload, "kind"),
          status,
          inputPreview: meaningfulPreview(str(payload, "input_preview")),
          outputPreview: "",
          truncated: bool(payload, "truncated"),
          startedAt: at,
          lastAt: at,
          finishedAt: TOOL_TERMINAL.has(status) ? at : null,
        };
        push(item);
        if (callId) tools.set(callId, item);
        break;
      }
      case "conversation.tool.update": {
        const callId = str(payload, "tool_call_id");
        const target = callId ? tools.get(callId) : undefined;
        if (target) {
          // Update in place: the row already on screen changes status, never a
          // second row for the same tool call.
          const status = str(payload, "status");
          if (status) target.status = status;
          const title = str(payload, "title");
          if (title) target.title = title;
          target.outputPreview += str(payload, "output_preview");
          target.truncated = target.truncated || bool(payload, "truncated");
          target.lastAt = at;
          // The finish is pinned by the first terminal report; a late update
          // must not move the number a person already read.
          if (TOOL_TERMINAL.has(target.status) && target.finishedAt === null) {
            target.finishedAt = at;
          }
          break;
        }
        const status = str(payload, "status") || "pending";
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          id: event.event_id,
          turnId,
          toolCallId: callId,
          title: str(payload, "title") || "(tool call not in transcript)",
          toolKind: "",
          status,
          inputPreview: "",
          outputPreview: meaningfulPreview(str(payload, "output_preview")),
          truncated: bool(payload, "truncated"),
          startedAt: at,
          lastAt: at,
          finishedAt: TOOL_TERMINAL.has(status) ? at : null,
        };
        push(item);
        if (callId) tools.set(callId, item);
        break;
      }
      case "conversation.permission.requested": {
        const requestId = str(payload, "permission_request_id");
        if (requestId && permissions.has(requestId)) break;
        const item: Extract<TranscriptItem, { kind: "permission" }> = {
          kind: "permission",
          id: event.event_id,
          turnId,
          requestId,
          title: str(payload, "title"),
          toolKind: str(payload, "kind"),
          options: options(payload),
          status: "pending",
          decisionOptionId: null,
          decidedBy: null,
          deadlineAt: str(payload, "deadline_at") || null,
          requestedAt: at,
        };
        push(item);
        if (requestId) permissions.set(requestId, item);
        break;
      }
      case "conversation.permission.decided": {
        const requestId = str(payload, "permission_request_id");
        const status = str(payload, "status") as PermissionRequestStatus;
        const decision = str(payload, "decision_option_id") || null;
        const decider = str(payload, "decided_by") || null;
        const target = requestId ? permissions.get(requestId) : undefined;
        if (target) {
          target.status = status;
          target.decisionOptionId = decision;
          target.decidedBy = decider;
          break;
        }
        // The request itself scrolled out of the retained window (or was
        // appended before this client connected): still show how it closed.
        push({
          kind: "system",
          id: event.event_id,
          text:
            `Permission ${status}` +
            (decision ? ` (${decision})` : "") +
            (decider ? ` — decided by ${deciderLabel(decider, nameOf)}` : ""),
          at,
        });
        break;
      }
      default: {
        const turnEvent = event.type.startsWith("conversation.turn.")
          ? event.type.slice("conversation.turn.".length)
          : "";
        if (turnEvent) {
          if (turnId) {
            const record = turnRecord(turnId, event);
            switch (turnEvent) {
              case "started":
                record.status = "running";
                record.sessionOrigin = str(payload, "session_origin") || null;
                record.startedAt = at;
                break;
              case "completed":
                record.status = "completed";
                record.stopReason = str(payload, "stop_reason") || null;
                markAgentFinal(turnId);
                break;
              case "cancelled":
                record.status = "cancelled";
                record.stopReason = str(payload, "stop_reason") || null;
                record.requestedBy = str(payload, "requested_by") || null;
                markAgentFinal(turnId);
                break;
              case "failed":
                record.status = "failed";
                record.stopReason = str(payload, "stop_reason") || null;
                markAgentFinal(turnId);
                break;
              case "interrupted":
                // No stop reason: nothing reported one (migration 00003 says so).
                record.status = "interrupted";
                record.interruptReason = str(payload, "reason") || null;
                markAgentFinal(turnId);
                break;
              default:
                break;
            }
          }
        }
        const line = systemLine(event, payload, nameOf, agentName);
        if (line?.noticeKind === "agent_retry" && turnId) {
          // Record the series for the turn BEFORE the collapse: the muted line
          // the reader sees says "Retrying the model…", while the end-of-turn
          // line needs to know the retry happened and how many attempts the
          // launcher named.
          const named = RETRY_ATTEMPT_TOTAL.exec(str(payload, "text"));
          retriedTurns.set(
            turnId,
            Math.max(retriedTurns.get(turnId) ?? 0, named ? Number(named[1]) : 0),
          );
        }
        if (line?.noticeKind === "agent_retry") {
          // The launcher's retry status lines collapse into ONE muted line:
          // a run of consecutive agent_retry notices is one retry series, and
          // the reader gets "Retrying the model… (N attempts)" — never four
          // machine lines. The count is the number of attempt lines in the run
          // (the closing "Retry finished, resuming." is the model resuming, not
          // an attempt). Any intervening item (an answer, a tool, a different
          // note) ends the run, so the next retry line starts a fresh one.
          const isAttempt = RETRY_ATTEMPT_LINE.test(str(payload, "text").trim());
          const prev = items[items.length - 1];
          if (prev !== undefined && prev.kind === "system" && prev.noticeKind === "agent_retry") {
            const m = prev.text.match(/\((\d+) attempts?\)$/);
            const count = (m ? Number(m[1]) : 0) + (isAttempt ? 1 : 0);
            prev.text = retrySeriesWords(count);
          } else {
            push({
              kind: "system",
              id: event.event_id,
              text: retrySeriesWords(isAttempt ? 1 : 0),
              ...(line.raw ? { raw: line.raw } : {}),
              noticeKind: line.noticeKind,
              at,
            });
          }
          break;
        }
        if (line) {
          // A completed turn that retried the model and never said a word did
          // not complete in any sense a reader cares about: the last line names
          // what the journal shows (retry status, then no agent text) rather
          // than printing "Turn completed" over an empty answer.
          const retries =
            turnEvent === "completed" && turnId && retriedTurns.has(turnId)
              ? (retriedTurns.get(turnId) ?? 0)
              : null;
          const answered = agentAnswered(turnId ? agentByTurn.get(turnId) : undefined);
          push({
            kind: "system",
            id: event.event_id,
            text: retries !== null && !answered ? noAnswerAfterRetries(retries) : line.text,
            ...(line.raw ? { raw: line.raw } : {}),
            ...(line.noticeKind ? { noticeKind: line.noticeKind } : {}),
            at,
          });
        }
        break;
      }
    }
  }

  return { items, turns: [...turns.values()], throughSeq };
}

/**
 * The run a conversation's transcript is correlated to, read off the journal.
 *
 * M4 stamps `run_id`/`node_execution_id`/`attempt_id` on the envelope of every
 * conversation row an attempt writes (docs/m4-contract.md § 3, ADR-0023), so a
 * run-controlled conversation names its run in the frames the page already
 * streams — no second read, and nothing invented: an id is reported only where
 * an event actually carried it. `Conversation` itself names no run, so a
 * conversation whose frames carry none has no link to offer.
 */
export interface RunLink {
  runId: string;
  nodeExecutionId: string | null;
  attemptId: string | null;
}

export function runLinkOf(events: readonly EventEnvelope[]): RunLink | null {
  let runId = "";
  let nodeExecutionId: string | null = null;
  let attemptId: string | null = null;
  for (const event of events) {
    if (!runId && event.run_id) runId = event.run_id;
    if (!nodeExecutionId && event.node_execution_id) nodeExecutionId = event.node_execution_id;
    if (!attemptId && event.attempt_id) attemptId = event.attempt_id;
    if (runId && nodeExecutionId && attemptId) break;
  }
  return runId ? { runId, nodeExecutionId, attemptId } : null;
}

/**
 * The turn whose state the page should describe.
 *
 * `activeTurn` (from `getConversation`) outranks the journal while the journal
 * has nothing newer: it is the authoritative lease answer, including
 * `cancel_requested_at`, which no event carries. But a *terminal* journal record
 * for that same turn outranks it outright — the turn row and its terminal event
 * commit in one transaction (ADR-0014), so the event is proof the row already
 * moved and the cached read is merely stale.
 */
export function describeTurn(
  turns: readonly TurnRecord[],
  activeTurn?: ConversationTurn | null,
): { status: ConversationTurnStatus; record?: TurnRecord; active?: ConversationTurn } {
  const TERMINAL = new Set<ConversationTurnStatus>([
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ]);
  if (activeTurn) {
    const record = turns.find((candidate) => candidate.turnId === activeTurn.id);
    if (record && TERMINAL.has(record.status)) {
      return { status: record.status, record };
    }
    return { status: activeTurn.status, record, active: activeTurn };
  }
  const last = turns.at(-1);
  if (last) return { status: last.status, record: last };
  return { status: "queued" };
}

/** Text for the `turn-status` hook — status is never conveyed by colour alone. */
export function turnStatusText(
  turns: readonly TurnRecord[],
  activeTurn?: ConversationTurn | null,
): string {
  const described = describeTurn(turns, activeTurn);
  const { status, record, active } = described;
  switch (status) {
    case "queued":
      return record || active ? "queued — waiting for a worker" : "idle — no turn yet";
    case "leased":
      return "starting — a worker has the turn";
    case "running":
      return active?.cancel_requested_at
        ? "running — stop requested, waiting for the agent"
        : "running";
    case "completed":
      // Review 2e: "completed (end_turn)" in a header is the protocol's
      // sentence, not the reader's — `stopReasonWords` is the one place the
      // mapping lives, so the header and the transcript line agree.
      return stopReasonWords(record?.stopReason);
    case "cancelled":
      return `cancelled${record?.requestedBy ? " (requested by a controller)" : ""}`;
    case "failed":
      return "failed";
    case "interrupted":
      return "stopped — outcome unknown";
    default:
      return status;
  }
}

/**
 * The wire's own words behind `turnStatusText`, for a `title` tooltip only
 * (review 2e): "✓ completed (end_turn)" printed the harness's enum where the
 * reader needed one word. The enum is evidence — the turn genuinely ended for
 * that reason — so it stays in the DOM, off the reading line.
 */
export function turnStatusDetail(
  turns: readonly TurnRecord[],
  activeTurn?: ConversationTurn | null,
): string | null {
  const { status, record } = describeTurn(turns, activeTurn);
  if (!record?.stopReason) return null;
  if (status !== "completed" && status !== "failed") return null;
  return `stop_reason ${record.stopReason}`;
}
