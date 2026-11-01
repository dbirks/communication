/**
 * The shell's "New" menu: one entry point for starting something — a
 * one-off conversation (shared dialog with a project picker), a new
 * workflow (the library's new-pipeline form) or a run (started from a
 * project's runs page). Menu semantics: `role="menu"`, arrow keys move
 * between items, Escape closes and returns focus to the trigger.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import NewConversationDialog from "./NewConversationDialog";
import { VARIANT_CLASS } from "./ds/Button";
import { routes } from "../lib/routes";

const MENU_ITEMS = [
  { id: "conversation", label: "New conversation" },
  { id: "workflow", label: "New workflow" },
  { id: "run", label: "Start run" },
] as const;

/** Keep in sync with the menu's `w-[180px]` class: the clamp math runs
 * before layout in jsdom (and every paint elsewhere), where measuring the
 * open menu's box is unreliable. */
const MENU_WIDTH_PX = 180;

/** Smallest gap the clamped menu keeps from either viewport edge. */
const VIEWPORT_MARGIN_PX = 8;

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
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Anchor to the trigger's LEFT edge (the old `right-0` started the menu
  // ~36px left of the button's own left edge — off-viewport in the phone
  // drawer, measured live at issue #62). Shift back left only far enough to
  // keep the right edge (and, at the other extreme, the left edge) inside
  // the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    menu.style.left = "0px";
    const triggerRect = trigger.getBoundingClientRect();
    const rightOverflow =
      triggerRect.left + MENU_WIDTH_PX - (window.innerWidth - VIEWPORT_MARGIN_PX);
    if (rightOverflow > 0) {
      const maxShift = Math.max(0, triggerRect.left - VIEWPORT_MARGIN_PX);
      const shift = Math.min(rightOverflow, maxShift);
      if (shift > 0) menu.style.left = `${-shift}px`;
    }
  }, [open]);

  // Clicking anywhere outside — the Ask box, another menu's trigger, the
  // page — closes the menu, like every other menu in the app (#62).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const menu = menuRef.current;
      if (!menu) return;
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        items[(activeIndex + 1) % items.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[(activeIndex - 1 + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
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
        {open ? (
          <div
            ref={menuRef}
            id="new-menu-list"
            role="menu"
            aria-label="New"
            data-testid="new-menu-list"
            className="absolute left-0 top-full z-40 mt-1 w-[180px] rounded-[3px] border border-line-strong bg-surface py-1 shadow-[0_8px_24px_rgba(30,29,26,0.18)]"
          >
            {MENU_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-testid={`new-menu-${item.id}`}
                onClick={() => activate(item.id)}
                className="block w-full px-3 py-[6px] text-left text-[12.5px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none"
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <NewConversationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
