import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAgentProfiles, useConversations, useCreateConversation } from "../api/queries";
import type { ConversationSummary, Project } from "../api/types";
import { FormError, ProblemBanner, Spinner, fieldClass, labelClass, submitClass } from "./Feedback";

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
  return slug || id.slice(0, 8);
}

function controllerName(conversation: ConversationSummary): string {
  if (conversation.control.kind === "none") return "nobody";
  if (conversation.control.kind === "run_attempt") return "a pipeline run";
  return conversation.control.display_name ?? "a member";
}

const linkClass =
  "block rounded border border-gray-200 px-3 py-2 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

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
    <section aria-labelledby="conversations-heading" className="space-y-3">
      <h2 id="conversations-heading" className="text-lg font-semibold">
        Conversations
      </h2>

      {conversations.isPending ? <Spinner label="Loading conversations" /> : null}
      {conversations.error ? (
        <ProblemBanner error={conversations.error} fallback="Conversations could not be loaded." />
      ) : null}
      {conversations.data ? (
        conversations.data.items.length === 0 ? (
          <p className="text-sm text-gray-600" data-testid="conversation-list-empty">
            No conversations yet.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="conversation-list">
            {conversations.data.items.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  to={`/projects/${project.id}/conversations/${conversation.id}`}
                  className={linkClass}
                  data-testid={`conversation-row-${titleSlug(conversation.title, conversation.id)}`}
                >
                  <span className="font-medium">{conversation.title}</span>
                  <span className="ml-2 text-sm text-gray-600">
                    profile: {profileName(conversation)}
                  </span>
                  <span className="ml-2 text-sm text-gray-600">status: {conversation.status}</span>
                  <span className="ml-2 text-sm text-gray-600">
                    controller: {controllerName(conversation)}
                  </span>
                  <span className="ml-2 text-sm text-gray-600">
                    updated: {conversation.updated_at}
                  </span>
                  {conversation.has_active_turn ? (
                    <span className="ml-2 text-sm text-gray-600">turn open</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {canStart ? (
        <form onSubmit={onSubmit} aria-labelledby="new-conversation-heading" className="space-y-3">
          <h3 id="new-conversation-heading" className="text-base font-semibold">
            New conversation
          </h3>
          <div>
            <label className={labelClass} htmlFor="conversation-title">
              Title
            </label>
            <input
              id="conversation-title"
              className={fieldClass}
              data-testid="conversation-new-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="conversation-profile">
              Agent profile
            </label>
            {profiles.isPending ? <Spinner label="Loading agent profiles" /> : null}
            {profiles.error ? (
              <ProblemBanner
                error={profiles.error}
                fallback="Agent profiles could not be loaded."
              />
            ) : null}
            <select
              id="conversation-profile"
              className={fieldClass}
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
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="conversation-prompt">
              First prompt (optional)
            </label>
            <textarea
              id="conversation-prompt"
              className={fieldClass}
              data-testid="conversation-new-prompt"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Read the repo and propose a plan."
            />
          </div>
          <button
            type="submit"
            className={submitClass}
            data-testid="conversation-new-submit"
            disabled={create.isPending || !title.trim() || !profileId}
          >
            {create.isPending ? "Starting…" : "Start conversation"}
          </button>
          <FormError error={create.error} />
        </form>
      ) : (
        <p className="text-sm text-gray-600">
          Only project contributors and maintainers can start conversations.
        </p>
      )}
    </section>
  );
}
