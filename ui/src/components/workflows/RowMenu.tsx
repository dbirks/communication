/**
 * The `⋯` row menu on a Workflows index row (design 1b): `Use in a repo…`,
 * `Duplicate`, `Move to folder…` and `Export YAML`.
 *
 * The box, the pointer arrow, the placement and the whole accessible-menu
 * contract — `role="menu"` + `menuitem`s, arrow keys / Home / End, Escape
 * closing with focus returned to the opener, click-away closing — live in
 * the ds primitive (`components/ds/Menu`). This file owns which items the
 * row offers (a row never offers an action it cannot run) and the activation
 * wiring.
 */
import { useRef, useState } from "react";
import { Menu, MENU_ITEM_CLASS } from "../ds/Menu";
import { VARIANT_CLASS } from "../ds/Button";

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
  const triggerRef = useRef<HTMLButtonElement>(null);

  const activate = (item: MenuItemId) => {
    if (item === "use-in-repo") onUseInRepo?.();
    else if (item === "duplicate") onDuplicate?.();
    else if (item === "move-to-folder") onMoveToFolder?.();
    else if (item === "export-yaml") onExportYaml?.();
    setOpen(false);
    triggerRef.current?.focus();
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

  /** The items this row offers, in order: a row only lists an action it can
   * actually run — readers lose `Duplicate` and `Move to folder…`, a row with
   * no use-in-a-repo dialog loses `Use in a repo…`, and a row without a
   * document to export loses `Export YAML`. */
  const offered = ITEM_IDS.filter((item) => {
    if (item === "use-in-repo") return onUseInRepo !== undefined;
    if (item === "duplicate") return onDuplicate !== undefined;
    if (item === "move-to-folder") return onMoveToFolder !== undefined;
    return onExportYaml !== undefined;
  });

  return (
    <div className="relative" data-testid={`workflow-menu-root-${slug}`}>
      {/* A plain button (not the ds `Button`): the menu holds a ref to the
          trigger so Escape can return focus to it. Same BTN-I secondary
          compact box, same `icon-hit` phone band. */}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-trigger=""
        className={`ds-btn ${VARIANT_CLASS["secondary"]} ds-btn--compact icon-hit relative`}
        onClick={() => setOpen((current) => !current)}
        data-testid={`workflow-menu-${slug}`}
      >
        ⋯
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        data-testid={`workflow-menu-panel-${slug}`}
        ariaLabel="row actions"
        side="bottom"
        align="end"
        width={180}
      >
        {/* Items drawn here so the panel's e2e id stays a literal
            attribute — `scripts/check-testids.mjs` never follows a string
            through a prop. */}
        {offered.map((item) => (
          <button
            key={item}
            type="button"
            role="menuitem"
            disabled={item === "duplicate" && duplicating}
            onClick={() => activate(item)}
            data-testid={testidFor(item)}
            className={MENU_ITEM_CLASS}
          >
            {labelFor(item)}
          </button>
        ))}
      </Menu>
    </div>
  );
}
