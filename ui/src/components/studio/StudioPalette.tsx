/**
 * StudioPalette.tsx — the left-hand step palette of the Studio. Groups the
 * step library into "Steps", "Loops & branching" and a greyed "Not runnable
 * yet"; every item is searchable, draggable (dataTransfer type
 * `application/x-communication-kind`) and clickable — clicking adds the kind
 * after the selected node, or at the end of the root scope when nothing is
 * selected.
 */
import { STEP_LIBRARY, type ScopePath } from "../../lib/pipeline/graphDoc";
import { setPaletteDragKind } from "./StudioCanvas";
import { useMemo, useState, type DragEvent } from "react";

/** The palette → canvas drag contract. */
export const PALETTE_DRAG_TYPE = "application/x-communication-kind";

const LOOP_KINDS = new Set(["until", "for_each", "condition"]);

export interface StudioPaletteProps {
  /** The canvas selection — a click adds after this node. */
  selectedId: string | null;
  readOnly?: boolean;
  stale?: boolean;
  onAddAfter?(afterId: string | null, scope: ScopePath, kind: string): void;
}

interface Group {
  name: string;
  kinds: (typeof STEP_LIBRARY)[number][];
}

function groups(items: (typeof STEP_LIBRARY)[number][]): Group[] {
  return [
    {
      name: "Steps",
      kinds: items.filter((i) => i.runnable && !LOOP_KINDS.has(i.kind)),
    },
    {
      name: "Loops & branching",
      kinds: items.filter((i) => i.runnable && LOOP_KINDS.has(i.kind)),
    },
    {
      name: "Not runnable yet",
      kinds: items.filter((i) => !i.runnable),
    },
  ].filter((g) => g.kinds.length > 0);
}

export function StudioPalette({
  selectedId,
  readOnly = false,
  stale = false,
  onAddAfter,
}: StudioPaletteProps) {
  const [query, setQuery] = useState("");

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return STEP_LIBRARY;
    return STEP_LIBRARY.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [query]);

  const disabled = readOnly || stale;

  const onDragStart = (event: DragEvent, kind: string) => {
    event.dataTransfer.setData(PALETTE_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = "copy";
    setPaletteDragKind(kind);
  };

  const onDragEnd = () => setPaletteDragKind(null);

  return (
    <aside data-testid="studio-palette" className="flex h-full flex-col gap-3 p-3">
      <input
        type="search"
        value={query}
        placeholder="Search steps…"
        aria-label="Search steps"
        data-testid="palette-search"
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      />
      {groups(filteredItems).map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {group.name}
          </h3>
          <ul className="flex flex-col gap-1">
            {group.kinds.map((item) => {
              const interactive = !disabled;
              return (
                <li key={item.kind}>
                  <div
                    role="button"
                    tabIndex={interactive ? 0 : -1}
                    draggable={interactive}
                    aria-label={`${item.label} (${item.kind})${item.runnable ? "" : " — not runnable yet"}`}
                    data-testid={`palette-item-${item.kind}`}
                    className={[
                      "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-left",
                      item.runnable
                        ? "cursor-grab hover:border-accent"
                        : "cursor-not-allowed opacity-60",
                      interactive ? "outline-none focus:border-accent" : "",
                    ].join(" ")}
                    onDragStart={(e) => onDragStart(e, item.kind)}
                    onDragEnd={onDragEnd}
                    onClick={() => {
                      if (disabled) return;
                      onAddAfter?.(selectedId ?? null, [], item.kind);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !disabled)
                        onAddAfter?.(selectedId ?? null, [], item.kind);
                    }}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-[12px] font-medium text-ink">
                        {item.label}
                      </span>
                      {!item.runnable && (
                        <span className="shrink-0 text-[9px] text-faint">not runnable yet</span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-faint">{item.kind}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {filteredItems.length === 0 && (
        <p className="text-[12px] text-muted" data-testid="palette-empty">
          No steps match “{query}”
        </p>
      )}
    </aside>
  );
}
