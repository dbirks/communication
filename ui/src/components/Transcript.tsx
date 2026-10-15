import { problemOf } from "../api/client";
import type { TranscriptItem } from "../api/transcript";
import type { PermissionOption } from "../api/types";

const itemClass = "rounded border border-gray-200 px-3 py-2 text-sm";

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

  return (
    <li data-testid="transcript-item" className={`${itemClass} border-amber-300 bg-amber-50`}>
      <div data-testid="permission-card">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">Permission request</span>
          <span className="text-sm">{item.title}</span>
          {item.toolKind ? <span className="text-gray-600">kind: {item.toolKind}</span> : null}
          {item.deadlineAt ? (
            <span className="text-gray-600">expires: {item.deadlineAt.slice(11, 19)} UTC</span>
          ) : null}
        </div>
        {/* Status is written out, never implied by the border colour. */}
        <p className="mt-1 text-sm text-gray-800" role="status">
          status: {item.status === "pending" ? "awaiting a decision" : item.status}
          {item.status === "decided" && item.decisionOptionId
            ? ` — answered "${chosen?.label || item.decisionOptionId}"${
                item.decidedBy ? ` by ${nameOf(item.decidedBy)}` : ""
              }`
            : ""}
        </p>

        {open && canDecide ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {item.options.map((option, index) => (
              <button
                key={option.option_id}
                type="button"
                data-testid={testids[index]}
                disabled={deciding}
                onClick={() => onDecide(item.requestId, option)}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-900 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50"
              >
                {option.label || option.option_id}
              </button>
            ))}
            <p className="sr-only" data-testid="permission-deciding" aria-live="polite">
              {deciding ? "Sending your decision…" : ""}
            </p>
          </div>
        ) : null}

        {open && !canDecide ? (
          <p className="mt-1 text-sm text-gray-700" data-testid="permission-readonly">
            Only the controller{controllerName ? ` (${controllerName})` : ""} can answer this. Take
            control to decide.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mt-1 text-sm text-red-900" data-testid="permission-error">
            {problemOf(error).detail || "Your decision could not be recorded."}
          </p>
        ) : null}
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
      <p className="text-sm text-gray-600" data-testid="transcript-empty">
        No transcript yet — send a prompt to start the conversation.
      </p>
    );
  }

  return (
    <ol
      className="space-y-2"
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
              <li
                key={item.id}
                data-testid="transcript-item"
                className={`${itemClass} border-blue-200 bg-blue-50`}
              >
                <span className="font-semibold">Agent</span>
                {item.final ? null : (
                  <span className="ml-2 text-sm text-gray-700" role="status">
                    writing…
                  </span>
                )}
                {item.truncated ? (
                  <span className="ml-2 text-sm text-gray-700">(truncated)</span>
                ) : null}
                <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
              </li>
            );
          case "thought":
            return (
              <li key={item.id} data-testid="transcript-item" className={`${itemClass} bg-gray-50`}>
                {/* Collapsed by default: thoughts are context, not the record. */}
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-gray-700">
                    Agent thought {item.truncated ? "(truncated)" : ""}
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{item.text}</p>
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
                <span className="ml-2 text-sm" data-testid={`tool-status-${item.toolCallId}`}>
                  status: {item.status}
                </span>
                {item.toolKind ? (
                  <span className="ml-2 text-sm text-gray-600">{item.toolKind}</span>
                ) : null}
                {item.inputPreview ? (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-sm text-gray-700">
                    {item.inputPreview}
                  </pre>
                ) : null}
                {item.outputPreview ? (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-sm text-gray-700">
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
                className="text-sm text-gray-600 italic"
              >
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
