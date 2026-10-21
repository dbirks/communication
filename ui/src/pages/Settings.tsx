/**
 * Settings (route `/settings/:tab`): the per-person preferences. Two tabs —
 * Layout (how the sidebar looks, 3g) and Assistant (the trust level) — both
 * read and write through the preferences client (contract C2). The route
 * builder maps bare `/settings` to `/settings/layout`, so an unknown tab
 * still renders Layout instead of an error page.
 */
import { useParams } from "react-router";
import { routes } from "../lib/routes";
import LayoutSettings from "./settings/Layout";
import AssistantSettings from "./settings/Assistant";

const TABS = [
  { key: "layout", label: "Layout" },
  { key: "assistant", label: "Assistant" },
] as const;

export default function Settings() {
  const { tab } = useParams<{ tab: string }>();
  const active: (typeof TABS)[number]["key"] = tab === "assistant" ? "assistant" : "layout";

  return (
    <section data-testid="settings-page">
      <h1 className="text-title-l font-bold">Settings</h1>
      <nav aria-label="Settings" className="mt-3 flex items-end gap-4 border-b border-line-soft">
        {TABS.map((item) => {
          const selected = item.key === active;
          return (
            <a
              key={item.key}
              href={routes.settings(item.key)}
              data-testid={`settings-tab-${item.key}`}
              aria-current={selected ? "page" : undefined}
              className={`-mb-px border-b-2 pb-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                selected
                  ? "border-ink font-semibold text-ink"
                  : "border-transparent font-normal text-muted hover:text-ink"
              }`}
            >
              {item.label}
            </a>
          );
        })}
        {/* Operations is not a settings tab: a tab-styled external link (README Shell footer 4h). */}
        <a
          href={routes.ops()}
          data-testid="settings-ops-link"
          className="-mb-px border-b-2 border-transparent pb-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <span className="block text-[13px] font-normal text-muted hover:text-ink">
            Operations
          </span>
          <span className="block text-[11px] text-muted">
            Workers, queue health and the agent × capability matrix
          </span>
        </a>
      </nav>
      <div className="mt-4 max-w-[440px]">
        {active === "layout" ? <LayoutSettings /> : <AssistantSettings />}
      </div>
    </section>
  );
}
