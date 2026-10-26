import { useMemo, useState } from "react";
import { problemOf } from "../api/client";
import {
  planDocumentOf,
  toolTimingLabel,
  automationViaWords,
  type TranscriptItem,
} from "../api/transcript";
import { deciderLabel } from "../api/actors";
import type { PermissionOption } from "../api/types";
import { formatClock } from "../lib/format";

import { PlanView } from "./m4/PlanView";

import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";
import { StatusChip } from "./ds/Row";
import { PERMISSION_STATE, STATES, TOOL_STATE, stateOf } from "./ds/states";

/** A tool call's streamed preview, shown only when it says something. */
function ToolPreview({
  label,
  text,
  tall = false,
}: {
  label: string;
  text: string;
  tall?: boolean;
}) {
  if (!text) return null;
  return (
    <div className="mt-1">
      <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-faint">
        {label}
      </div>
      {/* Mono (rule 07: machine-produced) and scrollable: a 4 KB diff must not
          push the transcript off the screen. The pre is a focusable scroll
          region (axe scrollable-region-focusable). */}
      <pre
        role="region"
        tabIndex={0}
        aria-label={`${label} (preview)`}
        className={`overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.45] text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
          tall ? "max-h-[45vh]" : "max-h-24"
        }`}
        data-testid={`tool-preview-${label}`}
      >
        {text}
      </pre>
    </div>
  );
}

/** Two-letter initials for a speaker box (6d: `CI` for claude-impl). */
export function speakerInitials(label: string): string {
  const words = label
    .trim()
    .split(/[\s/_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0].slice(0, 1) + words[1].slice(0, 1)).toUpperCase();
}

/** How many output lines the first click reveals. */
const PREVIEW_LINES = 3;

/**
 * An agent message's body: the plan it served, or its text.
 *
 * A planner turn answers with structured output — `{"plan":{"goal":…,"steps":…}}`
 * — which printed raw is one wall of escaped text (`live-conversation-3.png`), so
 * the message renders through the same `PlanView` a gate summary gets. Nothing is
 * substituted: the toggle keeps the original text one click away, a message that
 * is not a whole plan renders exactly as it always did, and the transcript row
 * still carries the text the API wrote.
 */
