/**
 * Settings (route `/settings/:tab`): the per-person preferences and the
 * Operations dashboard. Three tabs — Layout (how the sidebar looks, 3g),
 * Assistant (the trust level) and Operations (worker fleet health) — read and
 * write through the preferences client (contract C2) and the ops endpoints.
 * The route builder maps bare `/settings` to `/settings/layout`, so an unknown
 * tab still renders Layout instead of an error page.
 */
import { NavLink, useParams } from "react-router";
import { useReplicaName } from "../api/replica";
import { routes } from "../lib/routes";
import LayoutSettings from "./settings/Layout";
import AssistantSettings from "./settings/Assistant";
import { OperationsBody } from "../components/ops/OperationsBody";

type SettingsTab = "layout" | "assistant" | "operations";

const TABS: Array<{ key: SettingsTab; label: string; description?: string }> = [
  { key: "layout", label: "Layout" },
  { key: "assistant", label: "Assistant" },
  {
    key: "operations",
    label: "Operations",
    description: "Workers, queue health and the agent × capability matrix",
  },
];

/** Selected tab: ink border + semibold ink label; unselected: transparent + muted. */
const tabClassName = (isActive: boolean) =>
  `-mb-px border-b-2 pb-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
    isActive
      ? "border-ink font-semibold text-ink"
      : "border-transparent font-normal text-muted hover:text-ink"
  }`;

export default function Settings() {
  const { tab } = useParams<{ tab: string }>();
  const replica = useReplicaName();
  const active: SettingsTab =
    tab === "assistant" ? "assistant" : tab === "operations" ? "operations" : "layout";

  return (
    <section data-testid="settings-page">
      <h1 className="text-title-l font-bold">Settings</h1>
      <nav aria-label="Settings" className="mt-3 flex items-end gap-4 border-b border-line-soft">
        {TABS.map((item) =>
          item.key === "operations" ? (
            <NavLink
              key="operations"
              to={routes.settings("operations")}
              data-testid="settings-ops-link"
              className={({ isActive }) => tabClassName(isActive)}
            >
              <span className="block text-[13px] font-semibold">{item.label}</span>
              {item.description ? (
                <span className="block text-[11px] text-muted">{item.description}</span>
              ) : null}
            </NavLink>
          ) : (
            <NavLink
              key={item.key}
              to={routes.settings(item.key)}
              data-testid={`settings-tab-${item.key}`}
              className={({ isActive }) => tabClassName(isActive)}
            >
              <span className="block text-[13px] font-semibold">{item.label}</span>
              {item.description ? (
                <span className="block text-[11px] text-muted">{item.description}</span>
              ) : null}
            </NavLink>
          ),
        )}
      </nav>
      {active === "operations" ? (
        <div className="mt-4">
          <OperationsBody />
        </div>
      ) : (
        <div className="mt-4 max-w-[440px]">
          {active === "layout" ? <LayoutSettings /> : <AssistantSettings />}
        </div>
      )}

      {/* About this server: the operator signal the sidebar footer used to
          carry — which API replica answered the last request. The name comes
          from the same source the sidebar read it from (`useReplicaName`); the
          Operations page shows it too. */}
      <section
        data-testid="settings-about"
        className="mt-6 max-w-[440px] border-t border-line-soft pt-4"
      >
        <h2 className="text-[13px] font-semibold text-ink">About this server</h2>
        <p className="mt-1 font-mono text-[11px] text-muted" data-testid="replica-badge">
          replica: {replica}
        </p>
      </section>
    </section>
  );
}
