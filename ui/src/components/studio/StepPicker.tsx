/**
 * StepPicker.tsx — the searchable step popover opened by every "+" on the
 * canvas (edge midpoint, trailing terminal step, empty scope body, empty
 * canvas). Layout (redesign "Add a step (4a)", artboard 4a):
 *
 *   · one input that both searches and describes ("Search steps, or describe one…")
 *   · "START A NEW STEP" — five primary kind cards (Agent, Command, Approval,
 *     Loop, Workflow);
 *   · "MORE" — the remaining offered kinds (non-runnable ones stay pickable
 *     and are labelled "not runnable yet", never hidden);
 *   · "YOUR SAVED STEPS" — honestly empty until the step registry lands;
 *   · a footer hint that the assistant can draft a step from a description.
 *
 * Publish kinds are never offered here (ADR-0045 — they stay in the YAML
 * catalogue). Keyboard contract: the search input autofocuses; ArrowUp/Down
 * move the active entry, Enter picks it — or, when the text matches no
 * offered kind and the page supplies `onDescribe`, hands the description to
 * the assistant draft-proposal flow (AssistantProposalBox / useDraftProposal)
 * — and Escape closes.
 */
import { offeredSteps } from "../../lib/pipeline/graphDoc";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface StepLibraryEntry {
  kind: string;
  label: string;
  description: string;
  runnable: boolean;
}

/** A "START A NEW STEP" card: the five primary kinds and their 4a copy. */
interface FeaturedCard {
  kind: string;
  title: string;
  blurb: string;
}

const FEATURED_CARDS: FeaturedCard[] = [
  { kind: "agent.acp", title: "Agent", blurb: "an ACP agent with a profile" },
  { kind: "process.exec", title: "Command", blurb: "run a program, check exit code" },
  { kind: "human.approval", title: "Approval", blurb: "a person decides" },
  { kind: "until", title: "Loop", blurb: "repeat until a check passes" },
  { kind: "pipeline.invoke", title: "Workflow", blurb: "run another workflow inside" },
];

/** The picker's default list — every offered kind (ADR-0045 kinds excluded). */
const DEFAULT_ITEMS = offeredSteps();

/** One selectable option: a featured card or a plain "MORE" entry. */
interface Option {
  kind: string;
  entry: StepLibraryEntry;
  card: FeaturedCard | null;
}

export interface StepPickerProps {
  /** Defaults to every offered kind (the catalogue minus ADR-0045 kinds). */
  items?: StepLibraryEntry[];
  /** The context line ("Insert a step between A and B", …). */
  title?: string;
  onPick(kind: string): void;
  onClose(): void;
  /**
   * Receives a free-text description when the input matches no offered kind
   * and Enter is pressed. The Studio page should forward it to the existing
   * assistant draft-proposal flow; until that plumbing lands the picker
   * renders the footer hint as plain text and Enter with no match is a no-op.
   */
  onDescribe?(description: string): void;
}

