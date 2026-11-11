import type { ReactElement } from "react";
import {
  IconCheck,
  IconCurrentLocation,
  IconMicrophone,
  IconPoint,
  IconPointFilled,
  IconX,
} from "@tabler/icons-react";
import { Button } from "../ds/Button";
import { MarkdownBody, renderInline } from "../../lib/markdown";
import { useDraft } from "../../api/pipelines";
import { assumedOf, judgeOf, spokenOf } from "../../api/assistant";
import ApprovalRequestCard from "./ApprovalRequestCard";
import QuestionCard from "./QuestionCard";
import { SetupMessage, ToolRuleLine } from "./SetupChecklist";
import { draftStepRows, openDraftIdOf } from "./draftSteps";
import { AnswerLinks } from "./links";
import {
  MODEL_UNAVAILABLE,
  MODEL_UNAVAILABLE_LINK_LABEL,
  MODEL_UNAVAILABLE_ROUTE,
} from "./failureCopy";
import type {
  AssistantAnswerPayload,
  AssistantMessage,
  AssistantQuestionPayload,
  AssistantToolCallJudge,
} from "./types";

/**
 * The assistant transcript (2a/2c/3d). Presentational: messages flow in as
 * props; navigation, answering and confirm/dismiss come back through
 * callbacks. `change`-kind rows are NOT rendered here — the 2c decision
 * drops the side column and the change chip owns them (ChangeChip).
 */
export interface MessageListProps {
  messages: AssistantMessage[];
  /** Plain text the user answers a follow-up question with. */
  onAnswerQuestion: (label: string) => void;
  /** Focus the composer for "Or say it your way…" free text. */
  onFreeText?: () => void;
  onConfirmApproval: (messageId: string) => void;
  onDismissApproval: (messageId: string) => void;
  /** Perform the same-origin navigation a `Go` + chevron row points at. */
  onGo: (route: string) => void;
  /**
   * Round-17 (rcn-review17-2f): the draft route the assistant panel's own
   * footer already offers as `Open draft` — `null` when the footer shows no
   * such button (the 400px popover, or no saved draft yet). The transcript's
   * row for THAT draft is a second door to the same page under the step list,
   * so it stays hidden while the button stands; every other draft row keeps
   * standing, because there the row is the only way in.
   */
  openDraftHref?: string | null;
  /**
   * Issue #63: `Retry` under a failed send's own bubble — re-sends that
   * message's text. Only optimistic local rows can fail, so only they
   * render the line and the button.
   */
  onRetrySend?: (messageId: string) => void;
  /**
   * Handoff A3 §2: draw the setup checklist as the thread's first message.
   * The caller turns it on for an EMPTY thread (first open, or a new thread);
   * with it off the transcript makes no status request at all.
   */
  showSetup?: boolean;
  /** Send a checklist action's or starter's prompt as the next message. */
  onSendPrompt?: (text: string) => void;
}

