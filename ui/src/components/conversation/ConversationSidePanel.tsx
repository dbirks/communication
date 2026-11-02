/**
 * The chat's context rail (design 2e: 280px, white, left border — the
 * border and the width belong to the host, this is the content).
 *
 * Every section prints from server facts and nothing else; a section with no
 * data is absent, never an empty box or a placeholder row:
 *
 * - WORKS IN — the repository the thread works in (ADR-0067's resolution:
 *   the declared binding, else the workspace, else the linked run — the host
 *   resolves it and hands the name down). Read-only: `conversations.
 *   repository_id` is written once and never moved by any API path, so there
 *   is no control here to switch it.
 * - BRANCH — the conversation workspace's run ref, plus the count of
 *   modified paths the workspace manifest records. A PR link has no
 *   structured source today (the draft-PR ask is the rail's prompt flow, and
 *   the only PR proof is a URL in the transcript), so none is rendered.
 * - AGENTS IN THIS CHAT — ADR-0068's derived `agents` list, one row per
 *   maximal run of consecutive turns on one profile, with its 1-based turn
 *   range ("Claude Code · opus turns 1–2"); a profile switched away from and
 *   back appears twice, because the ranges describe the transcript.
 * - Skills used — the wire carries no per-conversation skill list today; the
 *   section renders only what a host hands it.
 * - LINKED CHATS — omitted until agent mail (3d).
 * - ASSISTANT — the note slot at the bottom, rendered only from a real
 *   source (`assistantNote`), plus the thread → workflow note (design 2f)
 *   when the host names this thread's chat (`workflowChat`): `Make a
 *   workflow…` opens the assistant panel with the chat as context.
 */
import { Link } from "react-router";
import type { ReactNode } from "react";
import { routes } from "../../lib/routes";
import { AssistantNote, makeWorkflowNoteAction } from "./AssistantNote";
import { openAssistantWorkflowDraft } from "../assistant/AssistantPopover";
import { agentLabel } from "./ConversationTranscript";
import type { components } from "../../api/schema";

export type ConversationChatAgent = components["schemas"]["ConversationChatAgent"];

/** `turns 1–2`, or `turn 3` for a single-turn run. */
export function turnRangeCopy(first: number, last: number): string {
  return first === last ? `turn ${first}` : `turns ${first}\u2013${last}`;
}

export interface ConversationSidePanelProps {
  projectId: string;
  /** The resolved repository name, or null when no read names one. */
  repoName?: string | null;
  /** The workspace's run ref for this thread, or null before one exists. */
  branch?: string | null;
  /** Files the workspace manifest records as modified; null when the read
   * does not answer it (an older replica, no workspace). */
  filesChanged?: number | null;
  /** A PR with a structured link, if the host has one. None exists today. */
  pullRequest?: { label: string; href?: string } | null;
  /** ADR-0068's derived agents list; empty or absent hides the section. */
  agents?: ConversationChatAgent[] | null;
  /** Skills the thread used — only if some read says so (none does today). */
  skills?: string[] | null;
  /** The assistant note slot; a host with no real source passes nothing. */
  assistantNote?: ReactNode;
  /**
   * The thread's own chat for the thread → workflow note (design 2f):
   * present → the ASSISTANT slot offers `Make a workflow…`. A host that
   * also passes `assistantNote` keeps its own note in the slot; the
   * workflow action rides on it as an extra action instead.
   */
  workflowChat?: { id: string; title?: string | null } | null;
  /**
   * Override for the note's click-through (tests, or a host with its own
   * assistant surface). Defaults to opening the assistant popover with
   * the chat as context.
   */
  onMakeWorkflow?: (chat: { id: string; title?: string | null }) => void;
}

function SectionTitle({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <h2
      id={htmlFor}
      className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted"
    >
      {children}
    </h2>
  );
}

