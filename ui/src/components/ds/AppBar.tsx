import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { Mark } from "./Mark";

/**
 * NAV-I — 52px app bar: white, one ink hairline below. C mark on the left,
 * a section track in the middle (active = flat white tab on the fill track),
 * the Ask box next, you on the right. The project dropdown stays a slot for
 * when that feature exists (avatars are still open per the handoff).
 */

export interface AppBarNavItem {
  to: string;
  label: string;
  end?: boolean;
}

export interface AppBarProps {
  items: AppBarNavItem[];
  left?: ReactNode;
  /** The Ask box / command palette trigger, between the nav and the user area. */
  ask?: ReactNode;
  right?: ReactNode;
}

export function AppBar({ items, left, ask, right }: AppBarProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-ink bg-surface">
      <div className="mx-auto flex h-[52px] w-full max-w-5xl items-center gap-[14px] px-4">
        <Mark size={28} />
        {left}
        <nav
          aria-label="Primary"
          className="flex items-center gap-[2px] rounded-[4px] bg-fill p-[3px] text-[12.5px] text-muted"
        >
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className="rounded-[3px] border border-transparent px-[10px] py-1 font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-[current=page]:border-fill-edge aria-[current=page]:bg-surface aria-[current=page]:font-semibold aria-[current=page]:text-ink"
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        {ask ? <div className="ml-auto flex min-w-0 justify-end">{ask}</div> : null}
        <div
          className={ask ? "flex shrink-0 items-center gap-3" : "ml-auto flex items-center gap-3"}
        >
          {right}
        </div>
      </div>
    </header>
  );
}

/** The 28px ink-box identity slot from NAV-I. Avatars are still open in the
 * handoff, so this stays initials-only (mono, never a photo). */
export function InitialsBox({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden="true"
      className="grid h-[28px] w-[28px] shrink-0 place-items-center rounded-[3px] border border-ink bg-surface font-mono text-[10.5px] font-medium text-ink"
    >
      {initials || "?"}
    </span>
  );
}
