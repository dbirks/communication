/**
 * Manage → People & access (redesign R7): who can see and run what.
 *
 * One project selected is the MembersPanel the project's own members page
 * mounts today (`components/project/MembersPanel.tsx`) — same component, same
 * `PUT` that is both add and role change, same role table, unchanged body.
 *
 * "All projects" is the merged answer to a question no single route serves:
 * the directory has no per-person project list, so the page fans
 * `GET /projects/{id}/members` over the caller's projects (the same
 * `useQueries` shape `pages/Workflows.tsx` uses) and folds the rows by user id.
 * A person in several projects lists them comma-separated; the role column
 * prints the *highest* role they hold anywhere, because that is what "what can
 * this person do" means, and the per-project roles stay in the cell's title so
 * nothing is hidden. A project whose member list could not be read is counted
 * as unread rather than dropped.
 */
import { useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { queryKeys, useProjects } from "../../api/queries";
import type { MemberList, MemberRole } from "../../api/types";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { MembersPanel } from "../../components/project/MembersPanel";
import { ProjectFilter } from "./ProjectFilter";
import { ManageTable, SectionHeader } from "./ManageTable";
import type { ManageColumn, ManageRow } from "./ManageTable";

const COLUMNS: ManageColumn[] = [
  { key: "person", label: "Person" },
  { key: "projects", label: "Projects" },
  { key: "role", label: "Role" },
];

/** The role ladder, highest first — the order the API's own copy uses
 * ("maintainer = everything … contributor and viewer are read-only"). */
const RANK: readonly MemberRole[] = ["maintainer", "contributor", "viewer"];

export default function PeopleSection() {
  const projects = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectParam = searchParams.get("project") ?? "";

  const items = projects.data?.items ?? [];
  const selected = projectParam ? items.find((item) => item.id === projectParam) : undefined;

  const setProject = (projectId: string) => {
    const next = new URLSearchParams(searchParams);
    if (projectId) next.set("project", projectId);
    else next.delete("project");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-[18px]" data-testid="manage-people">
      <SectionHeader title="People & access" blurb="Who can see and run what." />

      <ProjectFilter projects={items} value={projectParam} onChange={setProject} />

      {projects.isPending && !projects.data ? <Spinner label="Loading people" /> : null}
      {projects.error ? (
        <ProblemBanner
          error={projects.error}
          fallback="Projects could not be loaded."
          subject="your projects"
          retry={{ onClick: () => void projects.refetch(), pending: projects.isFetching }}
        />
      ) : null}

      {selected ? <MembersPanel project={selected} /> : <AllPeople projects={items} />}
    </div>
  );
}

/** All projects: the merged person table. */
export function AllPeople({ projects }: { projects: readonly { id: string; name: string }[] }) {
  const reads = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.members(project.id),
      queryFn: () => apiFetch<MemberList>(`/api/v1/projects/${project.id}/members`),
    })),
  });

  const people = new Map<string, { name: string; projects: string[]; roles: MemberRole[] }>();
  const unread: string[] = [];
  let loading = false;
  projects.forEach((project, index) => {
    const read = reads[index];
    if (!read) return;
    if (read.isPending) loading = true;
    if (read.error) {
      unread.push(project.name);
      return;
    }
    for (const member of read.data?.items ?? []) {
      const entry = people.get(member.user_id) ?? {
        name: member.display_name,
        projects: [],
        roles: [],
      };
      entry.projects.push(project.name);
      entry.roles.push(member.role);
      people.set(member.user_id, entry);
    }
  });

  const rows: ManageRow[] = [...people.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([userId, person]) => {
      const highest = highestRole(person.roles);
      return {
        id: userId,
        cells: {
          person: <span data-testid={`person-name-${userId}`}>{person.name}</span>,
          projects: person.projects.join(", "),
          role: (
            <span className="font-mono text-[12px]" title={roleBreakdown(person)}>
              {highest}
            </span>
          ),
        },
      };
    });

  if (loading && rows.length === 0) return <Spinner label="Loading members" />;

  return (
    <div className="flex flex-col gap-[10px]">
      {unread.length > 0 ? (
        <p className="text-[12.5px] text-st-failed-tag-fg" role="alert" data-testid="people-unread">
          <span aria-hidden="true">× </span>
          {unread.length} project{unread.length === 1 ? "" : "s"} could not be read
        </p>
      ) : null}
      <ManageTable
        columns={COLUMNS}
        rows={rows}
        empty="No members yet — open a project to add one."
        testid="manage-people-table"
      />
    </div>
  );
}

function highestRole(roles: readonly MemberRole[]): MemberRole {
  let best = roles[0] ?? "viewer";
  for (const role of roles) {
    if (RANK.indexOf(role) < RANK.indexOf(best)) best = role;
  }
  return best;
}

/** `Widgets: maintainer · Storefront: viewer` — the per-project roles a merged
 * row would otherwise hide. */
function roleBreakdown(person: { projects: string[]; roles: MemberRole[] }): string {
  return person.projects.map((name, index) => `${name}: ${person.roles[index]}`).join(" · ");
}
