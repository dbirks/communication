import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAgentProfiles, useConversations, useCreateConversation } from "../api/queries";
import type { ConversationSummary, Project } from "../api/types";
import { FormError, ProblemBanner, Spinner } from "./Feedback";
import { Button } from "./ds/Button";
import { Field, Input, Select, Textarea } from "./ds/Field";
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
  const create = useCreateConversation(project.id);
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const canStart = project.my_role === "maintainer" || project.my_role === "contributor";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !profileId) return;
    create.mutate(
      {
        agent_profile_id: profileId,
        title: trimmedTitle,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      },
      {
        onSuccess: (conversation) => {
          setTitle("");
          setPrompt("");
          navigate(`/projects/${project.id}/conversations/${conversation.id}`);
        },
      },
    );
  };

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
          <form
            onSubmit={onSubmit}
            aria-labelledby="new-conversation-heading"
            className="space-y-3"
          >
            <h3
              id="new-conversation-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              New conversation
            </h3>
            <Field id="conversation-title" label="Title">
              <Input
                id="conversation-title"
                data-testid="conversation-new-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            </Field>
            <Field
              id="conversation-profile"
              label="Agent profile"
              hint={
                <>
                  {profiles.isPending ? <Spinner label="Loading agent profiles" /> : null}
                  {profiles.error ? (
                    <ProblemBanner
                      error={profiles.error}
                      fallback="Agent profiles could not be loaded."
                    />
                  ) : null}
                </>
              }
            >
              <Select
                id="conversation-profile"
                data-testid="conversation-new-profile"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
                required
              >
                <option value="">Select a profile…</option>
                {profiles.data
                  ? profiles.data.items.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} ({profile.launcher_id}, {profile.permission_mode})
                      </option>
                    ))
                  : null}
              </Select>
            </Field>
            <Field id="conversation-prompt" label="First prompt (optional)">
              <Textarea
                id="conversation-prompt"
                data-testid="conversation-new-prompt"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Read the repo and propose a plan."
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              data-testid="conversation-new-submit"
              disabled={create.isPending || !title.trim() || !profileId}
            >
              {create.isPending ? "Starting…" : "Start conversation"}
            </Button>
            <FormError error={create.error} />
          </form>
        ) : (
          <p className="text-[12.5px] text-muted">
            Only project contributors and maintainers can start conversations.
          </p>
        )}
      </div>
    </Panel>
  );
}
