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
 * - LINKED CHATS — ADR-0072's agent-mail links (`links`, either direction),
 *   one bordered row per link: the repo, the question, and the state as a
 *   glyph-and-word pair (never colour alone, per states.ts); the row links
 *   into the linked chat. Asked agents are read-only until a person
 *   approves an edit, and the section says so.
 * - ASSISTANT — the note slot at the bottom, rendered only from a real
 *   source (`assistantNote`), plus the standing thread → workflow note
 *   (design 2f): whenever the host names this thread's chat
 *   (`workflowChat`), `Make a workflow…` sits at the bottom of the
 *   ASSISTANT section IN ADDITION TO the notes — up to the store's cap —
 *   so the 2f journey is reachable however many notes arrive. It is not
 *   duplicated when one of the rendered notes already offers a
 *   `make_workflow` action: AssistantNote stamps every action button with
 *   `data-action-kind`, and the panel reads that marker back off the slot.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ReactNode } from "react";
import { routes } from "../../lib/routes";
import { STATES, type StateName } from "../ds/states";
import { AssistantNote, MAKE_WORKFLOW_ACTION_ID, makeWorkflowNoteAction } from "./AssistantNote";
import { openAssistantWorkflowDraft } from "../assistant/AssistantPopover";
import { agentLabel } from "./ConversationTranscript";
import type { components } from "../../api/schema";

export type ConversationChatAgent = components["schemas"]["ConversationChatAgent"];
export type ConversationLink = components["schemas"]["ConversationLink"];

/** The link's state as the design spells it, paired with a states.ts glyph
 * (glyph + word, never colour alone). An expired ask is the honest "we
 * stopped waiting", not a failure, so it takes the interrupted glyph. */
export function mailLinkState(state: string): { name: StateName; word: string } {
  switch (state) {
    case "answered":
      return { name: "done", word: "answered" };
    case "failed":
      return { name: "failed", word: "failed" };
    case "expired":
      return { name: "interrupted", word: "expired" };
    default:
      return { name: "running", word: "asked" };
  }
}

/** `turns 1–2`, or `turn 3` for a single-turn run. */
export function turnRangeCopy(first: number, last: number): string {
  return first === last ? `turn ${first}` : `turns ${first}\u2013${last}`;
}