export function StepPicker({
  items = DEFAULT_ITEMS,
  title,
  onPick,
  onClose,
  onDescribe,
}: StepPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const catalog = items;

  const { featured, more } = useMemo(() => {
    const featured = FEATURED_CARDS.filter((card) =>
      catalog.some((entry) => entry.kind === card.kind),
    );
    const more = catalog.filter(
      (entry) => !FEATURED_CARDS.some((card) => card.kind === entry.kind),
    );
    return { featured, more };
  }, [catalog]);

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (entry: StepLibraryEntry, card: FeaturedCard | null): boolean => {
      if (!q) return true;
      return (
        entry.label.toLowerCase().includes(q) ||
        entry.kind.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        (card !== null &&
          (card.title.toLowerCase().includes(q) || card.blurb.toLowerCase().includes(q)))
      );
    };
    const list: Option[] = [];
    for (const card of featured) {
      const entry = catalog.find((e) => e.kind === card.kind)!;
      if (matches(entry, card)) list.push({ kind: entry.kind, entry, card });
    }
    for (const entry of more) {
      if (matches(entry, null)) list.push({ kind: entry.kind, entry, card: null });
    }
    return list;
  }, [catalog, featured, more, query]);

  const featuredVisible = options.some((o) => o.card !== null);
  const moreVisible = options.some((o) => o.card === null);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const move = (delta: number) => {
    if (options.length === 0) return;
    setActive((current) => (current + delta + options.length) % options.length);
  };

  const describe = () => {
    const text = query.trim();
    if (!text || options.length > 0) return false;
    onDescribe?.(text);
    onClose();
    return true;
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
      if (describe()) return;
      const pick = options[active];
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
      className="w-[360px] rounded-lg border border-line-strong bg-surface p-2 shadow-[0_4px_16px_rgba(30,29,26,0.12)]"
    >
      {title && <div className="mb-1.5 truncate text-[11px] font-semibold text-ink-2">{title}</div>}
      <input
        ref={inputRef}
        type="search"
        value={query}
        data-testid="step-picker-search"
        placeholder="Search steps, or describe one…"
        aria-label="Search steps, or describe one"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        className="mb-1.5 w-full rounded-md border border-line bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
      />
      {/* tabindex=0 keeps the scrollable region keyboard reachable (AXE
          scrollable-region-focusable); the search input still owns the
          picker's keyboard contract. */}
      <div
        data-testid="step-picker-list"
        tabIndex={0}
        className="max-h-72 overflow-y-auto outline-none"
      >
        {featuredVisible && (
          <section aria-label="Start a new step" data-testid="step-picker-featured">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Start a new step
            </h3>
            <ul className="flex flex-col gap-1" role="listbox" aria-label="Start a new step">
              {options
                .filter((o) => o.card !== null)
                .map((option) => (
                  <PickerRow
                    key={option.kind}
                    option={option}
                    active={options[active] === option}
                    onHover={() => setActive(options.indexOf(option))}
                    onPick={() => onPick(option.kind)}
                  />
                ))}
            </ul>
          </section>
        )}
        {moreVisible && (
          <section aria-label="More steps" data-testid="step-picker-more">
            <h3 className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              More
            </h3>
            <ul className="flex flex-col gap-1" role="listbox" aria-label="More steps">
              {options
                .filter((o) => o.card === null)
                .map((option) => (
                  <PickerRow
                    key={option.kind}
                    option={option}
                    active={options[active] === option}
                    onHover={() => setActive(options.indexOf(option))}
                    onPick={() => onPick(option.kind)}
                  />
                ))}
            </ul>
          </section>
        )}
        {options.length === 0 && (
          <p className="px-2 py-1 text-[12px] text-muted" data-testid="step-picker-empty">
            No steps match “{query}”
          </p>
        )}
      </div>
      <section
        aria-label="Your saved steps"
        data-testid="step-picker-saved"
        className="mt-2 border-t border-line pt-2"
      >
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Your saved steps
        </h3>
        <p className="text-[11px] text-faint" data-testid="step-picker-saved-count">
          0 saved steps
        </p>
        <p className="text-[11px] text-muted">Saved steps arrive with the step registry.</p>
      </section>
      <p
        className="mt-2 border-t border-line pt-2 text-[11px] text-faint"
        data-testid="step-picker-assistant-hint"
      >
        or describe it and the assistant drafts it
      </p>
    </div>
  );
}

/** One option row: a card (featured) or a plain kind entry. */
function PickerRow({
  option,
  active,
  onHover,
  onPick,
}: {
  option: Option;
  active: boolean;
  onHover(): void;
  onPick(): void;
}) {
  const { entry, card } = option;
  return (
    <li
      role="option"
      aria-selected={active}
      data-testid={`step-picker-item-${entry.kind}`}
      className={
        active
          ? "cursor-pointer rounded-md border border-accent bg-accent-wash px-2 py-1"
          : "cursor-pointer rounded-md border border-transparent px-2 py-1 hover:bg-fill"
      }
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[12px] font-medium text-ink">
          {card?.title ?? entry.label}
        </span>
        {!entry.runnable && (
          <span className="shrink-0 rounded-full border border-line bg-fill px-1.5 py-0.5 text-[9px] leading-4 text-muted">
            not runnable yet
          </span>
        )}
      </div>
      <div className="truncate text-[11px] text-muted">{card?.blurb ?? entry.description}</div>
      <div className="font-mono text-[10px] text-faint">{entry.kind}</div>
    </li>
  );
}
