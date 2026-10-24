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

export function NodeMenu({ x, y, nodeId, onDuplicate, onDelete, onClose }: NodeMenuProps) {
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
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute z-20 flex flex-col gap-[2px] rounded border border-ink bg-surface p-3 shadow-[2px_2px_0_var(--color-ink)] outline-none"
      style={{ left: x, top: y }}
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
              ? "rounded px-2 py-1.5 text-left text-[12px] font-semibold text-st-failed-strong bg-st-failed-pale-body hover:bg-st-failed-pale-bar"
              : "rounded px-2 py-1.5 text-left text-[12px] font-semibold text-ink bg-surface hover:bg-fill"
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
