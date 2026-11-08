/**
 * The briefing's `Start run` (finding 03): Today's empty state opens the run
 * form IN PLACE — the same `NewRunForm` the Runs tab mounts, in
 * `RunFormDialog`'s chrome — instead of routing to a page the nav no longer
 * shows. The caller's projects come from the project list; one project is
 * preselected, several are asked for with a small select at the top of the
 * dialog. Esc, `Cancel` and the backdrop close it; nothing navigates.
 *
 * ONE modal (the 1k rule from `pages/Repository.tsx`): when the pinned
 * revision declares `input_specs`, the typed form brings its own dialog
 * chrome — this shell steps down instead of wrapping a second modal.
 */
import { useEffect, useState } from "react";
import { NewRunForm } from "../m4/NewRunForm";
import { RunFormDialog } from "../workflows/inputs/RunFormDialog";
import { Field, Select } from "../ds/Field";
import { ProblemBanner, Spinner } from "../Feedback";
import { useProjects } from "../../api/queries";

export interface StartRunDialogProps {
  onClose: () => void;
}

export function StartRunDialog({ onClose }: StartRunDialogProps) {
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  const [projectId, setProjectId] = useState("");
  // One project is not a choice — the form opens on it. Several are named
  // by the select below and nothing is started until one is picked.
  useEffect(() => {
    if (items.length === 1) setProjectId(items[0].id);
  }, [items]);
  const selected = items.find((project) => project.id === projectId) ?? null;

  // NewRunForm reports which form the revision asks for; `typed` brings its
  // own modal chrome, so this shell steps down (one modal, not two).
  const [formMode, setFormMode] = useState<"typed" | "freeform">("freeform");
  if (formMode === "typed" && selected) {
    return (
      <div data-testid="home-start-run-dialog">
        <NewRunForm
          key={selected.id}
          projectId={selected.id}
          onFormModeChange={setFormMode}
          onCancel={onClose}
        />
      </div>
    );
  }

  return (
    <div data-testid="home-start-run-dialog">
      <RunFormDialog
        title="Start a run"
        subtitle={selected ? selected.name : "choose a project"}
        helper="The fields come from the workflow revision the project pins."
        onCancel={onClose}
        submit={null}
      >
        <div className="space-y-3">
          {projects.isPending ? <Spinner label="Loading projects" /> : null}
          {projects.isError ? (
            <ProblemBanner error={projects.error} fallback="Projects could not be loaded." />
          ) : null}
          {!projects.isPending && !projects.isError && items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="home-start-run-no-projects">
              You are not a member of any project yet, so there is nothing to start a run against.
            </p>
          ) : null}
          {items.length > 0 ? (
            <Field id="home-start-run-project" label="Project">
              <Select
                id="home-start-run-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="min-w-0 truncate"
                data-testid="home-start-run-project"
              >
                {items.length === 1 ? null : <option value="">— choose —</option>}
                {items.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {selected ? (
            <NewRunForm key={selected.id} projectId={selected.id} onFormModeChange={setFormMode} />
          ) : null}
        </div>
      </RunFormDialog>
    </div>
  );
}
