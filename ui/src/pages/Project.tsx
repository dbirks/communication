import { useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  useAddRepository,
  useMembers,
  useProject,
  usePutMember,
  useRepositories,
  useUsers,
} from "../api/queries";
import type { MemberRole, Project } from "../api/types";
import ActivityFeed from "../components/ActivityFeed";
import Conversations from "../components/Conversations";
import {
  FormError,
  ProblemBanner,
  Spinner,
  fieldClass,
  labelClass,
  submitClass,
} from "../components/Feedback";

const MEMBER_ROLES: readonly MemberRole[] = ["maintainer", "contributor", "viewer"];

function Repositories({ project }: { project: Project }) {
  const repos = useRepositories(project.id);
  const add = useAddRepository(project.id);
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const isMaintainer = project.my_role === "maintainer";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = gitUrl.trim();
    if (!trimmedName || !trimmedUrl) return;
    add.mutate(
      {
        name: trimmedName,
        git_url: trimmedUrl,
        default_branch: defaultBranch.trim() || "main",
      },
      {
        onSuccess: () => {
          setName("");
          setGitUrl("");
          setDefaultBranch("");
        },
      },
    );
  };

  return (
    <section aria-labelledby="repos-heading" className="space-y-3">
      <h2 id="repos-heading" className="text-lg font-semibold">
        Repositories
      </h2>
      {repos.isPending ? <Spinner label="Loading repositories" /> : null}
      {repos.error ? (
        <ProblemBanner error={repos.error} fallback="Repositories could not be loaded." />
      ) : null}
      {repos.data ? (
        repos.data.items.length === 0 ? (
          <p className="text-sm text-gray-600">No repositories yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="repo-list">
            <caption className="sr-only">Repositories in this project</caption>
            <thead>
              <tr className="border-b border-gray-300 text-left">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Git URL
                </th>
                <th scope="col" className="py-1 font-medium">
                  Default branch
                </th>
              </tr>
            </thead>
            <tbody>
              {repos.data.items.map((repo) => (
                <tr
                  key={repo.id}
                  data-testid={`repo-row-${repo.name}`}
                  className="border-b border-gray-100"
                >
                  <td className="py-1 pr-4 font-medium">{repo.name}</td>
                  <td className="py-1 pr-4 break-all">{repo.git_url}</td>
                  <td className="py-1">{repo.default_branch}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}

      {isMaintainer ? (
        <form onSubmit={onSubmit} aria-labelledby="add-repo-heading" className="space-y-3">
          <h3 id="add-repo-heading" className="text-base font-semibold">
            Add a repository
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClass} htmlFor="repo-name">
                Name
              </label>
              <input
                id="repo-name"
                className={fieldClass}
                data-testid="repo-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="repo-git-url">
                Git URL
              </label>
              <input
                id="repo-git-url"
                className={fieldClass}
                data-testid="repo-git-url"
                value={gitUrl}
                onChange={(event) => setGitUrl(event.target.value)}
                placeholder="https://github.com/example/app.git"
                required
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="repo-default-branch">
                Default branch
              </label>
              <input
                id="repo-default-branch"
                className={fieldClass}
                data-testid="repo-default-branch"
                placeholder="main"
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            className={submitClass}
            data-testid="repo-submit"
            disabled={add.isPending || !name.trim() || !gitUrl.trim()}
          >
            {add.isPending ? "Adding…" : "Add repository"}
          </button>
          {add.error instanceof ApiError && add.error.status === 409 ? (
            <p className="text-sm text-gray-700">
              That repository name is already used in this project.
            </p>
          ) : null}
          <FormError error={add.error} />
        </form>
      ) : (
        <p className="text-sm text-gray-600">Only project maintainers can add repositories.</p>
      )}
    </section>
  );
}

function Members({ project }: { project: Project }) {
  const members = useMembers(project.id);
  const users = useUsers();
  const put = usePutMember(project.id);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<MemberRole>("contributor");
  const isMaintainer = project.my_role === "maintainer";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!userId) return;
    put.mutate({ userId, role });
  };

  return (
    <section aria-labelledby="members-heading" className="space-y-3">
      <h2 id="members-heading" className="text-lg font-semibold">
        Members
      </h2>
      {members.isPending ? <Spinner label="Loading members" /> : null}
      {members.error ? (
        <ProblemBanner error={members.error} fallback="Members could not be loaded." />
      ) : null}
      {members.data ? (
        members.data.items.length === 0 ? (
          <p className="text-sm text-gray-600">No members yet.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="member-list">
            {members.data.items.map((member) => (
              <li key={member.user_id} data-testid={`member-row-${member.display_name}`}>
                <span className="font-medium">{member.display_name}</span>
                <span className="ml-2 text-gray-700">role: {member.role}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {isMaintainer ? (
        <form onSubmit={onSubmit} aria-labelledby="add-member-heading" className="space-y-3">
          <h3 id="add-member-heading" className="text-base font-semibold">
            Add or update a member
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="member-user">
                User
              </label>
              {users.isPending ? <Spinner label="Loading users" /> : null}
              {users.error ? (
                <ProblemBanner error={users.error} fallback="User directory unavailable." />
              ) : null}
              <select
                id="member-user"
                className={fieldClass}
                data-testid="member-user"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                required
              >
                <option value="">Select a user…</option>
                {users.data
                  ? users.data.items.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.display_name}
                        {user.email ? ` (${user.email})` : ""}
                      </option>
                    ))
                  : null}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="member-role">
                Role
              </label>
              <select
                id="member-role"
                className={fieldClass}
                data-testid="member-role"
                value={role}
                onChange={(event) => setRole(event.target.value as MemberRole)}
              >
                {MEMBER_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            type="submit"
            className={submitClass}
            data-testid="member-submit"
            disabled={put.isPending || !userId}
          >
            {put.isPending ? "Saving…" : "Save member"}
          </button>
          <FormError error={put.error} />
        </form>
      ) : (
        <p className="text-sm text-gray-600">Only project maintainers can change members.</p>
      )}
    </section>
  );
}

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const project = useProject(id);

  if (project.isPending) return <Spinner label="Loading project" />;

  if (project.error instanceof ApiError && project.error.status === 404) {
    return (
      <section aria-labelledby="project-missing-heading">
        <h1 id="project-missing-heading" className="text-2xl font-semibold">
          Project
        </h1>
        <p className="mt-2 text-red-900" role="alert" data-testid="project-not-found">
          Project not found or you do not have access
        </p>
      </section>
    );
  }

  if (project.error || !project.data) {
    return (
      <section aria-labelledby="project-error-heading">
        <h1 id="project-error-heading" className="text-2xl font-semibold">
          Project
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }

  const projectData = project.data;

  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <h1 data-testid="project-name" className="text-2xl font-semibold">
          {projectData.name}
        </h1>
        <p className="text-sm text-gray-600">
          <span>role: {projectData.my_role}</span>
          <span className="px-2" aria-hidden="true">
            ·
          </span>
          <span>slug: {projectData.slug}</span>
          {projectData.description ? (
            <>
              <span className="px-2" aria-hidden="true">
                ·
              </span>
              <span>{projectData.description}</span>
            </>
          ) : null}
        </p>
      </header>
      <Repositories project={projectData} />
      <Members project={projectData} />
      <Conversations project={projectData} />
      <ActivityFeed projectId={projectData.id} />
    </div>
  );
}
