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
import { formatTime } from "../lib/format";

import { PlanView } from "./m4/PlanView";
import { MarkdownBody } from "../lib/markdown";

import { Button } from "./ds/Button";
import { StatusChip } from "./ds/Row";
import { PERMISSION_STATE, TOOL_STATE, stateOf } from "./ds/states";

/** Local clock time `HH:MM` in the reader's locale (full timestamp rides `title`). */
export function formatLocalHHMM(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

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
    // 1g: the agent's prose reads at 13.5/21 — a person talking, not a table.
    // rcn-3d round 14: the reply is the agent's own MARKDOWN (back-ticked
    // repo names, `**bold**` answers, `- ` findings), and printed raw it
    // arrived with its markers as characters (`the `server` repository agent`,
    // `- The `server` repo …`) while the mail card just above rendered the
    // same `README` as a code chip. The reader is `MarkdownBody` — the app's
    // own renderer (React text nodes, never HTML, ADR-0020), the one the mail
    // card, the plan view and the artifacts already read with — applied to
    // EVERY agent row, including a reply streamed in chunks: the fold has
    // already joined the chunks into this one text, so one block reads it
    // whole. Prose with no markers reads exactly as it did.
    return (
      <div
        className="break-words text-[14.5px] leading-[22px] text-ink"
        data-testid="agent-message-body"
      >
        <MarkdownBody text={text} paragraphClassName="m-0" />
      </div>
    );
  }
  return (
    <div data-testid="agent-plan">
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
      className="overflow-hidden rounded-[10px] border border-line-soft bg-surface"
    >
      <button
        type="button"
        data-testid={`tool-row-${item.toolCallId}`}
        aria-expanded={open}
        onClick={cycle}
        className="flex w-full items-center gap-2 px-[10px] py-[6px] text-left font-mono text-[12px] text-muted"
      >
        <span
          aria-hidden="true"
          className={`inline-block w-3 shrink-0 text-center font-mono text-[12px] text-muted transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          {"\u203a"}
        </span>
        <span className="shrink-0 truncate font-mono text-[11px] uppercase tracking-[.04em] text-muted">
          {item.toolKind || "tool"}
        </span>
        {/* One line, ellipsized: the full command is one click away below. */}
        <span
          className="min-w-0 flex-auto truncate font-mono text-[12px] text-muted"
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
      </button>
      {open ? (
        <div className="rounded-b-[10px] border-t border-line-soft bg-rail px-[10px] pb-2 pt-1">
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
  /** Signed-in reader's user id; their own messages label the author "you". */
  currentUserId?: string | null;
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

/** Whole-unit label for the expired card's sentence: "30 seconds", "2 minutes",
 * "1 hour" — the nearest unit that divides the window, so a 10-minute default
 * reads "10 minutes" and never "600 seconds". */
function windowLabel(ms: number): string {
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const seconds = Math.round(ms / 1000);
  if (seconds % 3600 === 0) return say(seconds / 3600, "hour");
  if (seconds % 60 === 0) return say(seconds / 60, "minute");
  return say(seconds, "second");
}

/**
 * The approval window an expired prompt was given, in words, or `null` when
 * the card cannot honestly state one (a frame missing `requested_at` or the
 * deadline). The worker opens the row with `deadline_at = requested_at +
 * PermissionTTL`, so the two journal stamps carry the deployment's TTL
 * without the UI ever reading worker config.
 */
export function permissionWindowLabel(
  item: Extract<TranscriptItem, { kind: "permission" }>,
): string | null {
  if (!item.deadlineAt || !item.requestedAt) return null;
  const ms = Date.parse(item.deadlineAt) - Date.parse(item.requestedAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return windowLabel(ms);
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
  const isExpired = item.status === "expired";
  const chosen = item.options.find((option) => option.option_id === item.decisionOptionId);
  const state = stateOf(PERMISSION_STATE[item.status]);

  const cardTone = open
    ? "border-st-waiting-pale-edge bg-st-waiting-pale-body"
    : isExpired
      ? "border-st-failed-pale-edge bg-st-failed-pale-body"
      : "border-line bg-surface";
  const barToneClass = open
    ? "border-st-waiting-pale-edge bg-st-waiting-pale-bar text-st-waiting-pale-fg"
    : isExpired
      ? "border-st-failed-pale-edge bg-st-failed-pale-bar text-st-failed-pale-fg"
      : "border-line-soft bg-rail text-ink-2";

  return (
    // The row carries the request id so a reader (test or human) can pin THIS
    // card across the pending→decided transition instead of matching on title
    // text, which two turns of the same prompt can share. The id doubles as
    // the scroll target the thread header's `Review` button focuses — the li
    // takes programmatic focus (`tabIndex={-1}`) so a keyboard reader lands on
    // the ask itself, not wherever the scroll happened to park.
    <li data-testid="transcript-item" data-permission-request-id={item.requestId} tabIndex={-1}>
      <div
        data-testid="permission-card"
        role="status"
        className={`overflow-hidden rounded-[10px] border ${cardTone}`}
      >
        <div
          data-ds-bar=""
          data-tone={open ? "strong" : "neutral"}
          className={`flex items-center gap-2 border-b px-[12px] py-[6px] font-mono text-[10.5px] font-semibold tracking-[.04em] ${barToneClass}`}
        >
          <span aria-hidden="true">{open ? "! PERMISSION REQUEST" : "PERMISSION REQUEST"}</span>
          {open ? (
            item.deadlineAt ? (
              <span className="ml-auto font-normal" data-testid="permission-deadline">
                expires: {item.deadlineAt.slice(11, 19)} UTC
              </span>
            ) : null
          ) : (
            <span className="ml-auto font-normal">
              <StatusChip
                state={state}
                label={item.status}
                className="h-[15px] normal-case"
                labelProps={{ "data-testid": `permission-status-${item.requestId}` }}
              />
            </span>
          )}
        </div>
        <div className="px-[12px] py-[10px] text-body">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-ink">{item.title}</span>
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

          {item.status === "expired" && permissionWindowLabel(item) ? (
            <p className="mt-1 text-[12.5px] text-ink" data-testid="permission-expired-copy">
              Nobody answered within {permissionWindowLabel(item)}, so the agent was told no.
            </p>
          ) : null}

          {open && canDecide ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {item.options.map((option, index) => {
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
              {controllerName ? ` (${controllerName})` : ""} can answer this — take control to
              decide.
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
        </div>
      </div>
    </li>
  );
}

type SystemItem = Extract<TranscriptItem, { kind: "system" }>;
type RenderGroup =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "system-group"; items: SystemItem[] };

function groupTranscriptItems(items: readonly TranscriptItem[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (const item of items) {
    if (item.kind === "system") {
      const prev = groups[groups.length - 1];
      if (prev && prev.kind === "system-group") {
        prev.items.push(item);
      } else {
        groups.push({ kind: "system-group", items: [item] });
      }
    } else {
      groups.push({ kind: "item", item });
    }
  }
  return groups;
}

/**
 * The conversation transcript: one journal, rendered as a live region so new
 * agent text is announced politely (a reconnect that replays rows is not — the
 * items are deduplicated by `global_seq` upstream).
 */
export default function Transcript({
  items,
  agentName = "agent",
  currentUserId = null,
  canDecide,
  controllerName,
  nameOf,
  onDecide,
  decidingRequestId,
  decisionError,
  decisionErrorRequestId,
}: TranscriptProps) {
  const [expandedSystemGroups, setExpandedSystemGroups] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupTranscriptItems(items), [items]);

  if (items.length === 0) {
    return (
      <p className="text-[12.5px] text-muted" data-testid="transcript-empty">
        No transcript yet — send a prompt to start the thread.
      </p>
    );
  }

  return (
    <ol
      className="space-y-[18px]"
      data-testid="transcript"
      aria-label="Thread transcript"
      aria-live="polite"
      aria-relevant="additions"
    >
      {groups.map((group) => {
        if (group.kind === "system-group") {
          const sysItems = group.items;
          if (sysItems.length === 1) {
            const sys = sysItems[0];
            return (
              <li
                key={sys.id}
                data-testid="transcript-item"
                title={sys.raw}
                className="font-mono text-[11px] text-muted"
              >
                {sys.text}
              </li>
            );
          }
          const first = sysItems[0];
          const last = sysItems[sysItems.length - 1];
          const hiddenCount = sysItems.length - 1;
          const expanded = Boolean(expandedSystemGroups[first.id]);
          if (expanded) {
            return sysItems.map((sys) => (
              <li
                key={sys.id}
                data-testid="transcript-item"
                title={sys.raw}
                className="font-mono text-[11px] text-muted"
              >
                {sys.text}
              </li>
            ));
          }
          return [
            ...sysItems.slice(0, -1).map((sys) => (
              <li key={sys.id} data-testid="transcript-item" title={sys.raw} className="sr-only">
                {sys.text}
              </li>
            )),
            <li
              key={last.id}
              data-testid="transcript-item"
              title={last.raw}
              className="flex items-baseline gap-2 font-mono text-[11px] text-muted"
            >
              <span>{last.text}</span>
              <button
                type="button"
                data-testid={`system-group-expand-${first.id}`}
                aria-expanded={false}
                aria-label={`Show ${hiddenCount} earlier system ${hiddenCount === 1 ? "line" : "lines"}`}
                onClick={() => setExpandedSystemGroups((prev) => ({ ...prev, [first.id]: true }))}
                className="shrink-0 rounded-[4px] border border-line px-[5px] py-[1px] font-mono text-[10px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                +{hiddenCount}
              </button>
            </li>,
          ];
        }

        const item = group.item;
        switch (item.kind) {
          case "user": {
            // ADR-0062: it is only ever the *author's* line when the turn row
            // says a human submitted it. For an automation the author line names
            // who authorised it, because this prompt is not something that person typed.
            const automation = automationViaWords(item.submittedVia);
            const isSelf = Boolean(currentUserId && item.authorUserId === currentUserId);
            const who = isSelf ? "you" : nameOf(item.authorUserId);
            return (
              <li key={item.id} data-testid="transcript-item" className="flex flex-col gap-[4px]">
                {automation ? (
                  <div
                    className="flex items-center gap-1.5 font-mono text-[11px] text-muted"
                    title={formatTime(item.at)}
                  >
                    <span data-testid="turn-on-behalf-of">
                      on behalf of {nameOf(item.authorUserId)} · {automation}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={item.at}>{formatLocalHHMM(item.at)}</time>
                  </div>
                ) : (
                  <div
                    className="font-mono text-[11px] text-muted"
                    data-testid="user-speaker"
                    title={formatTime(item.at)}
                  >
                    {who} · <time dateTime={item.at}>{formatLocalHHMM(item.at)}</time>
                  </div>
                )}
                <p className="m-0 whitespace-pre-wrap break-words text-[14.5px] leading-[22px] text-ink">
                  {item.text}
                </p>
              </li>
            );
          }
          case "agent": {
            // A whitespace-only agent message draws nothing.
            if (item.text.trim() === "") return null;
            return (
              <li key={item.id} data-testid="transcript-item" className="flex flex-col gap-[4px]">
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono text-[11px] text-muted"
                    data-testid="agent-speaker"
                    title={formatTime(item.at)}
                  >
                    {agentName} · <time dateTime={item.at}>{formatLocalHHMM(item.at)}</time>
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
          }
          case "thought":
            return (
              <li
                key={item.id}
                data-testid="transcript-item"
                className="overflow-hidden rounded-[10px] border border-line-soft bg-surface"
              >
                {/* Collapsed by default: thoughts are context, not the record. */}
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-[10px] py-[6px] font-mono text-[12px] text-muted">
                    <span
                      aria-hidden="true"
                      className="inline-block w-3 shrink-0 text-center font-mono text-[12px] text-muted transition-transform group-open:rotate-90"
                    >
                      {"\u203a"}
                    </span>
                    <span>Agent thought{item.truncated ? " (truncated)" : ""}</span>
                  </summary>
                  <div className="rounded-b-[10px] border-t border-line-soft bg-rail px-[10px] py-2 whitespace-pre-wrap text-[12.5px] text-muted">
                    {item.text}
                  </div>
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
          default:
            return null;
        }
      })}
    </ol>
  );
}
