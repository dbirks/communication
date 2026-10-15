import { problemOf } from "../api/client";
import type { TranscriptItem } from "../api/transcript";
import type { PermissionOption } from "../api/types";

import { Button } from "./ds/Button";
import { StatusChip } from "./ds/Row";
import { PERMISSION_STATE, STATES, TOOL_STATE, stateOf } from "./ds/states";

const itemClass = "rounded-[3px] border border-line-strong bg-surface px-[10px] py-2 text-[12.5px]";

export interface TranscriptProps {
  items: TranscriptItem[];
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
  const spec = STATES[stateOf(PERMISSION_STATE[item.status])];

  return (
    <li data-testid="transcript-item">
      {/* ALERT-K with the title bar in the state's *strong* color: an open
          permission request is the panel-needs-action case. */}
      <div
        data-testid="permission-card"
        className={`overflow-hidden rounded-[3px] border ${spec.paleEdge}`}
      >
        <div
          className={`flex items-center gap-2 border-b px-[10px] py-1 font-mono text-[10px] font-semibold tracking-[.04em] ${spec.strongBg} ${spec.strongFg} ${spec.strongEdge}`}
        >
          <span aria-hidden="true">{spec.glyph} PERMISSION REQUEST</span>
          <span className="ml-auto font-normal opacity-75">
            {item.deadlineAt ? `expires: ${item.deadlineAt.slice(11, 19)} UTC` : ""}
          </span>
        </div>
        <div className={`px-[10px] py-[7px] ${spec.paleBodyBg}`}>
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
                  item.decidedBy ? ` by ${nameOf(item.decidedBy)}` : ""
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
              Only the controller{controllerName ? ` (${controllerName})` : ""} can answer this.
              Take control to decide.
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

/**
 * The conversation transcript: one journal, rendered as a live region so new
 * agent text is announced politely (a reconnect that replays rows is not — the
 * items are deduplicated by `global_seq` upstream).
 */
export default function Transcript({
  items,
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
          case "user":
            return (
              <li key={item.id} data-testid="transcript-item" className={itemClass}>
                <span className="font-semibold">{nameOf(item.authorUserId)}:</span>{" "}
                <span className="whitespace-pre-wrap">{item.text}</span>
              </li>
            );
          case "agent":
            return (
              <li key={item.id} data-testid="transcript-item" className={itemClass}>
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-ink-2">
                  Agent
                </span>
                {item.final ? null : (
                  <span className="ml-2 text-[12.5px] text-muted" role="status">
                    <span aria-hidden="true" className="text-st-running-strong">
                      ●{" "}
                    </span>
                    writing…
                  </span>
                )}
                {item.truncated ? (
                  <span className="ml-2 font-mono text-[10.5px] text-muted">(truncated)</span>
                ) : null}
                <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
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
            return (
              <li
                key={item.id}
                data-testid="transcript-item"
                data-tool-call-id={item.toolCallId}
                className={`${itemClass} font-mono`}
              >
                <span className="font-semibold">{item.title}</span>
                <StatusChip
                  className="ml-2 align-middle"
                  state={stateOf(TOOL_STATE[item.status])}
                  label={`status: ${item.status}`}
                  labelProps={{ "data-testid": `tool-status-${item.toolCallId}` }}
                />
                {item.toolKind ? (
                  <span className="ml-2 text-[10.5px] text-muted">{item.toolKind}</span>
                ) : null}
                {item.inputPreview ? (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted">
                    {item.inputPreview}
                  </pre>
                ) : null}
                {item.outputPreview ? (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted">
                    {item.outputPreview}
                    {item.truncated ? "…" : ""}
                  </pre>
                ) : null}
              </li>
            );
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
