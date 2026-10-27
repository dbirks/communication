/**
 * The project's members list and its add-or-update form, moved out of the
 * overview (Projects Review design 1b: "Members → Settings").
 *
 * The panel itself is unchanged — same rows, same `PUT` that is both add and
 * role change, same role table — only its place on the screen is new. It lives
 * in `components/project/` so the Settings page can mount it directly when that
 * screen takes it (see the brief's "keep them reachable, not deleted"); until
 * then `pages/…` mounts it through `ProjectMembersPage`.
 */
import { useState, type FormEvent } from "react";
import { useMembers, usePutMember, useUsers } from "../../api/queries";
import type { MemberRole, Project } from "../../api/types";
import { Button } from "../ds/Button";
import { Field, Select } from "../ds/Field";
import { Panel } from "../ds/Panel";
import { Row } from "../ds/Row";
import { FormError, ProblemBanner, Spinner } from "../Feedback";

const MEMBER_ROLES: readonly MemberRole[] = ["maintainer", "contributor", "viewer"];

export interface MembersPanelProps {
  project: Project;
}

export function MembersPanel({ project }: MembersPanelProps) {
  const members = useMembers(project.id);
  const users = useUsers();
  const put = usePutMember(project.id);
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<MemberRole>("contributor");
  const isMaintainer = project.my_role === "maintainer";
  const items = members.data?.items ?? [];
  // A project with no member has nothing to show, so the form is simply open —
  // the first person added is the one moment adding one is the whole point.
  const showForm = isMaintainer && (adding || items.length === 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!userId) return;
    put.mutate({ userId, role }, { onSuccess: () => setAdding(false) });
  };

  return (
    <Panel
      id="members"
      title="MEMBERS"
      headingId="members-heading"
      headingLevel={2}
      meta={
        isMaintainer ? (
          <Button
            variant="secondary"
            compact
            aria-expanded={showForm}
            aria-controls="add-member-form"
            data-testid="member-add-toggle"
            onClick={() => setAdding((current) => !current)}
          >
            {showForm ? "Close" : "Add member"}
          </Button>
        ) : members.data ? (
          `${items.length} total`
        ) : undefined
      }
    >
      <div className="space-y-3 p-[10px]">
        {members.isPending ? <Spinner label="Loading members" /> : null}
        {members.error ? (
          <ProblemBanner error={members.error} fallback="Members could not be loaded." />
        ) : null}
        {members.data ? (
          items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="member-list-empty">
              No members yet.
            </p>
          ) : (
            <ul className="space-y-[4px]" data-testid="member-list">
              {items.map((member) => (
                <li key={member.user_id} data-testid={`member-row-${member.display_name}`}>
                  <Row>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                      {member.display_name}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted">role: {member.role}</span>
                  </Row>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {!isMaintainer ? (
          <p className="text-[12.5px] text-muted">Only project maintainers can change members.</p>
        ) : null}

        {showForm ? (
          <form
            id="add-member-form"
            onSubmit={onSubmit}
            aria-labelledby="add-member-heading"
            className="space-y-3"
          >
            <h3
              id="add-member-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Add or update a member
            </h3>
            <div className="grid gap-3">
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
        ) : null}
      </div>
    </Panel>
  );
}
