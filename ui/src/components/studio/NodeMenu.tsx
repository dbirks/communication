/**
 * NodeMenu.tsx — the selected-node context/selection menu for the Studio
 * canvas (design 1g): a small menu to the right of the single selected step
 * (ink border, hard shadow `2px 2px 0`), with `Duplicate` and `Delete ⌫`
 * (danger tint). The same two actions serve the context menu at the pointer;
 * arrow keys + enter work, esc / click-away close, focus returns.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface NodeMenuProps {
  x: number;
  y: number;
  /**
   * The pane has no clear spot beside or below the node at the menu's normal
   * size (the 390px canvas is a dense top-to-bottom chain), so the two actions
   * draw as ONE compact row anchored directly under their own step. It is still
   * the step's menu — the pass-7 review's defect was exactly that the docked
   * strip read as a bar of the canvas. It keeps its x/y; only its shape
   * changes.
   */
  compact?: boolean;
  /**
   * The pane is too short to hold even the one-row menu: the menu then draws
   * itself as a strip of its own UNDER the canvas viewport, in flow rather than
   * over the graph. It ignores x/y; it flows.
   */
  docked?: boolean;
  nodeId: string;
  /** Duplicate the step; hidden (not rendered) when the page has none. */
  onDuplicate?: (id: string) => void;
  onDelete: (ids: string[]) => void;
  onClose: () => void;
}

const MENU_ITEMS = [
  { id: "duplicate", label: "Duplicate" },
  { id: "delete", label: "Delete" },
] as const;

export function NodeMenu({
  x,
  y,
  compact = false,
  docked = false,
  nodeId,
  onDuplicate,
  onDelete,
  onClose,
}: NodeMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([null, null]);
  const [active, setActive] = useState(0);

  // The Duplicate action is only offered when the page can run it; a canvas
  // without a duplicate op hides the item rather than rendering a dead button.
  const items = onDuplicate ? MENU_ITEMS : MENU_ITEMS.filter((item) => item.id !== "duplicate");

  const activate = (index: number) => {
    const item = items[index];
    if (item.id === "duplicate") {
      onDuplicate?.(nodeId);
    } else {
      onDelete([nodeId]);
    }
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (a + 1) % items.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(active);
    }
  };

  useEffect(() => {
    itemRefs.current[active]?.focus();
  }, [active]);

  const onItemClick = (index: number) => () => activate(index);

  return (
    <div
      ref={listRef}
      data-testid="studio-node-menu"
      data-docked={docked ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={
        docked
          ? /* The docked strip is a FLOW row of the canvas column, not a thing
               pinned over the pane: here it takes its own height under the
               viewport, exactly like the canvas' caption band, and the two
               actions share one line. */
            "flex shrink-0 flex-nowrap items-center gap-[6px] border-t border-line bg-surface p-[3px] outline-none"
          : /* One row (`compact`) or the 1g two-row menu; the same ink border +
             hard shadow either way, so the menu still reads as the step's. */
            `absolute z-20 flex flex-nowrap gap-[6px] rounded border border-ink bg-surface p-[3px] shadow-[2px_2px_0_var(--color-ink)] outline-none ${
              compact ? "flex-row" : "flex-col gap-[2px]"
            }`
      }
      style={docked ? undefined : { left: x, top: y }}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          data-testid={
            item.id === "duplicate" ? "studio-node-menu-duplicate" : "studio-node-menu-delete"
          }
          onClick={onItemClick(index)}
          className={
            item.id === "delete"
              ? `whitespace-nowrap rounded-[3px] bg-st-failed-pale-body px-[8px] py-[3px] text-left text-[12.5px] text-st-failed-strong hover:bg-st-failed-pale-bar ${
                  docked || compact ? "min-h-[44px] shrink-0" : ""
                }`
              : `whitespace-nowrap rounded-[3px] bg-surface px-[8px] py-[3px] text-left text-[12.5px] text-ink hover:bg-fill ${
                  docked || compact ? "min-h-[44px] shrink-0" : ""
                }`
          }
        >
          {item.id === "delete" ? (
            <>
              Delete{" "}
              <span className="font-mono text-[10px]" aria-hidden="true">
                ⌫
              </span>
            </>
          ) : (
            item.label
          )}
        </button>
      ))}
    </div>
  );
}
