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

const MENU_ITEMS = [
  { id: "conversation", label: "New conversation" },
  { id: "workflow", label: "New workflow" },
  { id: "run", label: "Start run" },
] as const;

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
    else if (id === "workflow") navigate("/library");
    else navigate("/"); // the projects list lives at "/"; a run is started from a project
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
            className="absolute right-0 top-full z-40 mt-1 w-[180px] rounded-[3px] border border-line-strong bg-surface py-1 shadow-[0_8px_24px_rgba(30,29,26,0.18)]"
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