export interface ConversationSidePanelProps {
  projectId: string;
  /** The resolved repository name, or null when no read names one. */
  repoName?: string | null;
  /**
   * The workspace's own state beside the repository name (the WORKS-IN
   * contradiction, error-details-r6): a thread created in a repository IS
   * attached to it (ADR-0067), and the checkout is a second fact — so when
   * the header says `web · workspace not prepared`, this rail says the same
   * words rather than letting one screen deny the other. Null = nothing to
   * say (a live checkout, or no repository named).
   */
  worksInNote?: string | null;
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
  /** ADR-0072's mail links (`linked_chats`); empty or absent hides the
   * section. The host reads them off the conversation detail. */
  links?: ConversationLink[] | null;
  /** The assistant note slot; a host with no real source passes nothing. */
  assistantNote?: ReactNode;
  /**
   * The thread's own chat for the standing thread → workflow note (design
   * 2f): present → the ASSISTANT section always offers `Make a workflow…`
   * at its bottom, shown in addition to the notes — and not duplicated
   * when one of them already offers that action itself.
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

/** The standing note's testid — also the id the 2f journey clicks
 * (`assistant-note-workflow-action-make_workflow`). */
const WORKFLOW_NOTE_TEST_ID = "assistant-note-workflow";

export function ConversationSidePanel({
  projectId,
  repoName,
  worksInNote,
  branch,
  filesChanged,
  pullRequest,
  agents,
  skills,
  links,
  assistantNote,
  workflowChat,
  onMakeWorkflow,
}: ConversationSidePanelProps) {
  const agentRows = agents ?? [];
  const skillList = (skills ?? []).filter((skill) => skill.trim() !== "");
  const linkRows = links ?? [];
  const workflowNote = workflowChat ? (
    <AssistantNote
      testId={WORKFLOW_NOTE_TEST_ID}
      text={`Turn “${workflowChat.title || "this chat"}” into a repeatable workflow — the assistant drafts the steps and asks what it must decide.`}
      actions={[
        makeWorkflowNoteAction(() =>
          onMakeWorkflow ? onMakeWorkflow(workflowChat) : openAssistantWorkflowDraft(workflowChat),
        ),
      ]}
    />
  ) : null;
  // The 2f entry must always be reachable, so the standing note rides below
  // the store's notes instead of trading places with them. The one thing it
  // must not become is a second `Make a workflow…` button: a note that
  // already offers that action (the generator's own `make_workflow` note)
  // replaces the standing one. AssistantNote stamps `data-action-kind` on
  // every action button, so the panel sees what its slot actually renders
  // without the host having to describe its notes to it.
  const slotBoxRef = useRef<HTMLDivElement | null>(null);
  const [noteOffersMakeWorkflow, setNoteOffersMakeWorkflow] = useState(false);
  // Layout effect, not passive: the decision is taken before the browser
  // paints, so a duplicated standing button is never flashed.
  useLayoutEffect(() => {
    const standingTestId = `${WORKFLOW_NOTE_TEST_ID}-action-${MAKE_WORKFLOW_ACTION_ID}`;
    let found = false;
    for (const el of slotBoxRef.current?.querySelectorAll<HTMLElement>(
      `[data-action-kind="${MAKE_WORKFLOW_ACTION_ID}"]`,
    ) ?? []) {
      if (el.getAttribute("data-testid") !== standingTestId) {
        found = true;
        break;
      }
    }
    setNoteOffersMakeWorkflow(found);
  }, [assistantNote, workflowChat]);
  const slot =
    assistantNote || (workflowChat && !noteOffersMakeWorkflow) ? (
      <>
        {assistantNote}
        {workflowChat && !noteOffersMakeWorkflow ? workflowNote : null}
      </>
    ) : null;
  const hasContent =
    Boolean(repoName) ||
    Boolean(branch) ||
    agentRows.length > 0 ||
    skillList.length > 0 ||
    linkRows.length > 0 ||
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
            {/* The workspace state rides the same line: one section, one
                sentence, the same words the header's meta line prints. */}
            {worksInNote ? (
              <span className="text-muted" data-testid="side-panel-works-in-state">
                {" · "}
                {worksInNote}
              </span>
            ) : null}
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
      {linkRows.length > 0 ? (
        <section aria-labelledby="side-panel-links-heading" data-testid="side-panel-links">
          <SectionTitle htmlFor="side-panel-links-heading">Linked chats</SectionTitle>
          <ul className="mt-1 space-y-1">
            {linkRows.map((link, index) => {
              const state = mailLinkState(link.state);
              const spec = STATES[state.name];
              return (
                <li
                  key={link.id}
                  className="min-w-0 space-y-[2px] rounded-[3px] border border-line-strong bg-surface p-2"
                  data-testid={`side-panel-link-row-${index}`}
                >
                  <Link
                    to={routes.thread(link.other_conversation.id)}
                    className="block min-w-0 break-words font-mono text-[11px] font-semibold text-accent-text hover:text-ink"
                    data-testid={`side-panel-link-chat-${index}`}
                  >
                    {link.repo_name}
                  </Link>
                  <p className="min-w-0 break-words text-[11.5px] text-ink-2">{link.question}</p>
                  <p
                    className={`font-mono text-[10.5px] ${spec.tagFg}`}
                    data-testid={`side-panel-link-state-${index}`}
                  >
                    <span aria-hidden="true">{spec.glyph} </span>
                    {state.word}
                    {link.direction === "outgoing" ? " \u00b7 read-only" : " \u00b7 asked here"}
                  </p>
                </li>
              );
            })}
          </ul>
          <p
            className="mt-1 text-[11px] leading-[1.5] text-faint"
            data-testid="side-panel-links-note"
          >
            Asked agents run read-only by default. Letting one edit its repo needs a person to
            approve.
          </p>
        </section>
      ) : null}
      {slot ? (
        <div data-testid="side-panel-assistant-slot" ref={slotBoxRef}>
          {slot}
        </div>
      ) : null}
    </div>
  );
}
