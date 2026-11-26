/**
 * SectionPill — the three daily places, centered in the top bar (redesign R1,
 * README §1 "Center: the section pill").
 *
 * It is one control, not a nav list: Home, Chats and Factory are the whole
 * daily loop, and the pill's active item is the section the URL is in
 * (`sectionFromPath`), so it never disagrees with the page. Its links carry
 * the current scope: in a project, Chats is that project's chats; on All, the
 * unscoped list.
 *
 * Manage is deliberately not here — it lives in the rail — and neither is any
 * other page: a surface that is not a place you work from is not a pill item.
 */
import { Link, useLocation } from "react-router";
import { IconBuildingFactory2, IconMessage, IconSunrise } from "@tabler/icons-react";
import { routes, type Section } from "../../lib/routes";
import { sectionFromPath, useScope } from "../../lib/scope";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

interface PillItem {
  key: Section;
  testid: string;
  label: string;
  Icon: typeof IconSunrise;
  to: (scope: string | null) => string;
}

const ITEMS: PillItem[] = [
  { key: "home", testid: "pill-home", label: "Home", Icon: IconSunrise, to: routes.scopeHome },
  { key: "chats", testid: "pill-chats", label: "Chats", Icon: IconMessage, to: routes.chats },
  {
    key: "factory",
    testid: "pill-factory",
    label: "Factory",
    Icon: IconBuildingFactory2,
    to: routes.factory,
  },
];

export interface SectionPillProps {
  /** Phone: icons only (40×40 items, labels `sr-only`). */
  compact?: boolean;
}

export default function SectionPill({ compact = false }: SectionPillProps) {
  const location = useLocation();
  const scope = useScope();
  const active = sectionFromPath(location.pathname);

  return (
    <nav
      aria-label="Sections"
      className="flex items-center gap-[2px] rounded-full border border-line bg-surface p-[3px] shadow-[var(--shadow-pill)]"
    >
      {ITEMS.map(({ key, testid, label, Icon, to }) => {
        const on = active === key;
        return (
          <Link
            key={key}
            to={to(scope)}
            data-testid={testid}
            aria-current={on ? "page" : undefined}
            className={`flex items-center gap-[7px] rounded-full ${
              compact ? "h-10 w-10 justify-center" : "h-8 py-0 pr-[14px] pl-[11px]"
            } ${
              on
                ? "bg-ink font-semibold text-surface"
                : "font-medium text-ink-2 hover:bg-disabled-bg"
            } ${FOCUS_RING}`}
          >
            <Icon size={18} aria-hidden />
            <span className={compact ? "sr-only" : "whitespace-nowrap"}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
