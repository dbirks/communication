/**
 * InsertStepMenu — the body of the beside card opened by a `+` on a connecting
 * line (editor-interactions README "1h"): pick a step type to insert between
 * two steps, or between the last step and "next step" (`mode: "add"`), or
 * describe the step you want and send it to the assistant.
 *
 * The frame is `BesideCard`'s business (size, caret, Escape/× close); this file
 * owns only the menu rows and the describe input.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import {
  IconGavel,
  IconRobot,
  IconTerminal2,
  IconUserCheck,
  type TablerIcon,
} from "@tabler/icons-react";
import { BesideCard, type BesideSide } from "./BesideCard";

export interface InsertStepMenuProps {
  /** "insert" → header "INSERT STEP"; "add" (after the last step) → "ADD STEP". */
  mode: "insert" | "add";
  /** Insert mode: the two steps the new one goes between, shown as a subtitle. */
  between?: { from: string; to: string };
  /** A step type was chosen. */
  onPick(kind: string): void;
  /** Enter in "Or describe it…" with non-empty text. Omit to hide the input. */
  onDescribe?(text: string): void;
  onClose(): void;
  /** Caret side from the beside-card placement (the caller passes "below"). */
  side?: BesideSide;
  /** Caret offset in px, see `placeBesideCard`. */
  caret?: number;
  /** Phone bottom sheet. */
  sheet?: boolean;
}

interface StepRow {
  kind: string;
  label: string;
  Icon: TablerIcon;
}

const STEP_ROWS: readonly StepRow[] = [
  { kind: "agent.acp", label: "Agent", Icon: IconRobot },
  { kind: "process.exec", label: "Command", Icon: IconTerminal2 },
  { kind: "human.approval", label: "Approval", Icon: IconUserCheck },
  { kind: "model.chat", label: "Judge", Icon: IconGavel },
];

export function InsertStepMenu({
  mode,
  between,
  onPick,
  onDescribe,
  onClose,
  side,
  caret,
  sheet,
}: InsertStepMenuProps) {
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState("");
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusRow = (index: number) => {
    setActive(index);
    rowRefs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow((active + 1) % STEP_ROWS.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow((active - 1 + STEP_ROWS.length) % STEP_ROWS.length);
      return;
    }
    if (event.key === "Enter") {
      // preventDefault stops the button's own activation so a pick fires once.
      event.preventDefault();
      onPick(STEP_ROWS[active].kind);
    }
  };

  const onDescribeKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onDescribe?.(text);
    setDraft("");
  };

  return (
    <BesideCard
      title={mode === "insert" ? "INSERT STEP" : "ADD STEP"}
      subtitle={between ? `between ${between.from} and ${between.to}` : undefined}
      onClose={onClose}
      side={side}
      caret={caret}
      sheet={sheet}
      width={260}
      testid="insert-step-menu"
    >
      <div
        role="menu"
        aria-label={mode === "insert" ? "Insert step" : "Add step"}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-[2px] outline-none"
      >
        {STEP_ROWS.map((row, index) => (
          <button
            key={row.kind}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            type="button"
            role="menuitem"
            data-testid={`insert-step-${row.kind}`}
            data-active={index === active ? "true" : "false"}
            autoFocus={index === 0}
            onClick={() => onPick(row.kind)}
            className={`flex h-[32px] max-md:min-h-[44px] items-center gap-[8px] rounded-[8px] px-[8px] text-left text-[13px] text-ink hover:bg-accent-wash ${
              index === active ? "bg-accent-wash" : "bg-transparent"
            }`}
          >
            <row.Icon size={16} stroke={1.5} aria-hidden />
            {row.label}
          </button>
        ))}
      </div>

      {onDescribe ? (
        <>
          <div aria-hidden className="h-px bg-line-soft" />
          <input
            type="text"
            data-testid="insert-step-describe"
            placeholder="Or describe it…"
            aria-label="Or describe it"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onDescribeKeyDown}
            className="w-full rounded-[8px] border border-line-strong bg-surface px-[10px] py-[7px] text-[13px] text-ink outline-none placeholder:text-muted"
          />
        </>
      ) : null}
    </BesideCard>
  );
}
