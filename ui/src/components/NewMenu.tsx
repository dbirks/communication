/**
 * The shell's "New" menu: one entry point for starting something — a
 * one-off conversation (shared dialog with a project picker), a new
 * workflow (the library's new-pipeline form) or a run (started from a
 * project's runs page). The box, the pointer arrow, the placement and the
 * menu keyboard all live in the ds primitive (`components/ds/Menu`); this
 * file owns the trigger, the items and the one-menu-at-a-time choreography
 * (issue #62).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import NewConversationDialog from "./NewConversationDialog";
import { Menu, MENU_ITEM_CLASS } from "./ds/Menu";
import { VARIANT_CLASS } from "./ds/Button";
import { routes } from "../lib/routes";

const MENU_ITEMS = [
  { id: "conversation", label: "New conversation" },
  { id: "workflow", label: "New workflow" },
  { id: "run", label: "Start run" },
] as const;

/** AssistantPopover dispatches the first when it opens over a chord (the
 * Ask buttons' synthetic ⌘K); CommandPalette dispatches the second. One
 * menu open at a time (issue #62). */
const CLOSE_OTHER_MENUS_EVENT = "communication:close-other-menus";
const PALETTE_OPEN_EVENT = "communication:palette-open";

type MenuItemId = (typeof MENU_ITEMS)[number]["id"];

export default function NewMenu() {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);

  // One menu open at a time: when the assistant popover or the jump palette
  // opens, New gets out of the way immediately (#62).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener(CLOSE_OTHER_MENUS_EVENT, close);
    window.addEventListener(PALETTE_OPEN_EVENT, close);
    return () => {
      window.removeEventListener(CLOSE_OTHER_MENUS_EVENT, close);
      window.removeEventListener(PALETTE_OPEN_EVENT, close);
    };
  }, [open]);

  const activate = (id: MenuItemId) => {
    setOpen(false);
    if (id === "conversation") setDialogOpen(true);
    else if (id === "workflow") navigate(routes.workflows());
    else navigate(routes.projects()); // the projects list; a run is started from a project
  };

  return (
    <>
      <div className="relative">
        {/* A plain button (not the ds `Button`): the menu needs to hold a ref to the
            trigger so Escape can return focus to it. Compact (26px) so the chip
            fits the bar's one-line rhythm. */}
        <button
          ref={triggerRef}
          type="button"
          className={`ds-btn ds-btn--compact ${VARIANT_CLASS["secondary"]}`}
          data-testid="new-menu"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? "new-menu-list" : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          New
        </button>
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          panelId="new-menu-list"
          data-testid="new-menu-list"
          ariaLabel="New"
          width={180}
        >
          {/* The items are drawn here (not passed as data) so the e2e ids
              stay literal attributes — `scripts/check-testids.mjs` guards
              them, and it never follows a string through a prop. */}
          {MENU_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-testid={`new-menu-${item.id}`}
              onClick={() => activate(item.id)}
              className={MENU_ITEM_CLASS}
            >
              {item.label}
            </button>
          ))}
        </Menu>
      </div>
      <NewConversationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
