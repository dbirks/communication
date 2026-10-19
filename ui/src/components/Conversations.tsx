import { useState } from "react";
import { useAgentProfiles, useConversations } from "../api/queries";
import type { ConversationSummary, Project } from "../api/types";
import { ProblemBanner, Spinner } from "./Feedback";
import NewConversationDialog from "./NewConversationDialog";
import { Button } from "./ds/Button";
import { Panel } from "./ds/Panel";
import { Row, StatusChip } from "./ds/Row";
import { CONVERSATION_STATE, stateOf } from "./ds/states";
import { shortId } from "../lib/format";

/**
 * Stable hook for the browser proof: `conversation-row-<title-slug>` mirrors how
 * repository rows are keyed, and falls back to the id when a title has no
 * word characters at all.
 */
export function titleSlug(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || shortId(id);
}

function controllerName(conversation: ConversationSummary): string {
  if (conversation.control.kind === "none") return "nobody";
  if (conversation.control.kind === "run_attempt") return "a pipeline run";
  return conversation.control.display_name ?? "a member";
}

export interface ConversationsProps {
  project: Project;
}

/**
 * A project's conversations (J2: "three conversations" in one glance). Each row
 * says who is driving, because ownership is the thing a supervising team reads.
 */
export default function Conversations({ project }: ConversationsProps) {
  const conversations = useConversations(project.id);
  const profiles = useAgentProfiles();
  const [dialogOpen, setDialogOpen] = useState(false);
  const canStart = project.my_role === "maintainer" || project.my_role === "contributor";

  const profileName = (conversation: ConversationSummary) => {
    // The list row carries only `agent_profile_id`; the name comes from the
    // profile directory this section already reads for the form.
    const profile = profiles.data?.items.find(
      (candidate) => candidate.id === conversation.agent_profile_id,
    );
    return profile ? profile.name : conversation.agent_profile_id;
  };

  return (
    <Panel
      id="conversations"
      title="CONVERSATIONS"
      headingId="conversations-heading"
      headingLevel={2}
      meta={conversations.data ? `${conversations.data.items.length} total` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {conversations.isPending ? <Spinner label="Loading conversations" /> : null}
        {conversations.error ? (
          <ProblemBanner
            error={conversations.error}
            fallback="Conversations could not be loaded."
          />
        ) : null}
        {conversations.data ? (
          conversations.data.items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="conversation-list-empty">
              No conversations yet.
            </p>
          ) : (
            <ul className="space-y-[4px]" data-testid="conversation-list">
              {conversations.data.items.map((conversation) => (
                <li key={conversation.id}>
                  <Row
                    to={`/projects/${project.id}/conversations/${conversation.id}`}
                    data-testid={`conversation-row-${titleSlug(conversation.title, conversation.id)}`}
                  >
                    <StatusChip
                      state={stateOf(CONVERSATION_STATE[conversation.status])}
                      label={conversation.status}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold">
                        {conversation.title}
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-muted">
                        profile: {profileName(conversation)} · controller:{" "}
                        {controllerName(conversation)} · updated: {conversation.updated_at}
                      </span>
                    </span>
                    {conversation.has_active_turn ? (
                      <StatusChip state="running" label="turn open" />
                    ) : null}
                  </Row>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {canStart ? (
          <Button
            variant="secondary"
            data-testid="conversations-new-open"
            onClick={() => setDialogOpen(true)}
          >
            New conversation
          </Button>
        ) : (
          <p className="text-[12.5px] text-muted">
            Only project contributors and maintainers can start conversations.
          </p>
        )}
        <NewConversationDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          projectId={project.id}
          project={project}
        />
      </div>
    </Panel>
  );
}
