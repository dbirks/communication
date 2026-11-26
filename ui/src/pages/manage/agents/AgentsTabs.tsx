/**
 * The tab row of Manage → Agents & models: Profiles · Skills · Step
 * templates · Models · Assistant. Each tab is a real Link with a `?tab=`
 * query; the selected tab is semibold with a 2px ink underline and
 * `aria-current="page"`. The tabs leave the `:itemId` in the path alone by
 * navigating to the section root with the tab in the query string — a
 * sheet open on a tab other than Profiles is closed by the same navigation.
 */
import { Link } from "react-router";
import { routes } from "../../../lib/routes";

export const AGENT_TABS = [
  { value: "profiles", label: "Profiles" },
  { value: "skills", label: "Skills" },
  { value: "steps", label: "Step templates" },
  { value: "models", label: "Models" },
  { value: "assistant", label: "Assistant" },
] as const;

export type AgentTab = (typeof AGENT_TABS)[number]["value"];

export function tabFromSearchParam(value: string | null): AgentTab {
  return AGENT_TABS.some((tab) => tab.value === value) ? (value as AgentTab) : "profiles";
}

export default function AgentsTabs({ current }: { current: AgentTab }) {
  const base = routes.manage("agents");
  return (
    <nav
      aria-label="Agents & models sections"
      data-testid="agents-tabs"
      className="mt-[26px] border-b border-line"
    >
      {AGENT_TABS.map((tab) => {
        const selected = tab.value === current;
        return (
          <Link
            key={tab.value}
            to={`${base}?tab=${tab.value}`}
            aria-current={selected ? "page" : undefined}
            data-testid={`agents-tab-${tab.value}`}
            className={`mr-[22px] -mb-px inline-block border-b-2 px-0 py-2 text-[13.5px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              selected
                ? "border-ink font-semibold text-ink"
                : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
