/**
 * The Steps list row (design 3b: 40px, name + version, config summary, kind
 * in mono, "N workflows") and the family grouping over it.
 *
 * The config summary needs the latest revision's `config`, which the LIST
 * endpoint does not carry (identity only) — so each row takes the detail
 * query it shares with the cache the detail panel uses; while it loads the
 * summary is simply not shown, never faked. The "N workflows" number is
 * `used_in_count` and nothing else: an empty usage set reads "not used yet".
 */
import { Link } from "react-router";
import { useNodeTemplate } from "../../api/nodeTemplates";
import type { NodeTemplate } from "../../api/nodeTemplates";
import { configSummary, familyOf, FAMILY_ORDER, type StepFamily } from "./kindFamily";
import { routes } from "../../lib/routes";

/** Families present, in the artboard's order; templates sorted by name. */
export function groupByFamily(templates: NodeTemplate[]): [StepFamily, NodeTemplate[]][] {
  const byFamily = new Map<StepFamily, NodeTemplate[]>();
  for (const template of templates) {
    const family = familyOf(template.kind);
    byFamily.set(family, [...(byFamily.get(family) ?? []), template]);
  }
  return FAMILY_ORDER.filter((family) => byFamily.has(family)).map((family) => [
    family,
    (byFamily.get(family) ?? [])
      .slice()
      .sort((a, b) => a.display_name.localeCompare(b.display_name)),
  ]);
}

const usageCopy = (template: NodeTemplate): { text: string; muted: boolean } => {
  if (template.used_in_count > 0) {
    const one = template.used_in_count === 1;
    return { text: `${template.used_in_count} workflow${one ? "" : "s"}`, muted: false };
  }
  return { text: "not used yet", muted: true };
};

export interface StepRowProps {
  template: NodeTemplate;
  selected?: boolean;
}

export function StepRow({ template, selected = false }: StepRowProps) {
  // The row and the detail panel share this cache entry (same key) — the
  // summary is one fetch, not one fetch per view.
  const detailQuery = useNodeTemplate(template.id);
  const latest = detailQuery.data?.revisions[0];
  const summary = latest ? configSummary(template.kind, latest.config ?? {}) : null;
  const usage = usageCopy(template);

  const stateClass = selected
    ? "border-ink shadow-(--shadow-raised)"
    : "border-line hover:border-line-strong";

  return (
    <Link
      to={routes.step(template.id)}
      aria-current={selected ? "true" : undefined}
      className={`flex h-[40px] w-full items-center gap-[9px] rounded-[3px] border bg-surface px-[10px] text-left text-ink ${stateClass}`}
      data-testid={`step-row-${template.id}`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
        {template.display_name}
        {template.latest_revision.version_label !== "" ? (
          <span className="ml-[6px] font-mono text-[10.5px] font-normal text-muted">
            v{template.latest_revision.version_label}
          </span>
        ) : null}
      </span>
      <span
        className="hidden min-w-0 max-w-[38%] truncate font-mono text-[10.5px] text-muted sm:block"
        data-testid={`step-row-summary-${template.id}`}
      >
        {summary ?? "—"}
      </span>
      <span className="hidden w-[92px] shrink-0 truncate text-right font-mono text-[10.5px] text-muted md:block">
        {template.kind}
      </span>
      <span
        className={`w-[84px] shrink-0 text-right font-mono text-[10.5px] ${usage.muted ? "text-muted" : ""}`}
        data-testid={`step-row-usage-${template.id}`}
      >
        {usage.text}
      </span>
    </Link>
  );
}
