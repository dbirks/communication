/**
 * StepPicker.tsx — the searchable step popover opened by every "+" on the
 * canvas (edge midpoint, trailing terminal step, empty scope body, empty
 * canvas). Keyboard contract: the search input autofocuses; ArrowUp/Down
 * move the active entry, Enter picks it, Escape closes. Non-runnable kinds
 * stay pickable — they are labelled "not runnable yet", never hidden.
 */
import { STEP_LIBRARY } from "../../lib/pipeline/graphDoc";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface StepLibraryEntry {
  kind: string;
  label: string;
  description: string;
  runnable: boolean;
}

export interface StepPickerProps {
  /** Defaults to the whole step library. */
  items?: StepLibraryEntry[];
  /** The context line ("Insert a step between A and B", …). */
  title?: string;
  onPick(kind: string): void;
  onClose(): void;
}

export function StepPicker({ items = STEP_LIBRARY, title, onPick, onClose }: StepPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    setActive((current) => (current + delta + filtered.length) % filtered.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = filtered[active];
      if (pick) onPick(pick.kind);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label={title ?? "Pick a step"}
      data-testid="step-picker"
      className="w-64 rounded-lg border border-line-strong bg-surface p-2 shadow-[0_4px_16px_rgba(30,29,26,0.12)]"
    >
      {title && <div className="mb-1.5 truncate text-[11px] font-semibold text-ink-2">{title}</div>}
      <input
        ref={inputRef}
        type="search"
        value={query}
        data-testid="step-picker-search"
        placeholder="Search steps…"
        aria-label="Search steps"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        className="mb-1.5 w-full rounded-md border border-line bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
      />
      <ul
        role="listbox"
        aria-label={title ?? "Steps"}
        data-testid="step-picker-list"
        className="max-h-56 overflow-y-auto"
      >
        {filtered.map((item, index) => (
          <li
            key={item.kind}
            role="option"
            aria-selected={index === active}
            data-testid={`step-picker-item-${item.kind}`}
            className={
              index === active
                ? "cursor-pointer rounded-md border border-accent bg-accent-wash px-2 py-1"
                : "cursor-pointer rounded-md border border-transparent px-2 py-1 hover:bg-fill"
            }
            onMouseEnter={() => setActive(index)}
            onClick={() => onPick(item.kind)}
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12px] text-ink">{item.label}</span>
              {!item.runnable && (
                <span className="shrink-0 rounded-full border border-line bg-fill px-1.5 py-0.5 text-[9px] leading-4 text-muted">
                  not runnable yet
                </span>
              )}
            </div>
            <div className="font-mono text-[10px] text-faint">{item.kind}</div>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-muted" data-testid="step-picker-empty">
            No steps match “{query}”
          </li>
        )}
      </ul>
    </div>
  );
}
