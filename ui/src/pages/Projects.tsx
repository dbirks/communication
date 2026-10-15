import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useCreateProject, useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { Button } from "../components/ds/Button";
import { Field, Textarea, Input } from "../components/ds/Field";
import { Panel } from "../components/ds/Panel";
import { Row } from "../components/ds/Row";

function ProjectRow({ project }: { project: Project }) {
  return (
    <li>
      <Row to={`/projects/${project.id}`} data-testid={`project-link-${project.slug}`}>
        <span className="truncate text-[12.5px] font-semibold">{project.name}</span>
        <span className="font-mono text-[10.5px] text-muted">role: {project.my_role}</span>
        {project.description ? (
          <span className="hidden truncate text-[12.5px] text-muted sm:inline">
            {project.description}
          </span>
        ) : null}
      </Row>
    </li>
  );
}

export default function Projects() {
  const projects = useProjects();
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(
      { name: trimmed, description: description.trim() || undefined },
      {
        onSuccess: (project) => {
          setName("");
          setDescription("");
          navigate(`/projects/${project.id}`);
        },
      },
    );
  };

  const count = projects.data ? String(projects.data.items.length) : undefined;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-2">
        <h1 className="sr-only">Projects</h1>
        <Panel title="PROJECTS" meta={count ? `${count} total` : undefined}>
          <div className="p-[10px]">
            {projects.isPending ? <Spinner label="Loading projects" /> : null}
            {projects.error ? (
              <ProblemBanner error={projects.error} fallback="Projects could not be loaded." />
            ) : null}
            {projects.data ? (
              projects.data.items.length === 0 ? (
                <p className="text-body text-muted">No projects yet</p>
              ) : (
                <ul className="space-y-[4px]" data-testid="project-list">
                  {projects.data.items.map((project) => (
                    <ProjectRow key={project.id} project={project} />
                  ))}
                </ul>
              )
            ) : null}
          </div>
        </Panel>
      </div>

      <form onSubmit={onSubmit} aria-labelledby="create-heading">
        <Panel title="NEW PROJECT" headingId="create-heading">
          <div className="space-y-3 p-[10px]">
            <Field id="create-project-name" label="Name">
              <Input
                id="create-project-name"
                data-testid="create-project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
            <Field id="create-project-description" label="Description (optional)">
              <Textarea
                id="create-project-description"
                data-testid="create-project-description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              data-testid="create-project-submit"
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? "Creating…" : "Create project"}
            </Button>
            {create.error instanceof ApiError && create.error.status === 409 ? (
              <p className="text-[12.5px] text-muted">Pick a different name — the slug is taken.</p>
            ) : null}
            <FormError error={create.error} />
          </div>
        </Panel>
      </form>
    </div>
  );
}
