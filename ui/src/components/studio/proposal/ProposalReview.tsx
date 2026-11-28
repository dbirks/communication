/**
 * ProposalReview — the review panel for an assistant proposal (editor
 * interactions 1d). A docked panel on the right of the canvas (a bottom sheet
 * on phone) that lists every change the proposal makes — added steps, edited
 * steps with their field diffs, removed steps — in that order.
 *
 * One commit point: there is no per-change accept/reject here (the changes
 * depend on each other, so a partial apply gives a workflow nobody proposed);
 * the Discard/Apply buttons live in the proposal bar, or in `footer` on phone.
 * Focus is ink and linked: ↑↓ moves between rows, ↵ (or the target icon)
 * shows the change on the canvas, esc closes. The panel is presentational —
 * the diff comes from `proposalDiff`, the canvas link is the caller's job.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { IconFocus2, IconMinus, IconPencil, IconPlus, IconX } from "@tabler/icons-react";
import type { EditedStep, FieldChange, ProposalDiff, StepChange } from "./proposalDiff";

export interface ProposalReviewProps {
  diff: ProposalDiff;
  /** The change whose row is focused (ink border). */
  focusedId: string | null;
  /** A row was focused (click or ↑↓). */
  onFocus(id: string): void;
  /** Enter on a row, or its "show on canvas" icon button. */
  onShowOnCanvas(id: string): void;
  /** × and Escape. */
  onClose(): void;
  /** Phone: bottom sheet (full width, rounded top, max-h-[60dvh]). */
  sheet?: boolean;
  /** Phone: the Discard / Apply buttons go here. */
  footer?: ReactNode;
}

type Row =
  | { kind: "added"; step: StepChange }
  | { kind: "edited"; step: EditedStep }
  | { kind: "removed"; step: StepChange };

/** A word-diff piece: `same` rides between the marks. */
interface WordOp {
  text: string;
  kind: "same" | "add" | "del";
}

const WORD_MARK_CAP = 400_000;

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t !== "");
}

function push(ops: WordOp[], kind: WordOp["kind"], text: string) {
  const last = ops[ops.length - 1];
  if (last && last.kind === kind) last.text += text;
  else ops.push({ kind, text });
}

/**
 * Word diff: split on whitespace (keep the runs so spacing survives) and take
 * the longest common subsequence; anything off the sequence is a removed or an
 * added word. Written here — no diff dependency.
 */
export function wordDiff(before: string, after: string): WordOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  if (n * m > WORD_MARK_CAP) {
    const ops: WordOp[] = [];
    if (n > 0) push(ops, "del", before);
    if (m > 0) push(ops, "add", after);
    return ops;
  }
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: WordOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(ops, "same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(ops, "del", a[i]);
      i++;
    } else {
      push(ops, "add", b[j]);
      j++;
    }
  }
  while (i < n) push(ops, "del", a[i++]);
  while (j < m) push(ops, "add", b[j++]);
  return ops;
}

/** Compact display for any field value (arrays and objects as JSON). */
function showValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const needsWordDiff = (value: unknown) =>
  typeof value === "string" && (value.length > 40 || value.includes("\n"));

/** "config.prompt" → "PROMPT", "dependsOn" → "DEPENDSON". */
function fieldLabel(field: string): string {
  const own = field.startsWith("config.") ? field.slice("config.".length) : field;
  return own.toUpperCase();
}

