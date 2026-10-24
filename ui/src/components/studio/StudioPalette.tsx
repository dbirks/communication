/**
 * StudioPalette — the left-hand step palette of the Studio (design 1g).
 *
 * Mono group labels (`ADD A STEP`, `WRAP STEPS`), the DS search field, 32px
 * rows (kind glyph + label), not-runnable kinds behind a collapsed disclosure,
 * and the click-vs-drag tip. Clicking adds the kind after the selected step;
 * dragging adds it onto a canvas line. No Tailwind defaults: every heading is
 * mono and the rows use the ds radius.
 */
import { offeredSteps, type ScopePath } from "../../lib/pipeline/graphDoc";
import { kindGlyph } from "../../lib/pipeline/definition";
import { setPaletteDragKind } from "./StudioCanvas";
import { useMemo, useState, type DragEvent } from "react";

/** The palette → canvas drag contract. */
export const PALETTE_DRAG_TYPE = "application/x-communication-kind";

const LOOP_KINDS = new Set(["until", "for_each", "condition"]);

export interface StudioPaletteProps {
  /** The canvas selection — a click adds after this node. */
  selectedId: string | null;
  /** The selected step's kind, when the selection names one — row highlight. */
  selectedKind?: string | null;
  readOnly?: boolean;
  stale?: boolean;
  onAddAfter?(afterId: string | null, scope: ScopePath, kind: string): void;
}

type PaletteEntry = ReturnType<typeof offeredSteps>[number];

const PALETTE_ITEMS = offeredSteps();

function groups(items: PaletteEntry[]): { name: string; kinds: PaletteEntry[] }[] {
  const add = items.filter((i) => i.runnable && !LOOP_KINDS.has(i.kind));
  const wrap = items.filter((i) => i.runnable && LOOP_KINDS.has(i.kind));
  const out: { name: string; kinds: PaletteEntry[] }[] = [];
  if (add.length > 0) out.push({ name: "ADD A STEP", kinds: add });
  if (wrap.length > 0) out.push({ name: "WRAP STEPS", kinds: wrap });
  return out;
}

export function StudioPalette({
  selectedId,
  selectedKind = null,
  readOnly = false,
  stale = false,
  onAddAfter,
}: StudioPaletteProps) {
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTE_ITEMS;
    return PALETTE_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [query]);

  const disabled = readOnly || stale;
  const notRunnable = filteredItems.filter((item) => !item.runnable);

  const onDragStart = (event: DragEvent, kind: string) => {
    event.dataTransfer.setData(PALETTE_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = "copy";
    setPaletteDragKind(kind);
  };

  const onDragEnd = () => setPaletteDragKind(null);

  const add = (item: PaletteEntry) => {
    if (disabled) return;
    onAddAfter?.(selectedId ?? null, [], item.kind);
  };

  const row = (item: PaletteEntry, kind: string, selectable: boolean) => (
    <div
      key={kind}
      role="button"
      tabIndex={selectable ? 0 : -1}
      draggable={selectable}
      aria-disabled={!item.runnable || undefined}
      aria-label={`${item.label} (${item.kind})${item.runnable ? "" : " — not runnable yet"}`}
      data-testid={`palette-item-${item.kind}`}
      className={[
        "flex h-[32px] items-center gap-[8px] rounded-[3px] border px-2 text-left",
        item.runnable
          ? "cursor-grab hover:border-ink hover:bg-accent-wash"
          : "cursor-not-allowed opacity-60",
        selectable ? "outline-none focus:border-ink" : "",
        item.runnable && selectedKind === kind ? "border-ink bg-accent-wash" : "",
      ].join(" ")}
      onDragStart={(e) => onDragStart(e, item.kind)}
      onDragEnd={onDragEnd}
      onClick={() => selectable && add(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && selectable) add(item);
      }}
    >
      <span aria-hidden="true" className="font-mono text-[12px] text-ink-2">
        {kindGlyph(item.kind)}
      </span>
      <span className="truncate text-[13px] text-ink">{item.label}</span>
    </div>
  );

  return (
    <aside data-testid="studio-palette" className="flex h-full flex-col gap-3 p-3">
      <h3
        className="font-mono text-[10px] font-semibold tracking-[0.06em] text-faint"
        data-testid="palette-heading-add"
      >
        ADD A STEP
      </h3>
      <input
        type="search"
        value={query}
        placeholder="Search steps…"
        aria-label="Search steps"
        data-testid="palette-search"
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink placeholder:text-faint focus-visible:border-ink focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--color-accent-ring)]"
      />
      {groups(filteredItems).map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h4
            className="mb-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-faint"
            data-testid={`palette-heading-group-${group.name.replace(/\s+/g, "-").toLowerCase()}`}
          >
            {group.name}
          </h4>
          <div className="flex flex-col gap-1">{group.kinds.map((item) => row(item, item.kind, !disabled))}</div>
        </section>
      ))}
      {notRunnable.length > 0 ? (
        <section aria-label="Not runnable yet">
          <button
            type="button"
            data-testid="palette-more-toggle"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className="font-mono text-[11px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
          >
            {moreOpen ? "Hide" : `${notRunnable.length} more, not runnable yet`}
          </button>
          {moreOpen ? (
            <div className="mt-1 flex flex-col gap-1">{notRunnable.map((item) => row(item, item.kind, false))}</div>
          ) : null}
        </section>
      ) : null}
      {filteredItems.length === 0 && notRunnable.length === 0 ? (
        <p className="text-[12px] text-muted" data-testid="palette-empty">
          No steps match “{query}”
        </p>
      ) : null}
      <div className="mt-auto border-t border-line-soft px-3 py-2 font-mono text-[11px] text-muted">
        Click to add after the selected step, or drag onto a line.
      </div>
    </aside>
  );
}