export function ConversationSidePanel({
  projectId,
  repoName,
  branch,
  filesChanged,
  pullRequest,
  agents,
  skills,
  assistantNote,
  workflowChat,
  onMakeWorkflow,
}: ConversationSidePanelProps) {
  const agentRows = agents ?? [];
  const skillList = (skills ?? []).filter((skill) => skill.trim() !== "");
  const workflowNote = workflowChat ? (
    <AssistantNote
      testId="assistant-note-workflow"
      text={`Turn “${workflowChat.title || "this chat"}” into a repeatable workflow — the assistant drafts the steps and asks what it must decide.`}
      actions={[
        makeWorkflowNoteAction(() =>
          onMakeWorkflow ? onMakeWorkflow(workflowChat) : openAssistantWorkflowDraft(workflowChat),
        ),
      ]}
    />
  ) : null;
  const slot = assistantNote ? (
    <>
      {assistantNote}
      {workflowChat
        ? null // one note per slot today: the host's note keeps its surface
        : workflowNote}
    </>
  ) : (
    workflowNote
  );
  const hasContent =
    Boolean(repoName) ||
    Boolean(branch) ||
    agentRows.length > 0 ||
    skillList.length > 0 ||
    Boolean(slot);
  if (!hasContent) return null;

  return (
    <div data-testid="conversation-side-panel" className="min-w-0 space-y-4 p-3">
      {repoName ? (
        <section aria-labelledby="side-panel-works-in-heading" data-testid="side-panel-works-in">
          <SectionTitle htmlFor="side-panel-works-in-heading">Works in</SectionTitle>
          <p className="mt-1 min-w-0 break-words font-mono text-[12px] text-ink">
            <Link
              to={routes.repository(projectId, repoName)}
              className="text-accent-text hover:text-ink"
              data-testid="side-panel-repo-link"
            >
              {repoName}
            </Link>
          </p>
          <p
            className="mt-1 text-[11.5px] leading-[1.5] text-faint"
            data-testid="side-panel-works-in-note"
          >
            Read-only — a thread's repository is recorded when it opens and never moves.
          </p>
        </section>
      ) : null}
      {branch ? (
        <section aria-labelledby="side-panel-branch-heading" data-testid="side-panel-branch">
          <SectionTitle htmlFor="side-panel-branch-heading">Branch</SectionTitle>
          <p className="mt-1 min-w-0 break-words font-mono text-[12px] text-ink">{branch}</p>
          {filesChanged != null || pullRequest ? (
            <p
              className="mt-1 font-mono text-[11px] text-muted"
              data-testid="side-panel-branch-meta"
            >
              {filesChanged != null ? (
                <span data-testid="side-panel-files-changed">
                  {filesChanged} {filesChanged === 1 ? "file" : "files"} changed
                </span>
              ) : null}
              {filesChanged != null && pullRequest ? " · " : null}
              {pullRequest ? (
                pullRequest.href ? (
                  <Link
                    to={pullRequest.href}
                    className="text-accent-text hover:text-ink"
                    data-testid="side-panel-pr-link"
                  >
                    {pullRequest.label}
                  </Link>
                ) : (
                  <span data-testid="side-panel-pr-label">{pullRequest.label}</span>
                )
              ) : null}
            </p>
          ) : null}
        </section>
      ) : null}
      {agentRows.length > 0 ? (
        <section aria-labelledby="side-panel-agents-heading" data-testid="side-panel-agents">
          <SectionTitle htmlFor="side-panel-agents-heading">Agents in this chat</SectionTitle>
          <ul className="mt-1 space-y-1">
            {agentRows.map((agent, index) => (
              <li
                key={`${agent.agent_profile_id}-${agent.first_turn}`}
                className="flex min-w-0 flex-wrap items-baseline gap-x-[6px] font-mono text-[11.5px]"
                data-testid={`side-panel-agent-row-${index}`}
              >
                <span className="min-w-0 break-words text-ink">
                  {agentLabel(agent.agent_profile_name, agent.model)}
                </span>
                <span className="text-faint" data-testid={`side-panel-agent-range-${index}`}>
                  {turnRangeCopy(agent.first_turn, agent.last_turn)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {skillList.length > 0 ? (
        <section aria-labelledby="side-panel-skills-heading" data-testid="side-panel-skills">
          <SectionTitle htmlFor="side-panel-skills-heading">Skills used</SectionTitle>
          <ul className="mt-1 space-y-[2px]">
            {skillList.map((skill) => (
              <li
                key={skill}
                className="font-mono text-[11.5px] text-ink"
                data-testid="side-panel-skill"
              >
                {skill}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {slot ? <div data-testid="side-panel-assistant-slot">{slot}</div> : null}
    </div>
  );
}
