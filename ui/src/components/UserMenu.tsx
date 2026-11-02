/**
 * The sidebar footer's user menu: the signed-in user's avatar + name is the
 * trigger (`user-badge`), and the menu carries the account affordances —
 * Settings, Operations, Sign out. The box, arrow, placement (opens upward,
 * right-aligned) and menu keyboard live in the ds primitive
 * (`components/ds/Menu`): Escape closes and returns focus to the trigger,
 * arrow keys move between items, click-outside closes, ArrowDown opens.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { problemOf } from "../api/client";
import { useLogout, useMe } from "../api/queries";
import { Menu, MENU_ITEM_CLASS } from "./ds/Menu";
import { routes } from "../lib/routes";

const MENU_LIST_ID = "user-menu-list";
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function InitialsTile({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center rounded-[3px] border border-ink bg-surface font-mono text-ink ${className}`}
    >
      {initialsOf(name) || "?"}
    </span>
  );
}

export default function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const displayName = me.data?.display_name ?? "";

  const close = () => setOpen(false);

  const onSignOut = () => {
    close();
    logout.mutate(undefined, {
      onSuccess: () => navigate("/login"),
      onError: () => navigate("/login"),
    });
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    // ArrowDown opens (the primitive then parks focus on the first item);
    // Enter/Space activate the native button click, which toggles open.
    if (open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const error = logout.error ? problemOf(logout.error).detail || "Sign out failed." : null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="user-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_LIST_ID : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
        className={`flex w-full items-center gap-2 rounded-[3px] px-2 py-[3px] text-left hover:bg-fill ${FOCUS_RING}`}
      >
        <InitialsTile name={displayName} className="h-[26px] w-[26px] text-[10px]" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
          <strong data-testid="user-badge" className="font-semibold text-ink">
            {displayName}
          </strong>
        </span>
      </button>
      <Menu
        open={open}
        onClose={close}
        triggerRef={triggerRef}
        panelId={MENU_LIST_ID}
        data-testid="user-menu-list"
        ariaLabel="Account"
        side="top"
        align="end"
        width={180}
      >
        {/* Items drawn here so the e2e ids stay literal attributes —
            `scripts/check-testids.mjs` never follows a string through a
            prop. */}
        <button
          type="button"
          role="menuitem"
          data-testid="user-menu-settings"
          onClick={() => {
            close();
            navigate(routes.settings());
          }}
          className={MENU_ITEM_CLASS}
        >
          Settings
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="user-menu-ops"
          onClick={() => {
            close();
            navigate(routes.ops());
          }}
          className={MENU_ITEM_CLASS}
        >
          Operations
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="sign-out"
          onClick={onSignOut}
          className={MENU_ITEM_CLASS}
        >
          Sign out
        </button>
      </Menu>
      {error ? (
        <span role="alert" className="mt-1 font-mono text-[11px] text-st-failed-tag-fg">
          × {error}
        </span>
      ) : null}
    </div>
  );
}
