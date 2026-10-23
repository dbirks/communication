/**
 * The sidebar footer's user menu: the signed-in user's avatar + name is the
 * trigger (`user-badge`), and the menu carries the account affordances —
 * Settings, Operations, Sign out. Menu semantics: `role="menu"`,
 * `aria-haspopup="menu"`, arrow keys move between items, Escape closes and
 * returns focus to the trigger, click-outside closes, Enter/Space/ArrowDown
 * open. The keyboard choreography mirrors the New menu (`components/NewMenu`).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";
import { problemOf } from "../api/client";
import { useLogout, useMe } from "../api/queries";
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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

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
    // ArrowDown opens (the layout effect then parks focus on the first item);
    // Enter/Space activate the native button click, which toggles open.
    if (open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const error = logout.error ? problemOf(logout.error).detail || "Sign out failed." : null;

  const itemClass =
    "block w-full px-3 py-[6px] text-left text-[12.5px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none";

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
      {open ? (
        <div
          ref={menuRef}
          id={MENU_LIST_ID}
          role="menu"
          aria-label="Account"
          data-testid="user-menu-list"
          className="absolute bottom-full right-0 z-40 mb-1 w-[180px] rounded-[3px] border border-line-strong bg-surface py-1 shadow-raised"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="user-menu-settings"
            onClick={() => {
              close();
              navigate(routes.settings());
            }}
            className={itemClass}
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
            className={itemClass}
          >
            Operations
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="sign-out"
            onClick={onSignOut}
            className={itemClass}
          >
            Sign out
          </button>
        </div>
      ) : null}
      {error ? (
        <span role="alert" className="mt-1 font-mono text-[11px] text-st-failed-tag-fg">
          × {error}
        </span>
      ) : null}
    </div>
  );
}