export function MessageList({
  messages,
  onAnswerQuestion,
  onFreeText,
  onConfirmApproval,
  onDismissApproval,
  onGo,
  onRetrySend,
  openDraftHref = null,
  showSetup = false,
  onSendPrompt,
}: MessageListProps) {
  // Design 2f numbers the question cards the transcript really holds:
  // the ordinal is the row's position among the conversation's question
  // rows — real transcript data. The TOTAL is not passed: the assistant
  // asks one question per turn, so the transcript cannot know how many
  // questions are coming, and a made-up `of M` is a promise the flow
  // cannot keep (rcn-2f round 7: `QUESTION 1`, never an invented count).
  // An answered card also learns WHICH label the reply quoted, so the
  // chosen option can carry its ink border and bold.
  const questionIds = messages
    .map((message) => (message.payload.kind === "question" ? message.id : null))
    .filter((id): id is string => id !== null);
  const answeredLabelFor = (
    payload: Extract<AssistantMessage["payload"], { kind: "question" }>,
  ) => {
    if (payload.answered_by == null) return null;
    const reply = messages.find((message) => message.id === payload.answered_by);
    if (!reply || reply.payload.kind !== "user") return null;
    const text = reply.payload.text.trim();
    return (
      payload.options.slice(0, 4).find((option) => option.label.trim() === text)?.label ?? null
    );
  };
  // Design 2f round 12: the answer's still-open question card — the question
  // row that follows the answer before anything else of a later turn (a user
  // reply, another answer, an approval ask). The transcript's question row is
  // the answer's question: the server asks one question per turn.
  const openQuestionFor = (messageId: string): AssistantQuestionPayload | null => {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    for (let i = index + 1; i < messages.length; i += 1) {
      const next = messages[i];
      switch (next.payload.kind) {
        case "question":
          return next.payload.answered_by == null ? next.payload : null;
        case "user":
        case "assistant":
        case "approval_request":
          return null;
        default:
          // approval_response / change echoes do not close the turn.
          continue;
      }
    }
    return null;
  };
  return (
    <div data-testid="assistant-messages" className="flex flex-col gap-[8px]">
      {showSetup ? <SetupMessage onPrompt={onSendPrompt ?? (() => undefined)} /> : null}
      {messages.map((message) => {
        switch (message.payload.kind) {
          case "user":
            return (
              <div
                key={message.id}
                data-testid="assistant-msg-user"
                className="px-[10px] py-[8px]"
                style={{ alignSelf: "flex-end", maxWidth: "85%" }}
              >
                <div
                  className="whitespace-pre-wrap rounded-[4px] px-[10px] py-[6px] text-[13px] leading-[1.45] text-ink"
                  style={{ background: "var(--color-accent-tint)" }}
                >
                  {message.payload.text}
                </div>
                {/* Handoff A6 §5: the turn was dictated. The mark rides under
                    the person's own words so a spoken ask reads as what it
                    was, without restating the text. */}
                {spokenOf(message.payload) ? (
                  <span
                    data-testid="assistant-spoken"
                    className="mt-[3px] inline-flex items-center gap-[4px] font-mono text-[10px] text-muted"
                  >
                    <IconMicrophone size={10} stroke={2} aria-hidden className="shrink-0" />
                    spoken
                  </span>
                ) : null}
                {/* Issue #63: a failed send keeps its bubble and answers it
                    in place — the honest line sits under the person's own
                    words, with the Retry that sends them again. */}
                {message.local?.state === "failed" ? (
                  <div className="flex flex-col items-end gap-[6px] pt-[6px]">
                    <p
                      data-testid="assistant-error"
                      className="m-0 flex max-w-full items-start gap-[5px] rounded-[4px] border border-st-failed-pale-edge bg-st-failed-pale-body px-[8px] py-[5px] text-[11.5px] leading-[1.4] text-st-failed-pale-fg"
                    >
                      <IconX size={11} stroke={2} aria-hidden className="mt-[3px] shrink-0" />
                      <span>
                        {message.local.error ?? "The assistant could not answer."}
                        {/* Deployed finding 2026-11-11: the one failure a retry
                            cannot fix — the model this deployment points at is
                            not there. The line says so; the jump is where an
                            admin repoints it (same `onGo` the answer's links
                            use, so the panel keeps standing). */}
                        {message.local.degraded === MODEL_UNAVAILABLE ? (
                          <>
                            {" "}
                            <button
                              type="button"
                              data-testid="assistant-error-link"
                              onClick={() => onGo(MODEL_UNAVAILABLE_ROUTE)}
                              className="cursor-pointer bg-transparent p-0 text-[inherit] text-accent-text underline"
                            >
                              {MODEL_UNAVAILABLE_LINK_LABEL}
                            </button>
                          </>
                        ) : null}
                      </span>
                    </p>
                    <Button
                      variant="primary"
                      compact
                      data-testid="assistant-send-retry"
                      onClick={() => onRetrySend?.(message.id)}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          case "assistant":
            return (
              <div
                key={message.id}
                data-testid="assistant-msg-assistant"
                className="px-[10px] py-[8px]"
              >
                <AnswerProse
                  text={message.payload.answer_markdown}
                  draftId={openDraftIdOf(message.payload.links)}
                  openQuestion={openQuestionFor(message.id)}
                />
                {/* Handoff A4 §3: the answer used the page, and says which
                    item it took. Quiet, mono, under the answer — an
                    observation about the model's guess, not part of it. */}
                {assumedOf(message.payload) ? (
                  <div
                    data-testid="assistant-assumed"
                    className="mt-[4px] flex items-center gap-[5px] font-mono text-[12px] text-faint"
                  >
                    <IconCurrentLocation size={11} stroke={2} aria-hidden className="shrink-0" />
                    {`assumed you meant ${assumedOf(message.payload)} (on screen)`}
                  </div>
                ) : null}
                <AnswerLinks
                  links={message.payload.links}
                  openDraftHref={openDraftHref}
                  onGo={onGo}
                />
                <ToolDisclosure calls={message.payload.tool_calls} />
              </div>
            );
          case "question":
            return (
              <QuestionCard
                key={message.id}
                question={message.payload}
                onAnswer={onAnswerQuestion}
                onFreeText={onFreeText}
                ordinal={questionIds.indexOf(message.id) + 1}
                answeredLabel={answeredLabelFor(message.payload)}
              />
            );
          case "approval_request":
            return (
              <ApprovalRequestCard
                key={message.id}
                messageId={message.id}
                request={message.payload}
                onConfirm={onConfirmApproval}
                onDismiss={onDismissApproval}
              />
            );
          case "change":
            // The change chip renders these (2c decision); the transcript
            // row exists for the audit trail only.
            return null;
          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * step glyphs the assistant's draft step list is built from (design 2f:
 * ✓ done in the chat, ● the step drafted to run next, · a later step).
 * These are PARSE tokens for what the model posts — the rows render Tabler
 * icons (handoff §1: no Unicode glyphs as icons).
 */
const STEP_GLYPHS = ["✓", "●", "·"] as const;

/**
 * One step line: an (optional) markdown list marker and emphasis around the
 * glyph, then the step text. The server's drafting rules ask for
 * `✓ Plan — Claude Code · opus`, but a model that wraps the lines in `- `
 * bullets or bolds the glyph is still posting a step list (2f review: the
 * list must render as it is posted, not fall back to a prose block).
 */
interface StepLine {
  glyph: (typeof STEP_GLYPHS)[number];
  rest: string;
}

/**
 * The step line's own shape (design 2f, rcn-2f review item 2): a dash and the
 * agent profile or owner that runs the step — `✓ Plan — Claude Code · opus`.
 * The dash must stand on BOTH sides: a step named "Draft-reply" keeps its own
 * hyphen, and a later "— Codex" is still the profile.
 */
const STEP_PROFILE_MARK = /\s[\u2014\u2013-]\s/;

/** Split one step line into its step and who runs it. */
function stepPartsOf(rest: string): { step: string; profile: string | null } {
  const at = rest.search(STEP_PROFILE_MARK);
  if (at < 0) return { step: rest.trim(), profile: null };
  const step = rest.slice(0, at).trim();
  const profile = rest
    .slice(at)
    .replace(/^[\s\u2014\u2013-]+/, "")
    .trim();
  if (!step || !profile) return { step: rest.trim(), profile: null };
  return { step, profile };
}

function stepLineOf(raw: string): StepLine | null {
  let line = raw.trim();
  const bullet = /^(?:[-*+]|\d+[.)])\s+/.exec(line);
  if (bullet) line = line.slice(bullet[0].length).trimStart();
  // `**✓**` / `*✓*` / `__·__`: the glyph may ride inside markdown emphasis.
  const emphasized = /^([*_]{1,2})([✓●·])\1/.exec(line);
  if (emphasized) line = line.slice(emphasized[0].length).trimStart();
  const glyph = (STEP_GLYPHS as readonly string[]).includes(line.charAt(0))
    ? (line.charAt(0) as (typeof STEP_GLYPHS)[number])
    : null;
  if (glyph === null) return null;
  return { glyph, rest: line.slice(1).trim() };
}

/**
 * Split one answer paragraph into prose runs and step-list runs: a run of
 * consecutive step lines is the draft step list (a lone step line is held
 * as a single-line run here — the WHOLE answer decides below whether it is
 * a one-line list or a stray ✓ line, because the model may separate its
 * step lines with blank lines and the app must not fall back to prose).
 */
type AnswerChunk = { type: "prose"; text: string } | { type: "steps"; lines: StepLine[] };

function chunkParagraph(paragraph: string): AnswerChunk[] {
  const chunks: AnswerChunk[] = [];
  let prose: string[] = [];
  let steps: StepLine[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    chunks.push({ type: "prose", text: prose.join("\n") });
    prose = [];
  };
  const flushSteps = () => {
    if (steps.length === 0) return;
    chunks.push({ type: "steps", lines: steps });
    steps = [];
  };
  for (const raw of paragraph.split("\n")) {
    const step = stepLineOf(raw);
    if (step) {
      flushProse();
      steps.push(step);
    } else {
      flushSteps();
      if (raw.trim().length > 0 || prose.length > 0 || steps.length > 0) prose.push(raw);
    }
  }
  flushSteps();
  flushProse();
  return chunks;
}

/**
 * The drafting intro of design 2f ("I read the chat. Drafting <name> in the
 * library:"): the paragraph a step list was announced under. It is the only
 * context in which a ONE-step run is a step list rather than a stray ✓ line —
 * the workflow the chat proved in a single step really is one step, and the
 * design draws it as the list it is. The line must END on the colon that
 * opens the list, and must name the draft, the library or the workflow it
 * is being drawn for: a random "✓ done." line that merely mentions the word
 * "drafting" mid-sentence is not an intro.
 */
const DRAFTING_INTRO_MARK = /\b(draft\w*|librar\w*|workflow\w*)\b/i;

function isDraftingIntro(chunk: AnswerChunk | undefined): boolean {
  if (chunk?.type !== "prose") return false;
  const text = chunk.text.trimEnd();
  return text.endsWith(":") && DRAFTING_INTRO_MARK.test(text);
}

/**
 * The answer-wide verdict on step runs (rcn-2f round 7): step lines the
 * model separated with blank lines are ONE list — the rows ride in the
 * transcript as it was posted, not as a paragraph of stray prose. Runs
 * that are still a single line after the merge are the stray-✓-line case
 * and fall back to the prose they are — unless the line stands directly
 * under a drafting intro (rcn-review10-2f), in which case the draft has
 * exactly one step and the row is the list.
 */
function settleStepChunks(chunks: AnswerChunk[]): AnswerChunk[] {
  const out: AnswerChunk[] = [];
  let run: StepLine[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length < 2 && !isDraftingIntro(out[out.length - 1])) {
      out.push({ type: "prose", text: run.map((line) => `${line.glyph} ${line.rest}`).join("\n") });
    } else {
      out.push({ type: "steps", lines: run });
    }
    run = [];
  };
  for (const chunk of chunks) {
    if (chunk.type === "steps") run.push(...chunk.lines);
    else {
      flush();
      out.push(chunk);
    }
  }
  flush();
  return out;
}

// rcn-review13-2f: the answer's prose repeating the OPEN QUESTION CARD's
// question word for word is the same sentence twice — the card carries the
// question, so the prose drop keeps it once. Matching is
// whitespace/punctuation-insensitive on both sides.
const normalizeSentence = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const sentencesOf = (text: string): string[] => text.match(/[^.!?]+[.!?]*/g) ?? [];

function dropQuestionDuplicates(
  chunks: AnswerChunk[],
  openQuestion: AssistantQuestionPayload | null,
): AnswerChunk[] {
  if (openQuestion === null) return chunks;
  const promptSentences = new Set(
    sentencesOf(openQuestion.prompt)
      .map((sentence) => normalizeSentence(sentence))
      .filter((sentence) => sentence.length > 0),
  );
  if (promptSentences.size === 0) return chunks;
  const out: AnswerChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.type !== "prose") {
      out.push(chunk);
      continue;
    }
    let text = chunk.text;
    for (const sentence of sentencesOf(chunk.text)) {
      if (!promptSentences.has(normalizeSentence(sentence))) continue;
      text = text.replace(sentence, " ");
    }
    text = text.replace(/ {2,}/g, " ").trim();
    if (text.length === 0) continue;
    out.push({ type: "prose", text });
  }
  return out;
}

/**
 * The draft step list (design 2f "posts a DRAFT STEP LIST … marked with
 * progress ✓ / ● / ·"): one line per step, the glyph paired with its
 * word (never colour alone, per states.ts) — done, next, later.
 */
function StepList({ lines }: { lines: StepLine[] }) {
  return (
    <div data-testid="assistant-step-list" className="flex flex-col gap-[2px] py-[2px]">
      {lines.map((line, index) => (
        <StepRow key={index} line={line} />
      ))}
    </div>
  );
}

/**
 * One row of the draft step list: the glyph (never colour alone, per
 * states.ts), the step, and WHO runs it — the profile or owner after the
 * dash, in machine type at the row's end (design 2f). A line that names no
 * profile is still a step the person can read; the row prints it alone rather
 * than inventing an owner that no read names.
 */
function StepRow({ line }: { line: StepLine }) {
  const { step, profile } = stepPartsOf(line.rest);
  return <StepRowInner glyph={line.glyph} step={step} profile={profile} />;
}

function StepRowInner({
  glyph,
  step,
  profile,
}: {
  glyph: (typeof STEP_GLYPHS)[number];
  step: string;
  profile: string | null;
}) {
  return (
    <p
      data-testid="assistant-step-row"
      data-state={glyph === "✓" ? "done" : glyph === "●" ? "current" : "later"}
      className="m-0 flex items-baseline gap-[6px] text-[12.5px] leading-[1.5] text-ink"
    >
      <span
        aria-hidden="true"
        className={`inline-flex w-[12px] flex-shrink-0 items-center justify-center ${
          glyph === "✓" ? "text-st-done-pale-fg" : glyph === "●" ? "text-accent" : "text-faint"
        }`}
      >
        {glyph === "✓" ? (
          <IconCheck size={12} stroke={2} className="shrink-0" />
        ) : glyph === "●" ? (
          <IconPointFilled size={12} stroke={2} className="shrink-0" />
        ) : (
          <IconPoint size={12} stroke={2} className="shrink-0" />
        )}
      </span>
      <span data-testid="assistant-step-name" className="min-w-0 flex-1 truncate">
        {step}
      </span>
      {profile ? (
        <span
          data-testid="assistant-step-profile"
          className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-faint"
          title={profile}
        >
          {profile}
        </span>
      ) : null}
      <span className="sr-only">
        {glyph === "✓" ? " (done)" : glyph === "●" ? " (next)" : " (later)"}
      </span>
      {profile ? <span className="sr-only">{` runs on ${profile}`}</span> : null}
    </p>
  );
}

/**
 * A GFM table inside an answer (`| name | meta |` + `|---|---|` + body rows).
 *
 * The app's markdown reader keeps a pipe row as paragraph text (its own header
 * says so), which is honest for a plan and useless for the answer the assistant
 * writes when it compares workflows, credentials or runs — the lab screenshots
 * printed the raw pipes. The table is therefore read HERE, in the answer
 * renderer, and drawn as the compact table the design draws: a mono uppercase
 * header row faint as every other panel header, 12.5px body rows on 1px line
 * rules, and a horizontal scroll INSIDE the bubble when the columns are wider
 * than the column (never a bubble that stretches past the transcript).
 *
 * Cells keep their inline markup — `` `code` `` and **bold** — through the same
 * reader the prose uses; nothing here is turned into HTML (ADR-0020).
 */
interface AnswerTableData {
  header: string[];
  rows: string[][];
}

/** One pipe row's cells, or null when the line is not a table row at all. */
function tableCellsOf(line: string): string[] | null {
  const text = line.trim();
  if (text.length === 0 || !text.includes("|")) return null;
  const body = text.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    // An escaped pipe is a pipe in the cell, not a column break.
    if (body[i] === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (body[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += body[i];
  }
  cells.push(current.trim());
  return cells;
}

/** The `|---|:--:|` rule row: every cell is dashes with optional alignment. */
function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** Where a table starts in one prose run, as its line index (or null). */
function tableStartOf(lines: string[]): number | null {
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = tableCellsOf(lines[i]);
    const separator = tableCellsOf(lines[i + 1]);
    if (header === null || separator === null) continue;
    if (header.length !== separator.length || !isTableSeparator(separator)) continue;
    return i;
  }
  return null;
}

/**
 * Split one prose run into the pieces the answer is made of: prose stays prose,
 * a header row + separator row + the body rows under it become one table.
 */
function answerPieces(
  text: string,
): Array<{ type: "prose"; text: string } | ({ type: "table" } & AnswerTableData)> {
  const lines = text.split("\n");
  const pieces: Array<{ type: "prose"; text: string } | ({ type: "table" } & AnswerTableData)> = [];
  let prose: string[] = [];
  const flush = () => {
    const joined = prose.join("\n");
    if (joined.trim().length > 0) pieces.push({ type: "prose", text: joined });
    prose = [];
  };
  for (let i = 0; i < lines.length;) {
    const start = tableStartOf(lines.slice(i));
    if (start === null) {
      prose.push(...lines.slice(i));
      break;
    }
    prose.push(...lines.slice(i, i + start));
    flush();
    const at = i + start;
    const header = tableCellsOf(lines[at]) as string[];
    let next = at + 2;
    const rows: string[][] = [];
    while (next < lines.length) {
      const cells = tableCellsOf(lines[next]);
      if (cells === null) break;
      rows.push(header.map((_, column) => cells[column] ?? ""));
      next += 1;
    }
    pieces.push({ type: "table", header, rows });
    i = next;
  }
  flush();
  return pieces;
}

function AnswerTable({ header, rows }: AnswerTableData) {
  return (
    <div
      data-testid="assistant-table"
      className="max-w-full overflow-x-auto rounded-[3px] border border-line bg-surface py-[2px]"
    >
      <table className="w-full max-w-none border-collapse text-left text-[12.5px] leading-[1.45] text-ink">
        <thead>
          <tr>
            {header.map((cell, column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-line px-[8px] py-[4px] text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint"
              >
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} data-testid="assistant-table-row">
              {header.map((_, column) => (
                <td key={column} className="border-b border-line-soft px-[8px] py-[4px] align-top">
                  {renderInline(row[column] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The answer's prose: `answer_markdown` read as markdown (review 2f: the
 * draft's `**Adapter swap → PR**` reached the person as asterisks). The
 * app's own markdown reader (`lib/markdown.tsx`) draws the paragraphs,
 * emphasis, code spans and lists — never HTML, so nothing the model wrote
 * can render as the app's origin (ADR-0020). The draft step list is split
 * out first: its ✓ / ● / · glyphs carry a state word, which is a states.ts
 * contract this generic reader does not know about.
 *
 * Design 2f round 12: when the answer carries the saved draft's `Open draft`
 * link (`draftId`), the list is the DRAFT's real steps — the model's step
 * lines are dropped from the prose and never drawn as the list, while its
 * prose paragraphs stay. Without a draft, the model's own step lines stand
 * — downgraded, though: a ✓ is never shown while this answer's question card
 * is still open, because nothing is settled until the question is answered.
 */
function AnswerProse({
  text,
  draftId,
  openQuestion,
}: {
  text: string;
  draftId: string | null;
  openQuestion: AssistantQuestionPayload | null;
}) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  // One sentence twice is twice nothing: the open question card already
  // carries its question, so a verbatim repeat in the prose is dropped
  // (rcn-review13-2f) before the step runs settle.
  const chunks = dropQuestionDuplicates(
    settleStepChunks(paragraphs.flatMap((paragraph) => chunkParagraph(paragraph))),
    openQuestion,
  );
  const lines = chunks.flatMap((chunk) => (chunk.type === "steps" ? chunk.lines : []));
  const modelLines =
    openQuestion === null
      ? lines
      : lines.map((line) => (line.glyph === "✓" ? { ...line, glyph: "·" as const } : line));
  const firstSteps = chunks.findIndex((chunk) => chunk.type === "steps");
  const draftList = (key?: string | number): ReactElement => (
    <DraftStepList
      key={key}
      draftId={draftId as string}
      lines={modelLines}
      openQuestion={openQuestion}
    />
  );
  return (
    // a11y (axe link-in-text-block, WCAG 1.4.1): an inline link in the
    // answer's running text must not rely on colour alone. The app's base
    // rule underlines links inside `<p>` (`tokens.css`); a markdown LIST
    // item is not a `<p>`, so its links ride no cue at all. The utility
    // below extends the app's inline-link underline to EVERY link the
    // reader draws in this answer — paragraphs keep the same treatment,
    // list/quote links gain the one they were missing.
    <div
      data-testid="assistant-answer"
      className="space-y-[6px] [&_a]:underline [&_a]:underline-offset-2"
    >
      {chunks.map((chunk, index) => {
        if (chunk.type === "steps") {
          if (draftId === null) return <StepList key={index} lines={modelLines} />;
          // The draft is the list: its steps stand where the model's lines
          // first appeared; later model step runs are dropped, not drawn.
          return index === firstSteps ? draftList(index) : null;
        }
        return (
          <div key={index} className="space-y-[6px]">
            {answerPieces(chunk.text).map((piece, pieceIndex) =>
              piece.type === "table" ? (
                <AnswerTable key={pieceIndex} header={piece.header} rows={piece.rows} />
              ) : (
                <MarkdownBody
                  key={pieceIndex}
                  text={piece.text}
                  paragraphClassName="m-0 text-[13px] leading-[1.45] text-ink"
                />
              ),
            )}
          </div>
        );
      })}
      {draftId !== null && firstSteps === -1 ? draftList("draft") : null}
    </div>
  );
}

/**
 * The draft-backed step list (design 2f round 12): the saved draft's
 * top-level nodes in document order, each with the agent profile / kind
 * label that runs it — the draft is the list, not the model's marks.
 * Until the document is available (still loading, or the read / parse
 * failed) the model's own lines stand in so the list is never empty; the
 * moment the document reads, only ITS steps are drawn.
 */
function DraftStepList({
  draftId,
  lines,
  openQuestion,
}: {
  draftId: string;
  lines: StepLine[];
  openQuestion: AssistantQuestionPayload | null;
}) {
  const { data, isError } = useDraft(draftId);
  const rows =
    data !== undefined && !isError ? draftStepRows(data.document_yaml, openQuestion) : null;
  return (
    <div data-testid="assistant-step-list" className="flex flex-col gap-[2px] py-[2px]">
      {rows !== null
        ? rows.map((row) => (
            <StepRowInner
              key={row.name}
              glyph={row.state === "done" ? "✓" : row.state === "current" ? "●" : "·"}
              step={row.name}
              profile={row.profile}
            />
          ))
        : lines.map((line, index) => <StepRow key={index} line={line} />)}
    </div>
  );
}

/**
 * Transparency, not a replay log: what the turn looked at, collapsed by
 * default (handoff A4 §4: the line names the TOOLS — `used workflow.list`,
 * `used run.nodes, palette.search +2` — never a count of them), with the
 * judge's verdict beside it when one verdict covered the turn (CONTRACT §3).
 * Marks inside the list: IconCheck ok / IconX failed, with the server-supplied
 * summary sentence and each call's own judge verdict.
 */
const JUDGE_WORD: Record<"allowed" | "asked" | "unavailable", string> = {
  allowed: "judge allowed",
  asked: "judge asked",
  unavailable: "judge unavailable",
};

/** How many tool names the folded line spells out before it counts the rest. */
const DISCLOSED_TOOL_NAMES = 2;

/**
 * The folded disclosure line: `used workflow.list · judge allowed`,
 * `used run.nodes, palette.search`, `used a, b +2`. The names are the tools
 * themselves in the order the turn called them (a tool called twice is named
 * once — the list is what was looked at, and the expansion carries every
 * call); the count is what the names do not spell out.
 */
export function toolDisclosureLine(calls: AssistantAnswerPayload["tool_calls"]): string {
  const names: string[] = [];
  for (const call of calls) if (!names.includes(call.name)) names.push(call.name);
  const shown = names.slice(0, DISCLOSED_TOOL_NAMES).join(", ");
  const rest = names.length - DISCLOSED_TOOL_NAMES;
  const verdicts: AssistantToolCallJudge[] = [];
  for (const call of calls) {
    const judge = judgeOf(call);
    if (judge !== null && !verdicts.includes(judge)) verdicts.push(judge);
  }
  // One verdict for the whole turn rides the line; mixed verdicts are said per
  // row, where each call's own answer stands next to its name.
  const tag = verdicts.length === 1 ? ` · ${JUDGE_WORD[verdicts[0]]}` : "";
  return `used ${shown}${rest > 0 ? ` +${rest}` : ""}${tag}`;
}

function ToolDisclosure({ calls }: { calls: AssistantAnswerPayload["tool_calls"] }) {
  if (calls.length === 0) return null;
  return (
    <details data-testid="assistant-tools" className="mt-[6px]">
      {/* The same row as the setup checklist's `used system.status` line
          (design L209–212 / L241–292): top rule, chevron FIRST, mono line. */}
      <ToolRuleLine as="summary" className="max-w-full cursor-pointer">
        {toolDisclosureLine(calls)}
      </ToolRuleLine>
      <ul className="m-0 mt-[4px] list-none space-y-[2px] p-0">
        {calls.map((call, index) => (
          <ToolRow key={`${call.name}-${index}`} call={call} />
        ))}
      </ul>
    </details>
  );
}

/** One line of the disclosure — the judge's verdict rides the folded
 * `AssistantToolCall.judge` field (CONTRACT §3), read through the accessor so
 * a wire row carrying anything else reads as no verdict. */
function ToolRow({ call }: { call: AssistantAnswerPayload["tool_calls"][number] }) {
  const judge = judgeOf(call);
  return (
    <li
      data-testid="assistant-tool-row"
      className="flex items-baseline gap-[6px] font-mono text-[10.5px] text-muted"
    >
      <span aria-hidden="true" className="inline-flex flex-shrink-0">
        {call.ok ? (
          <IconCheck size={11} stroke={2} className="shrink-0" />
        ) : (
          <IconX size={11} stroke={2} className="shrink-0" />
        )}
      </span>
      <span className="flex-shrink-0 truncate">{`used ${call.name}`}</span>
      {judge ? (
        <span data-testid="assistant-tool-judge" className="flex-shrink-0 text-faint">
          {` · ${JUDGE_WORD[judge]}`}
        </span>
      ) : null}
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>{call.summary}</span>
      {!call.ok && call.reason ? (
        <span className="flex-shrink-0 text-st-failed-tag-fg">{call.reason}</span>
      ) : null}
    </li>
  );
}

export default MessageList;
