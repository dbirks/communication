/**
 * The Steps page's 360px detail panel (design 3b): description, key/value
 * facts from the LATEST revision, USED IN N WORKFLOWS (workflow name → link,
 * the nodes that reference it, the workflow's revision chip and the honest
 * source / revision state from the usage report), and the two writes —
 * "Edit for all N → version" and "Duplicate as a new step…".
 *
 * Unknown id (the API's 404 sentinel) gets its own copy, not a red error.
 */
import { Link } from "react-router";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { StatusChip } from "../ds/Row";
import { FormError, Spinner } from "../Feedback";
import { ApiError } from "../../api/client";
import { useNodeTemplateUsage, type Usage } from "../../api/useUsage";
import type { NodeTemplateDetail } from "../../api/nodeTemplates";
import { bumpSemver } from "./kindFamily";
import { routes } from "../../lib/routes";

function factValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  } catch {
    return String(value);
  }
}

/** The panel's facts: the latest revision's config keys + its fixed members. */
function facts(latest: NodeTemplateDetail["revisions"][number]) {
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(latest.config ?? {})) {
    if (key === "body") continue; // loop bodies are graphs, not one-line facts
    rows.push([key, factValue(value)]);
  }
  rows.push(["workspace", latest.workspace_mode]);
  const properties =
    latest.parameters &&
    typeof latest.parameters === "object" &&
    latest.parameters["properties"] &&
    typeof latest.parameters["properties"] === "object"
      ? Object.keys(latest.parameters["properties"]).length
      : 0;
  if (properties > 0) rows.push(["parameters", `${properties}`]);
  return rows;
}

function UsageRow({ usage }: { usage: Usage }) {
  const href =
    usage.source === "draft" && usage.draft_id != null
      ? routes.draft(usage.pipeline_id, usage.draft_id)
      : routes.workflow(usage.pipeline_id);
  return (
    <li
      className="flex min-h-[26px] flex-wrap items-center gap-x-[6px] gap-y-[2px] py-[3px]"
      data-testid="step-usage-row"
    >
      <Link
        className="text-[12px] font-medium underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        to={href}
        data-testid={`step-usage-workflow-${usage.pipeline_id}`}
      >
        {usage.pipeline_name}
      </Link>
      <span className="font-mono text-[10.5px] text-muted">
        {usage.node_label ?? usage.node_id}
      </span>
      {usage.source === "draft" ? (
        <StatusChip
          state="info"
          label="draft"
          labelProps={{ "data-testid": `step-usage-source-${usage.pipeline_id}-${usage.node_id}` }}
        />
      ) : (
        <span className="font-mono text-[10px] text-muted">v{usage.revision_number}</span>
      )}
    </li>
  );
}

export interface StepDetailPanelProps {
  detail: NodeTemplateDetail | undefined;
  loading: boolean;
  error: unknown;
  onEdit: () => void;
  onDuplicate: () => void;
}

export function StepDetailPanel({
  detail,
  loading,
  error,
  onEdit,
  onDuplicate,
}: StepDetailPanelProps) {
  const usageQuery = useNodeTemplateUsage(detail?.template.id ?? "");
  const usage = usageQuery.data;
  const workflowCount = usage?.workflow_count ?? 0;
  const usedInHeading = usage
    ? `USED IN ${workflowCount} WORKFLOW${workflowCount === 1 ? "" : "S"}`
    : "USED IN …";
  if (loading) {
    return (
      <p className="text-[12.5px] text-muted" data-testid="step-detail-loading">
        Loading the step…
      </p>
    );
  }
  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <Alert state="info" label="NOT FOUND" testid="step-detail-not-found">
          This step does not exist (or was retired). Back to the list:{" "}
          <Link
            to={routes.steps()}
            className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Steps
          </Link>
        </Alert>
      );
    }
    return <FormError error={error} testid="step-detail-error" />;
  }
  if (!detail) return null;

  const { template, revisions, usages } = detail;
  const latest = revisions[0];
  const suggested = latest ? (bumpSemver(latest.version_label) ?? latest.version_label) : null;
  // The serving image's detail endpoint can answer with an empty
  // `latest_revision` identity while `revisions` is complete — fall back to
  // the newest revision for the version chip (never render a bare "v").
  const versionLabel =
    template.latest_revision.version_label !== ""
      ? template.latest_revision.version_label
      : (latest?.version_label ?? "");

  return (
    <div data-testid="step-detail">
      <header className="flex flex-wrap items-center gap-[6px]">
        <h2 className="text-[15px] font-bold">{template.display_name}</h2>
        {versionLabel !== "" ? (
          <span className="font-mono text-[11px] text-muted">v{versionLabel}</span>
        ) : null}
        <span className="font-mono text-[10.5px] text-muted">{template.kind}</span>
      </header>
      {template.description ? (
        <p className="mt-[6px] text-[12px] text-ink">{template.description}</p>
      ) : null}

      {latest ? (
        <dl className="mt-[10px] space-y-[4px]" data-testid="step-detail-facts">
          {facts(latest).map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-[8px] text-[11.5px]">
              <dt className="w-[86px] shrink-0 font-mono text-[10.5px] text-muted">{key}</dt>
              <dd className="min-w-0 truncate font-mono text-[11px]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <section className="mt-[12px]" data-testid="step-usage">
        <h3 className="font-mono text-[10px] font-bold tracking-[.08em] text-muted">
          {usedInHeading}
        </h3>
        {usageQuery.isPending ? (
          <Spinner label="Loading usage" />
        ) : usageQuery.isError ? (
          <p className="mt-[4px] text-[11.5px] text-muted" data-testid="step-usage-error">
            usage unavailable — the workflows that use this step could not be read
          </p>
        ) : (usage?.uses.length ?? 0) === 0 ? (
          <p className="mt-[4px] text-[11.5px] text-muted" data-testid="step-detail-unused">
            not used yet — published workflows reference it as {template.slug}
          </p>
        ) : (
          <>
            <ul className="mt-[4px] divide-y divide-line" data-testid="step-detail-usages">
              {usage?.uses.map((use) => (
                <UsageRow key={`${use.pipeline_id}:${use.source}:${use.node_id}`} usage={use} />
              ))}
            </ul>
            {usage?.truncated ? (
              <p className="mt-[4px] text-[11px] text-faint" data-testid="step-usage-truncated">
                showing first 200
              </p>
            ) : null}
          </>
        )}
      </section>

      <div className="mt-[12px] flex flex-col gap-[8px]">
        <Button
          variant="primary"
          onClick={onEdit}
          disabled={!latest || !suggested}
          data-testid="step-detail-edit-for-all"
        >
          {suggested ? `Edit for all ${usages.length} → version ${suggested}` : "Edit for all"}
        </Button>
        <Button variant="secondary" onClick={onDuplicate} data-testid="step-detail-duplicate">
          Duplicate as a new step…
        </Button>
      </div>
    </div>
  );
}
