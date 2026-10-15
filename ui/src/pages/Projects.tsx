import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { useCreateProject, useProjects } from "../api/queries";
import type { Project } from "../api/types";
import {
  FormError,
  ProblemBanner,
  Spinner,
  fieldClass,
  labelClass,
  submitClass,
} from "../components/Feedback";

const linkClass =
  "block rounded border border-gray-200 px-3 py-2 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

function ProjectRow({ project }: { project: Project }) {
  return (
    <li>
      <Link
        to={`/projects/${project.id}`}
        className={linkClass}
        data-testid={`project-link-${project.slug}`}
      >
        <span className="font-medium">{project.name}</span>
        <span className="ml-2 text-sm text-gray-600">role: {project.my_role}</span>
        {project.description ? (
          <span className="block text-sm text-gray-600">{project.description}</span>
        ) : null}
      </Link>
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

  return (
    <section aria-labelledby="projects-heading" className="grid gap-8 md:grid-cols-[1fr_20rem]">
      <div>
        <h1 id="projects-heading" className="text-2xl font-semibold">
          Projects
        </h1>
        {projects.isPending ? <Spinner label="Loading projects" /> : null}
        {projects.error ? (
          <ProblemBanner error={projects.error} fallback="Projects could not be loaded." />
        ) : null}
        {projects.data ? (
          projects.data.items.length === 0 ? (
            <p className="mt-2 text-gray-700">No projects yet</p>
          ) : (
            <ul className="mt-2 space-y-2" data-testid="project-list">
              {projects.data.items.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </ul>
          )
        ) : null}
      </div>

      <form onSubmit={onSubmit} aria-labelledby="create-heading" className="space-y-3">
        <h2 id="create-heading" className="text-lg font-semibold">
          New project
        </h2>
        <div>
          <label className={labelClass} htmlFor="create-project-name">
            Name
          </label>
          <input
            id="create-project-name"
            className={fieldClass}
            data-testid="create-project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="create-project-description">
            Description (optional)
          </label>
          <textarea
            id="create-project-description"
            className={fieldClass}
            data-testid="create-project-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className={submitClass}
          data-testid="create-project-submit"
          disabled={create.isPending || !name.trim()}
        >
          {create.isPending ? "Creating…" : "Create project"}
        </button>
        {create.error instanceof ApiError && create.error.status === 409 ? (
          <p className="text-sm text-gray-700">Pick a different name — the slug is taken.</p>
        ) : null}
        <FormError error={create.error} />
      </form>
    </section>
  );
}
