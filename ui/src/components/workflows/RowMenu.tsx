/**
 * The `⋯` row menu on a Workflows index row (design 1b): `Use in a repo…`,
 * `Duplicate`, `Move to folder…` and `Export YAML`.
 *
 * Accessible-menu contract: the trigger carries `aria-haspopup="menu"` +
 * `aria-expanded`, the panel `role="menu"` with `menuitem` children, arrow
 * keys move between items, `Enter`/`Space` activate the focused item,
 * `Escape` closes and returns focus to the opener, click-away closes, and
 * the opener gets focus back whenever the menu closes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ds/Button";

const ITEM_IDS = ["use-in-repo", "duplicate", "move-to-folder", "export-yaml"] as const;
type MenuItemId = (typeof ITEM_IDS)[number];

export interface RowMenuProps {
  /** The row's slug — the menu items' stable hooks. */
  slug: string;
  /** The Duplicate item is inert while the row's three writes run. */
  duplicating: boolean;
  /** `Use in a repo…`; absent while the page has no use-in-a-repo dialog to open. */
  onUseInRepo?: () => void;
  /** Absent for readers without the library role (duplicate is a write). */
  onDuplicate?: () => void;
  /** `Move to folder…`; absent for readers without the library role. */
  onMoveToFolder?: () => void;
  /** Downloads the workflow's YAML through `toBlockYaml`; absent when the
   * page has no document to export (honest: the item is not offered). */
  onExportYaml?: () => void;
}

export function RowMenu({
  slug,
  duplicating,
  onUseInRepo,
  onDuplicate,
  onMoveToFolder,
  onExportYaml,
}: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const focusTrigger = () =>
    containerRef.current?.querySelector<HTMLButtonElement>("[data-menu-trigger]")?.focus();

  const focusItem = (position: number) => {
    containerRef.current
      ?.querySelectorAll<HTMLElement>("[role='menuitem']")
      .item(position)
      ?.focus();
  };

  /** The items this row offers, in order: a row only lists an action it can
   * actually run — readers lose `Duplicate` and `Move to folder…`, a row with
   * no use-in-a-repo dialog loses `Use in a repo…`, and a row without a
   * document to export loses `Export YAML`. */
  const items = ITEM_IDS.filter((item) => {
    if (item === "use-in-repo") return onUseInRepo !== undefined;
    if (item === "duplicate") return onDuplicate !== undefined;
    if (item === "move-to-folder") return onMoveToFolder !== undefined;
    return onExportYaml !== undefined;
  });

  const activate = (item: MenuItemId) => {
    if (item === "use-in-repo") onUseInRepo?.();
    else if (item === "duplicate") onDuplicate?.();
    else if (item === "move-to-folder") onMoveToFolder?.();
    else if (item === "export-yaml") onExportYaml?.();
    setOpen(false);
    focusTrigger();
  };

  const testidFor = (item: MenuItemId) => {
    if (item === "use-in-repo") return `workflow-menu-use-in-repo-${slug}`;
    if (item === "duplicate") return `workflow-duplicate-${slug}`;
    if (item === "move-to-folder") return `workflow-move-folder-${slug}`;
    return `workflow-menu-export-yaml-${slug}`;
  };

  const labelFor = (item: MenuItemId) => {
    if (item === "use-in-repo") return "Use in a repo…";
    if (item === "duplicate") return duplicating ? "Duplicating…" : "Duplicate";
    if (item === "move-to-folder") return "Move to folder…";
    return "Export YAML";
  };

  useLayoutEffect(() => {
    if (open) focusTrigger();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        focusTrigger();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = (index + delta + items.length) % items.length;
        setIndex(next);
        focusItem(next);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : items.length - 1;
        setIndex(next);
        focusItem(next);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          (active.hasAttribute("data-menu-trigger") || active.getAttribute("role") === "menuitem")
        ) {
          // The native button would fire its own click too: kill it, then
          // run exactly one activation.
          event.preventDefault();
          activate(items[index]);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const onAway = (event: globalThis.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const target = event.target instanceof Node ? event.target : null;
    if (!container.contains(target)) {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: globalThis.MouseEvent) => onAway(event);
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative" data-testid={`workflow-menu-root-${slug}`}>
      <Button
        variant="secondary"
        compact
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-trigger=""
        onClick={() => setOpen((current) => !current)}
        data-testid={`workflow-menu-${slug}`}
      >
        ⋯
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="row actions"
          data-testid={`workflow-menu-panel-${slug}`}
          className="absolute right-0 z-50 mt-1 w-[180px] rounded-[3px] border border-line bg-surface shadow-(--shadow-raised) py-[4px]"
        >
          {items.map((item, position) => (
            <Button
              key={item}
              type="button"
              role="menuitem"
              variant="ghost"
              disabled={item === "duplicate" && duplicating}
              className="w-full justify-start rounded-none px-[10px] py-[6px] font-ui text-[12.5px] text-ink"
              onClick={() => activate(item)}
              onMouseEnter={() => setIndex(position)}
              data-testid={testidFor(item)}
            >
              {labelFor(item)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
