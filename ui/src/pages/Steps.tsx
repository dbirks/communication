/**
 * Steps (design 3b): the organization's saved step (node-template) registry
 * on the ADR-0049 part 1 API. A step is one reusable parameterized node —
 * the API word is "node template", the UI word is "step" (settled
 * vocabulary decision).
 *
 * `/steps` — grouped list (40px rows: name + version, config summary, kind,
 * "N workflows" — the count only ever comes from `used_in_count`).
 * `/steps/:id` — the same list plus the 360px detail panel (description,
 * facts from the latest revision, USED IN N WORKFLOWS, Edit-for-all and
 * Duplicate). The panel stacks below the list on phone.
 *
 * Honest states: an empty registry, a server without the endpoint, and an
 * unknown id each get their own copy — nothing is faked.
 */
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Alert } from "../components/ds/Alert";
import { DuplicateDialog } from "../components/steps/DuplicateDialog";
import { EditForAllDialog } from "../components/steps/EditForAllDialog";
import { StepDetailPanel } from "../components/steps/StepDetailPanel";
import { StepRow, groupByFamily } from "../components/steps/StepRow";
import { FormError } from "../components/Feedback";
import { useNodeTemplate, useNodeTemplates, type NodeTemplate } from "../api/nodeTemplates";
import { routes } from "../lib/routes";

export default function Steps() {
  const { id } = useParams<{ id: string }>();
  const [editOpen, setEditOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);

  const listQuery = useNodeTemplates();
  const detailQuery = useNodeTemplate(id);

  const templates = listQuery.data?.templates ?? [];
  const detail = detailQuery.data;
  const selected: NodeTemplate | undefined = detail?.template ?? templates.find((t) => t.id === id);
  const latest = detail?.revisions[0];

  return (
    <section data-testid="steps-page" className="flex min-h-0 flex-col gap-[14px]">
      <header>
        <h1 className="text-title-l font-bold">Steps</h1>
        <p className="mt-1 text-[12px] text-muted">
          Saved node templates in YAML — kind: NodeTemplate. A step can be edited for every workflow
          that uses it, or duplicated into a new step.
        </p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-[14px] lg:flex-row">
        <div className="min-w-0 flex-1" data-testid="steps-list">
          {listQuery.isPending ? (
            <p className="text-[12.5px] text-muted" data-testid="steps-loading">
              Loading the step registry…
            </p>
          ) : listQuery.error ? (
            <FormError error={listQuery.error} testid="steps-error" />
          ) : listQuery.data === null ? (
            <Alert state="info" label="NOT AVAILABLE YET" testid="steps-registry-unavailable">
              This server does not expose the step registry yet. The steps you save in a workflow
              will appear here once it does.
            </Alert>
          ) : templates.length === 0 ? (
            <div className="max-w-[560px] text-[12.5px]">
              <p data-testid="steps-empty">
                No saved steps yet — save one from a workflow's step inspector (Also save as a
                reusable step).
              </p>
              <Link
                to={routes.workflows()}
                className="mt-[6px] inline-block underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                Open the workflows
              </Link>
            </div>
          ) : (
            <ol className="space-y-[10px]">
              {groupByFamily(templates).map(([family, items]) => (
                <li key={family}>
                  <h2
                    className="mb-[4px] font-mono text-[10px] font-bold tracking-[.08em] text-muted"
                    data-testid={`steps-group-${family.toLowerCase()}`}
                  >
                    {family}
                  </h2>
                  <div className="space-y-[4px]">
                    {items.map((template) => (
                      <StepRow
                        key={template.id}
                        template={template}
                        selected={template.id === id}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        {id !== undefined ? (
          <div className="w-full shrink-0 lg:w-[360px] lg:border-l lg:border-line lg:pl-[14px]">
            <StepDetailPanel
              detail={detail}
              loading={detailQuery.isPending}
              error={detailQuery.error}
              onEdit={() => setEditOpen(true)}
              onDuplicate={() => setDuplicateOpen(true)}
            />
          </div>
        ) : null}
      </div>
      {selected && latest ? (
        <>
          <EditForAllDialog
            open={editOpen}
            onClose={() => setEditOpen(false)}
            templateId={selected.id}
            usedInCount={selected.used_in_count}
            latest={latest}
          />
          <DuplicateDialog
            open={duplicateOpen}
            onClose={() => setDuplicateOpen(false)}
            source={selected}
          />
        </>
      ) : null}
    </section>
  );
}
