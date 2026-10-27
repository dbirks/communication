/**
 * SIDE-F — in-page section nav. Items are plain muted text; the item whose
 * section is current gets the ink box with the accent grid texture (the only
 * place texture marks "active"). Counts/flags trail in mono, in the state
 * color when they mean something.
 */

export interface SubNavItem {
  /** Same-document fragment id, e.g. "#repos". */
  href: string;
  label: string;
  /** Mono trailing flag (count or glyph); color classes via flagClass. */
  flag?: string;
  flagClass?: string;
}

export interface SubNavProps {
  items: SubNavItem[];
  /** Currently active href ("" = none). Tracked by the page. */
  active: string;
  onNavigate: (href: string) => void;
  label?: string;
  className?: string;
}

export function SubNav({
  items,
  active,
  onNavigate,
  label = "Sections",
  className = "",
}: SubNavProps) {
  return (
    <nav
      aria-label={label}
      className={`flex flex-col gap-[2px] text-[13px] text-muted ${className}`}
    >
      {items.map((item) => {
        const isActive = item.href === active;
        return (
          <a
            key={item.href}
            href={item.href}
            onClick={(event) => {
              // Keep the fragment in the URL (deep links) but move focus
              // without a jump-cut the animation floor would forbid.
              event.preventDefault();
              onNavigate(item.href);
              document.getElementById(item.href.slice(1))?.scrollIntoView({ block: "start" });
              document.getElementById(item.href.slice(1))?.focus?.({ preventScroll: true });
            }}
            aria-current={isActive ? "true" : undefined}
            className={`flex items-center rounded-[3px] px-2 max-[560px]:min-h-[44px] ${
              isActive
                ? "ds-texture-accent border border-ink bg-surface py-[5px] font-semibold text-ink"
                : "border border-transparent py-1.5 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            }`}
          >
            {item.label}
            {item.flag ? (
              <span
                className={`ml-auto font-mono text-[10.5px] font-semibold ${item.flagClass ?? "text-muted"}`}
              >
                {item.flag}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}