function AgentMessageBody({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const plan = useMemo(() => planDocumentOf(text), [text]);

  if (!plan) {
    return <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-ink">{text}</p>;
  }
  return (
    <div className="mt-1" data-testid="agent-plan">
      {raw ? (
        <pre
          role="region"
          tabIndex={0}
          aria-label="Raw plan text"
          className="overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.45] text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="agent-plan-raw"
        >
          {text}
        </pre>
      ) : (
        <PlanView text={plan.body} />
      )}
      <button
        type="button"
        aria-expanded={raw}
        onClick={() => setRaw((current) => !current)}
        className="mt-[2px] block font-mono text-[10.5px] text-accent-text hover:text-ink"
        data-testid="agent-plan-toggle"
      >
        {raw ? "plan" : "raw"}
      </button>
    </div>
  );
}

/** The head of a machine block — the whole text when it is already short. */
function headLines(text: string, lines = PREVIEW_LINES): string {
  const parts = text.split("\n");
  return parts.length <= lines ? text : parts.slice(0, lines).join("\n");
}

/**
 * One tool call as a transcript row: kind, the command/title on one line, the
 * state as a chip. The output can run to hundreds of lines and is what makes a
 * transcript unreadable, so it sits behind a click — first click shows its head,
 * the next the whole thing, and a third folds it away. Collapsing is never
 * deleting: the row keeps its title, state, ids and `data-tool-call-id`.
 */
function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const [depth, setDepth] = useState<"closed" | "head" | "all">("closed");
  const open = depth !== "closed";
  const cycle = () =>
    setDepth((current) => (current === "closed" ? "head" : current === "head" ? "all" : "closed"));
  const input = open ? (depth === "all" ? item.inputPreview : headLines(item.inputPreview)) : "";
  const output = open ? (depth === "all" ? item.outputPreview : headLines(item.outputPreview)) : "";
  const hidden =
    depth === "head" &&
    (headLines(item.inputPreview) !== item.inputPreview ||
      headLines(item.outputPreview) !== item.outputPreview);
  // The right slot (the design's diffstat slot): journal time only — a
  // finished call shows its elapsed span, a running one "● running". Never
  // parsed out of prose (honest-data rule).
  const timing = toolTimingLabel(item);

  return (
    <li
      data-testid="transcript-item"
      data-tool-call-id={item.toolCallId}
      className="rounded-[3px] border border-line bg-surface"
    >
      <button
        type="button"
        data-testid={`tool-row-${item.toolCallId}`}
        aria-expanded={open}
        onClick={cycle}
        className="flex w-full items-center gap-2 px-[10px] py-[5px] text-left"
      >
        <span className="w-[54px] shrink-0 truncate font-mono text-[10px] uppercase tracking-[.04em] text-muted">
          {item.toolKind || "tool"}
        </span>
        {/* One line, ellipsized: the full command is one click away below. The
            basis is content (`flex-auto`, i.e. grow+shrink+auto) — not `flex-1`
            (basis 0%), which would leave nothing to shrink when the fixed chip /
            timing / chevron row no longer fits and push the chevron out of the
            column. `min-w-0` lets the title truncate under them. */}
        <span
          className="min-w-0 flex-auto truncate font-mono text-[11.5px] text-ink"
          title={item.title}
        >
          {item.title}
        </span>
        {item.truncated ? (
          <span className="shrink-0 font-mono text-[10px] text-faint">(truncated)</span>
        ) : null}
        <StatusChip
          className="h-[15px]"
          state={stateOf(TOOL_STATE[item.status])}
          label={`status: ${item.status}`}
          labelProps={{ "data-testid": `tool-status-${item.toolCallId}` }}
        />
        {timing ? (
          <span
            data-testid={`tool-timing-${item.toolCallId}`}
            className="min-w-4 w-[72px] shrink text-right font-mono text-[11px] text-muted"
          >
            {timing}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className="w-3 shrink-0 text-center font-mono text-[10px] text-faint"
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-line px-[10px] pb-2">
          <ToolPreview label="input" text={input} tall={depth === "all"} />
          <ToolPreview label="output" text={output} tall={depth === "all"} />
          {!input && !output ? (
            <p className="mt-1 font-mono text-[11px] text-faint" data-testid="tool-preview-empty">
              no input or output was recorded for this call
            </p>
          ) : null}
          <div className="mt-1 flex items-center gap-2">
            {hidden ? (
              <button
                type="button"
                data-testid={`tool-show-all-${item.toolCallId}`}
                className="font-mono text-[10.5px] text-accent-text hover:text-ink"
                onClick={() => setDepth("all")}
              >
                show all
              </button>
            ) : null}
            {depth === "all" ? (
              <button
                type="button"
                data-testid={`tool-collapse-${item.toolCallId}`}
                className="font-mono text-[10.5px] text-muted hover:text-ink"
                onClick={() => setDepth("head")}
              >
                collapse to {PREVIEW_LINES} lines
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export interface TranscriptProps {
  items: TranscriptItem[];
  /** Speaker label for an agent message (the profile name), never a uuid. */
  agentName?: string;
  /** True only for the current controller — a viewer sees prompts read-only. */
  canDecide: boolean;
  /** Name of whoever must answer an open prompt, for the read-only explanation. */
  controllerName: string | null;
  /** Resolves a user id to a display name; never shows a bare uuid alone. */
  nameOf: (userId: string) => string;
  onDecide: (requestId: string, option: PermissionOption) => void;
  /** The prompt whose decision POST is in flight, if any. */
  decidingRequestId: string | null;
  /** Failure for the prompt in `decisionErrorRequestId` only, or null. */
  decisionError: unknown;
  decisionErrorRequestId: string | null;
}

/**
 * Allow/reject testids land on the first option of each kind so the browser
 * proof has stable hooks; every other offered option keeps its own id.
 */
export function optionTestid(option: PermissionOption, taken: Set<string>): string {
  const kind = option.kind ?? "";
  const label = option.label.toLowerCase();
  const isAllow =
    kind.startsWith("allow") || (/allow|approves?/.test(label) && !kind.startsWith("reject"));
  const isReject = kind.startsWith("reject") || /reject|deny/.test(label);
  if (isAllow && !taken.has("permission-allow")) return "permission-allow";
  if (isReject && !taken.has("permission-reject")) return "permission-reject";
  return `permission-option-${option.option_id}`;
}

function PermissionCard({
  item,
  canDecide,
  controllerName,
  nameOf,
  onDecide,
  deciding,
  error,
}: {
  item: Extract<TranscriptItem, { kind: "permission" }>;
  canDecide: boolean;
  controllerName: string | null;
  nameOf: TranscriptProps["nameOf"];
  onDecide: TranscriptProps["onDecide"];
  deciding: boolean;
  error: unknown;
}) {
  const taken = new Set<string>();
  const testids = item.options.map((option) => {
    const id = optionTestid(option, taken);
    taken.add(id);
    return id;
  });
  const open = item.status === "pending";
  const chosen = item.options.find((option) => option.option_id === item.decisionOptionId);
  const state = stateOf(PERMISSION_STATE[item.status]);

  return (
    // The row carries the request id so a reader (test or human) can pin THIS
    // card across the pending→decided transition instead of matching on title
    // text, which two turns of the same prompt can share.
    <li data-testid="transcript-item" data-permission-request-id={item.requestId}>
      {/* Handoff rule 05: a title bar is the state's strong color only while the
          panel needs action, i.e. only for an open request. A decided, expired
          or cancelled prompt is a closed record — gray bar, state as a chip. */}
      <Alert
        state={state}
        label="PERMISSION REQUEST"
        barTone={open ? "strong" : "neutral"}
        testid="permission-card"
        role="status"
        meta={
          open ? (
            item.deadlineAt ? (
              <span data-testid="permission-deadline">
                expires: {item.deadlineAt.slice(11, 19)} UTC
              </span>
            ) : undefined
          ) : (
            <StatusChip
              state={state}
              label={item.status}
              className="h-[15px] normal-case"
              labelProps={{ "data-testid": `permission-status-${item.requestId}` }}
            />
          )
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{item.title}</span>
          {item.toolKind ? (
            <span className="font-mono text-[10.5px] text-muted">kind: {item.toolKind}</span>
          ) : null}
        </div>
        {/* Status is written out, never implied by the border colour. */}
        <p className="mt-1 text-[12.5px] text-ink" role="status">
          status: {item.status === "pending" ? "awaiting a decision" : item.status}
          {item.status === "decided" && item.decisionOptionId
            ? ` — answered "${chosen?.label || item.decisionOptionId}"${
                item.decidedBy ? ` by ${deciderLabel(item.decidedBy, nameOf)}` : ""
              }`
            : ""}
        </p>

        {open && canDecide ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {item.options.map((option, index) => {
              // Royal = something you can do (rule 02); a reject option is
              // the danger variant; anything else is a plain secondary.
              const kind = (option.kind ?? "").toLowerCase();
              const label = option.label.toLowerCase();
              const isAllow = kind.startsWith("allow") || /approve/.test(kind + label);
              const isReject = kind.startsWith("reject") || /reject|deny/.test(kind + label);
              return (
                <Button
                  key={option.option_id}
                  data-testid={testids[index]}
                  variant={isAllow ? "primary" : isReject ? "danger" : "secondary"}
                  compact
                  disabled={deciding}
                  onClick={() => onDecide(item.requestId, option)}
                >
                  {option.label || option.option_id}
                </Button>
              );
            })}
            <p className="sr-only" data-testid="permission-deciding" aria-live="polite">
              {deciding ? "Sending your decision…" : ""}
            </p>
          </div>
        ) : null}

        {open && !canDecide ? (
          <p className="mt-1 text-[12.5px] text-muted" data-testid="permission-readonly">
            Open to decide. Only the controller
            {controllerName ? ` (${controllerName})` : ""} can answer this — take control to decide.
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="mt-1 text-[12.5px] text-st-failed-tag-fg"
            data-testid="permission-error"
          >
            × {problemOf(error).detail || "Your decision could not be recorded."}
          </p>
        ) : null}
      </Alert>
    </li>
  );
}

/**
 * The conversation transcript: one journal, rendered as a live region so new
 * agent text is announced politely (a reconnect that replays rows is not — the
 * items are deduplicated by `global_seq` upstream).
 */
export default function Transcript({
  items,
  agentName = "agent",
  canDecide,
  controllerName,
  nameOf,
  onDecide,
  decidingRequestId,
  decisionError,
  decisionErrorRequestId,
}: TranscriptProps) {
  if (items.length === 0) {
    return (
      <p className="text-[12.5px] text-muted" data-testid="transcript-empty">
        No transcript yet — send a prompt to start the conversation.
      </p>
    );
  }

  return (
    <ol
      className="space-y-[4px]"
      data-testid="transcript"
      aria-label="Conversation transcript"
      aria-live="polite"
      aria-relevant="additions"
    >
      {items.map((item) => {
        switch (item.kind) {
          case "user": {
            // 4f: the user's own prompt reads as a bubble in the accent
            // tint — the agent's prose stays plain text beside it.
            // ADR-0062: it is only ever the *author's* line when the turn row
            // says a human submitted it. For an automation the bubble names who
            // authorised it on a meta line, because this prompt is not
            // something that person typed.
            const automation = automationViaWords(item.submittedVia);
            return (
              <li
                key={item.id}
                data-testid="transcript-item"
                className="rounded-[3px] border border-accent-edge bg-accent-tint px-[10px] py-2 text-[12.5px]"
              >
                {automation ? (
                  <>
                    <span
                      className="block font-mono text-[11px] text-muted"
                      data-testid="turn-on-behalf-of"
                    >
                      on behalf of {nameOf(item.authorUserId)} · {automation}
                    </span>
                    <span className="whitespace-pre-wrap">{item.text}</span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold">{nameOf(item.authorUserId)}:</span>{" "}
                    <span className="whitespace-pre-wrap">{item.text}</span>
                  </>
                )}
              </li>
            );
          }
          case "agent":
            return (
              <li key={item.id} data-testid="transcript-item" className="px-1 py-1">
                {/* 6d's speaker block: an initials box, then a mono who/when line,
                    then the text — so a long agent message reads as a person
                    talking, not as another bordered card. */}
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border border-line-strong bg-surface font-mono text-[9px] font-semibold text-ink-2"
                  >
                    {speakerInitials(agentName)}
                  </span>
                  <span className="font-mono text-[10.5px] text-muted" data-testid="agent-speaker">
                    {agentName} · {formatClock(item.at)}
                  </span>
                  {item.final ? null : (
                    <span className="text-[12px] text-muted" role="status">
                      <span aria-hidden="true" className="text-st-running-strong">
                        ●{" "}
                      </span>
                      writing…
                    </span>
                  )}
                  {item.truncated ? (
                    <span className="font-mono text-[10.5px] text-muted">(truncated)</span>
                  ) : null}
                </div>
                <AgentMessageBody text={item.text} />
              </li>
            );
          case "thought":
            return (
              <li
                key={item.id}
                data-testid="transcript-item"
                className="rounded-[3px] border border-line bg-fill/60 px-[10px] py-2 text-[12.5px]"
              >
                {/* Collapsed by default: thoughts are context, not the record. */}
                <details>
                  <summary className="cursor-pointer font-mono text-[10.5px] font-medium text-muted">
                    AGENT THOUGHT {item.truncated ? "(truncated)" : ""}
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-muted">{item.text}</p>
                </details>
              </li>
            );
          case "tool":
            return <ToolRow key={item.id} item={item} />;
          case "permission":
            return (
              <PermissionCard
                key={item.id}
                item={item}
                canDecide={canDecide}
                controllerName={controllerName}
                nameOf={nameOf}
                onDecide={onDecide}
                deciding={decidingRequestId === item.requestId}
                error={decisionErrorRequestId === item.requestId ? decisionError : null}
              />
            );
          case "system":
            return (
              <li
                key={item.id}
                data-testid="transcript-item"
                className="flex items-baseline gap-2 px-1 py-1 text-[12px] italic text-muted"
              >
                <span aria-hidden="true" className={`font-mono not-italic ${STATES.info.tagFg}`}>
                  i
                </span>
                {item.text}
              </li>
            );
          default:
            return null;
        }
      })}
    </ol>
  );
}
