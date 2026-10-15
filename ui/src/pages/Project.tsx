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
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { Button } from "../components/ds/Button";
import { Field, Input, Select } from "../components/ds/Field";
import { Panel } from "../components/ds/Panel";
import { Row } from "../components/ds/Row";
import { SubNav } from "../components/ds/SubNav";

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
    <Panel
      id="repos"
      title="REPOSITORIES"
      headingId="repos-heading"
      headingLevel={2}
      meta={repos.data ? `${repos.data.items.length} total` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {repos.isPending ? <Spinner label="Loading repositories" /> : null}
        {repos.error ? (
          <ProblemBanner error={repos.error} fallback="Repositories could not be loaded." />
        ) : null}
        {repos.data ? (
          repos.data.items.length === 0 ? (
            <p className="text-[12.5px] text-muted">No repositories yet.</p>
          ) : (
            <table className="w-full border-collapse text-[12.5px]" data-testid="repo-list">
              <caption className="sr-only">Repositories in this project</caption>
              <thead>
                <tr className="border-b border-line-strong text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                  <th scope="col" className="py-1 pr-4">
                    Name
                  </th>
                  <th scope="col" className="py-1 pr-4">
                    Git URL
                  </th>
                  <th scope="col" className="py-1">
                    Default branch
                  </th>
                </tr>
              </thead>
              <tbody>
                {repos.data.items.map((repo) => (
                  <tr
                    key={repo.id}
                    data-testid={`repo-row-${repo.name}`}
                    className="border-b border-line-soft last:border-b-0"
                  >
                    <td className="py-[5px] pr-4 font-semibold">{repo.name}</td>
                    <td className="py-[5px] pr-4 font-mono text-[11px] break-all">
                      {repo.git_url}
                    </td>
                    <td className="py-[5px] font-mono text-[11px]">{repo.default_branch}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}

        {isMaintainer ? (
          <form onSubmit={onSubmit} aria-labelledby="add-repo-heading" className="space-y-3">
            <h3
              id="add-repo-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Add a repository
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id="repo-name" label="Name">
                <Input
                  id="repo-name"
                  data-testid="repo-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </Field>
              <Field id="repo-git-url" label="Git URL">
                <Input
                  id="repo-git-url"
                  data-testid="repo-git-url"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/example/app.git"
                  required
                />
              </Field>
              <Field id="repo-default-branch" label="Default branch">
                <Input
                  id="repo-default-branch"
                  data-testid="repo-default-branch"
                  placeholder="main"
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                />
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid="repo-submit"
              disabled={add.isPending || !name.trim() || !gitUrl.trim()}
            >
              {add.isPending ? "Adding…" : "Add repository"}
            </Button>
            {add.error instanceof ApiError && add.error.status === 409 ? (
              <p className="text-[12.5px] text-muted">
                That repository name is already used in this project.
              </p>
            ) : null}
            <FormError error={add.error} />
          </form>
        ) : (
          <p className="text-[12.5px] text-muted">Only project maintainers can add repositories.</p>
        )}
      </div>
    </Panel>
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
    <Panel
      id="members"
      title="MEMBERS"
      headingId="members-heading"
      headingLevel={2}
      meta={members.data ? `${members.data.items.length} total` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {members.isPending ? <Spinner label="Loading members" /> : null}
        {members.error ? (
          <ProblemBanner error={members.error} fallback="Members could not be loaded." />
        ) : null}
        {members.data ? (
          members.data.items.length === 0 ? (
            <p className="text-[12.5px] text-muted">No members yet.</p>
          ) : (
            <ul className="space-y-[4px]" data-testid="member-list">
              {members.data.items.map((member) => (
                <li key={member.user_id} data-testid={`member-row-${member.display_name}`}>
                  <Row>
                    <span className="text-[12.5px] font-semibold">{member.display_name}</span>
                    <span className="font-mono text-[10.5px] text-muted">role: {member.role}</span>
                  </Row>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {isMaintainer ? (
          <form onSubmit={onSubmit} aria-labelledby="add-member-heading" className="space-y-3">
            <h3
              id="add-member-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Add or update a member
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="member-user"
                label="User"
                hint={
                  <>
                    {users.isPending ? <Spinner label="Loading users" /> : null}
                    {users.error ? (
                      <ProblemBanner error={users.error} fallback="User directory unavailable." />
                    ) : null}
                  </>
                }
              >
                <Select
                  id="member-user"
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
                </Select>
              </Field>
              <Field id="member-role" label="Role">
                <Select
                  id="member-role"
                  data-testid="member-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as MemberRole)}
                >
                  {MEMBER_ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid="member-submit"
              disabled={put.isPending || !userId}
            >
              {put.isPending ? "Saving…" : "Save member"}
            </Button>
            <FormError error={put.error} />
          </form>
        ) : (
          <p className="text-[12.5px] text-muted">Only project maintainers can change members.</p>
        )}
      </div>
    </Panel>
  );
}

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const project = useProject(id);
  const [activeSection, setActiveSection] = useState("#repos");

  if (project.isPending) return <Spinner label="Loading project" />;

  if (project.error instanceof ApiError && project.error.status === 404) {
    return (
      <section aria-labelledby="project-missing-heading">
        <h1 id="project-missing-heading" className="text-title-l font-bold">
          Project
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="project-not-found">Project not found or you do not have access</span>
        </p>
      </section>
    );
  }

  if (project.error || !project.data) {
    return (
      <section aria-labelledby="project-error-heading">
        <h1 id="project-error-heading" className="text-title-l font-bold">
          Project
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }

  const projectData = project.data;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 data-testid="project-name" className="text-title-l font-bold">
          {projectData.name}
        </h1>
        <p className="font-mono text-[11px] text-muted">
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
              <span className="font-ui text-[12.5px]">{projectData.description}</span>
            </>
          ) : null}
        </p>
      </header>
      <div className="grid items-start gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
        <SubNav
          className="md:sticky md:top-[64px]"
          active={activeSection}
          onNavigate={setActiveSection}
          items={[
            { href: "#repos", label: "Repositories" },
            { href: "#members", label: "Members" },
            { href: "#conversations", label: "Conversations" },
            { href: "#activity", label: "Activity" },
          ]}
        />
        <div className="min-w-0 space-y-4">
          <Repositories project={projectData} />
          <Members project={projectData} />
          <Conversations project={projectData} />
          <ActivityFeed projectId={projectData.id} />
        </div>
      </div>
    </div>
  );
}