function FieldDiff({ change }: { change: FieldChange }) {
  const long = needsWordDiff(change.before) || needsWordDiff(change.after);
  const bothStrings = typeof change.before === "string" && typeof change.after === "string";
  return (
    <div className="flex min-w-0 flex-col gap-[2px]">
      <span className="font-mono text-[10.5px] font-semibold uppercase text-muted">
        {fieldLabel(change.field)}
      </span>
      <div className="min-w-0 break-words text-[12.5px] leading-[18px]">
        {long && bothStrings ? (
          <span>
            {wordDiff(change.before as string, change.after as string).map((op, i) => (
              <span
                key={i}
                data-diff={op.kind}
                className={
                  op.kind === "del"
                    ? "bg-st-failed-tag text-st-failed-tag-fg line-through"
                    : op.kind === "add"
                      ? "text-accent-text underline"
                      : ""
                }
              >
                {op.text}
              </span>
            ))}
          </span>
        ) : (
          <span>
            {change.before !== undefined ? (
              <span className="line-through text-muted">{showValue(change.before)}</span>
            ) : null}
            {change.before !== undefined && change.after !== undefined ? " → " : null}
            {change.after !== undefined ? (
              <span className="text-accent-text">{showValue(change.after)}</span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}

function StepRow({
  row,
  focused,
  innerRef,
  onFocusRow,
  onShow,
  edges,
}: {
  row: Row;
  focused: boolean;
  innerRef: (node: HTMLDivElement | null) => void;
  onFocusRow(id: string): void;
  onShow(id: string): void;
  edges: { from: string; to: string }[];
}) {
  const { step } = row;
  const Icon = row.kind === "added" ? IconPlus : row.kind === "edited" ? IconPencil : IconMinus;
  const tileClass =
    row.kind === "removed"
      ? "bg-st-failed-tag text-st-failed-tag-fg"
      : "bg-accent-tint text-accent-edge";
  const meta =
    row.kind === "added"
      ? step.isScope
        ? "new wrap"
        : "new step"
      : row.kind === "edited"
        ? step.isScope
          ? "wrap"
          : "edited"
        : "removed";
  return (
    <div
      ref={innerRef}
      tabIndex={0}
      data-testid={`proposal-change-${step.id}`}
      onFocus={() => onFocusRow(step.id)}
      onClick={() => onFocusRow(step.id)}
      className={`flex cursor-default flex-col gap-[6px] rounded-[10px] border p-[10px] outline-none ${
        focused ? "border-ink" : "border-line"
      }`}
    >
      <div className="flex min-w-0 items-center gap-[8px]">
        <span
          aria-hidden="true"
          className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] ${tileClass}`}
        >
          <Icon size={13} stroke={1.75} />
        </span>
        <span
          className={`min-w-0 truncate text-[13.5px] font-semibold ${
            row.kind === "removed" ? "text-muted line-through" : "text-ink"
          }`}
        >
          {step.id}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {meta} · {step.kind}
        </span>
        {row.kind !== "removed" ? (
          <button
            type="button"
            aria-label="Show on canvas"
            data-testid={`proposal-show-${step.id}`}
            onClick={() => onShow(step.id)}
            className="icon-hit ml-auto inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconFocus2 size={15} stroke={1.5} aria-hidden />
          </button>
        ) : null}
      </div>

      {row.kind === "edited"
        ? row.step.fields.map((change) => <FieldDiff key={change.field} change={change} />)
        : null}

      {row.kind === "added" && edges.length > 0 ? (
        <div className="flex flex-col gap-[2px]">
          {edges.map((edge) => (
            <span key={`${edge.from}->${edge.to}`} className="font-mono text-[11px] text-muted">
              {edge.from} → {edge.to}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProposalReview({
  diff,
  focusedId,
  onFocus,
  onShowOnCanvas,
  onClose,
  sheet = false,
  footer,
}: ProposalReviewProps) {
  const rows = useMemo<Row[]>(
    () => [
      ...diff.added.map((step) => ({ kind: "added" as const, step })),
      ...diff.edited.map((step) => ({ kind: "edited" as const, step })),
      ...diff.removed.map((step) => ({ kind: "removed" as const, step })),
    ],
    [diff],
  );

  // Keyboard position. The parent owns `focusedId`; this mirrors it so ↑↓ and
  // ↵ work even before the parent's value comes back around (and so a click
  // inside a row does not re-announce the same focus).
  const [navId, setNavId] = useState<string | null>(focusedId);
  const navRef = useRef<string | null>(focusedId);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (focusedId === navRef.current) return;
    navRef.current = focusedId;
    setNavId(focusedId);
  }, [focusedId]);

  const select = (id: string) => {
    if (navRef.current === id) return;
    navRef.current = id;
    setNavId(id);
    onFocus(id);
  };

  const activeId = navId;

  const move = (delta: 1 | -1) => {
    if (rows.length === 0) return;
    const at = rows.findIndex((row) => row.step.id === activeId);
    const next =
      at === -1
        ? delta === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, at + delta));
    const id = rows[next].step.id;
    rowNodes.current.get(id)?.focus();
    select(id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeId) onShowOnCanvas(activeId);
    }
  };

  const counts: string[] = [];
  if (diff.added.length > 0) counts.push(`${diff.added.length} added`);
  if (diff.edited.length > 0) counts.push(`${diff.edited.length} edited`);
  if (diff.removed.length > 0) counts.push(`${diff.removed.length} removed`);

  const frameClass = sheet
    ? "absolute inset-x-0 bottom-0 z-30 max-h-[60dvh] rounded-t-[14px] rounded-b-none"
    : "absolute right-4 top-[62px] bottom-4 z-30 w-[372px] rounded-[12px]";

  return (
    <section
      role="dialog"
      aria-modal={sheet ? true : undefined}
      aria-label="Review proposed changes"
      data-testid="proposal-review"
      onKeyDown={onKeyDown}
      className={`flex min-h-0 flex-col border border-fill-edge bg-surface shadow-[var(--shadow-pop)] ${frameClass}`}
    >
      <div className="flex shrink-0 flex-col gap-[2px] border-b border-line-soft px-[14px] py-[12px]">
        <div className="flex items-center gap-[8px]">
          <span className="font-mono text-[10.5px] font-semibold tracking-[0.06em] text-muted">
            REVIEW · {diff.count} PROPOSED {diff.count === 1 ? "CHANGE" : "CHANGES"}
          </span>
          <button
            type="button"
            aria-label="Close"
            data-testid="proposal-review-close"
            onClick={onClose}
            className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconX size={15} stroke={1.5} aria-hidden />
          </button>
        </div>
        {counts.length > 0 ? (
          <span className="font-mono text-[10.5px] text-muted">{counts.join(" · ")}</span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p
          className="px-[14px] py-[12px] text-[12.5px] text-muted"
          data-testid="proposal-review-empty"
        >
          Nothing to review: the proposal changes nothing.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-[8px] overflow-y-auto p-[10px]">
          {rows.map((row) => (
            <StepRow
              key={`${row.kind}-${row.step.id}`}
              row={row}
              focused={activeId === row.step.id}
              innerRef={(node) => {
                if (node) rowNodes.current.set(row.step.id, node);
                else rowNodes.current.delete(row.step.id);
              }}
              onFocusRow={select}
              onShow={onShowOnCanvas}
              edges={diff.addedEdges.filter(
                (edge) => edge.from === row.step.id || edge.to === row.step.id,
              )}
            />
          ))}
        </div>
      )}

      <div className="shrink-0 border-t border-line-soft px-[14px] py-[8px] font-mono text-[10.5px] text-muted">
        ↑↓ next change · ↵ show on canvas · esc close
      </div>

      {footer ? (
        <div
          className="shrink-0 border-t border-line-soft p-[10px]"
          data-testid="proposal-review-footer"
        >
          {footer}
        </div>
      ) : null}
    </section>
  );
}
