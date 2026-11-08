/**
 * The chat's context rail (design 2e: 280px, white, left border — the
 * border and the width belong to the host, this is the content).
 *
 * Every section prints from server facts and nothing else; a section with no
 * data is absent, never an empty box or a placeholder row:
 *
 * - WORKS IN — the repository the thread works in (ADR-0067: the declared
 *   binding, and the trigger's word is that binding's word — a moved
 *   thread says "Whole project" even while its workspace still checked
 *   out a repository, because the workspace is what the agent sees, not
 *   the chat's scope; the host resolves the name for bound threads and
 *   hands it down). A switcher since the ADR-0067 amendment: the host's chat id (the `workflowChat` prop) opens the ds
 *   Menu — the project's repositories plus "Whole project", the declared
 *   binding ticked — and its pick is `PATCH /api/v1/conversations/{id}`.
 *   The transcript renders the move as its own system line (the journal's
 *   `conversation.scope_changed` row), and the new scope answers from the
 *   next turn, which the section's one muted line says. A host with no chat
 *   id renders the read-only sentence instead: with nothing to patch, the
 *   rail says so rather than offering a control that cannot act.
 * - BRANCH — the conversation workspace's run ref, plus the count of
 *   modified paths the workspace manifest records. A PR link has no
 *   structured source today (the draft-PR ask is the rail's prompt flow, and
 *   the only PR proof is a URL in the transcript), so none is rendered.
 * - AGENTS IN THIS CHAT — ADR-0068's derived `agents` list, one row per
 *   maximal run of consecutive turns on one profile, with its 1-based turn
 *   range ("Claude Code · opus turns 1–2"); a profile switched away from and
 *   back appears twice, because the ranges describe the transcript. A run whose
 *   turns the journal records as failed wears the failed state too ("Codex
 *   turn 2 · failed") — see `agentRunStateCopy`.
 *   Design 3d (round-19): an agent this chat ASKED through agent mail is a
 *   participant too, and gets its own row — its label, its repo, and how often
 *   it was asked ("Codex · gpt-5 api, asked once"). The rows come from the
 *   SAME `links` read LINKED CHATS uses (the outgoing direction), grouped by
 *   repo + launcher (ADR-0072 § 10: a mailed chat runs on one named launcher);
 *   the label is resolved through the app's one launcher-naming resolver and
 *   falls back to the launcher id the wire carries — never an invented model.
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
 *   The section carries the ONE `Assistant` heading (review 2e: two notes
 *   printed two headings and the first note's `dismiss` butted against the
 *   second); the notes inside are grouped, so they are rows of one section
 *   with room between them.
 * - The 2f entry is HONEST about the caller's own right (rcn-review11-2f):
 *   saving a library draft needs the library role (spec 01: a project
 *   maintainer may publish a shared pipeline "only with library role"),
 *   read the same way as every other library surface — `me.is_org_admin`
 *   through `hasLibraryRole`. A caller without it still sees the note (the
 *   suggestion stands), but the `Make a workflow…` action is disabled with
 *   the reason in its tooltip, so the entry never promises a library draft
 *   the caller cannot create.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ReactNode } from "react";
import { routes } from "../../lib/routes";
import { Menu, type MenuEntry } from "../ds/Menu";
import { STATES, type StateName } from "../ds/states";
import {
  AssistantNote,
  AssistantNoteGroup,
  MAKE_WORKFLOW_ACTION_ID,
  makeWorkflowNoteAction,
  makeWorkflowNoteActionDisabled,
} from "./AssistantNote";
import { openAssistantWorkflowDraft } from "../assistant/AssistantPopover";
import { useChangeConversationScope } from "../../api/conversations";
import { useAgentProfiles, useConversation, useMe, useRepositories } from "../../api/queries";
import { hasLibraryRole, LIBRARY_ROLE_LABEL } from "../../lib/pipeline/authoring";
import { agentLabel } from "./ConversationTranscript";
import { agentDisplayForLauncher, type LauncherNameSource } from "./agentNames";
import { NO_BRANCH_YET } from "./threadBranch";
import type { TurnRecord } from "../../api/transcript";
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

/**
 * One AGENTS row for an agent this chat ASKED through agent mail (design 3d,
 * round-19): the asked agent is a participant of the conversation even though
 * no turn of THIS chat's transcript ran on its profile — its answer arrived
 * from its own chat. The row is derived from the conversation's own
 * `linked_chats` (ADR-0072), outgoing direction only ("this chat asked"),
 * grouped by repo + launcher so repeated asks of the same repo's agent count
 * into one row ("asked 3 times") instead of stacking look-alike rows.
 */
export interface AskedAgentRow {
  key: string;
  repo: string;
  launcherId: string;
  asks: number;
}

/** The outgoing mail links folded into one row per asked agent, in first-ask
 * order. An absent/blank launcher names nothing — the row still prints the
 * repo, which the wire always carries. */
export function askedAgentRows(links: readonly ConversationLink[]): AskedAgentRow[] {
  const rows: AskedAgentRow[] = [];
  const byKey = new Map<string, AskedAgentRow>();
  for (const link of links) {
    if (link.direction !== "outgoing") continue;
    const launcherId = link.launcher_id ?? "";
    const key = `${link.repo_name}\u0000${launcherId}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.asks += 1;
      continue;
    }
    const row: AskedAgentRow = { key, repo: link.repo_name, launcherId, asks: 1 };
    byKey.set(key, row);
    rows.push(row);
  }
  return rows;
}

/** `asked once`, or `asked N times`. One ask is the design's word; a count is
 * a count — no "several" softening. */
export function askedCountCopy(asks: number): string {
  return asks === 1 ? "asked once" : `asked ${asks} times`;
}

/**
 * The asked agent's label, in the words the reads actually carry: the
 * profile display name (and its pinned model, when the profile names one)
 * through the app's one launcher resolver — the same rule the mail cards
 * keep (ADR-0072 § 10: a mailed chat inherits the asking chat's current
 * profile, so the conversation read answers for it; otherwise exactly one
 * profile row must name the launcher). Nothing names a model on the mail
 * link itself, so with no read naming the launcher the row prints the
 * launcher id verbatim — the machine's word, honestly labelled — and never
 * a guessed product or model name.
 */
export function askedAgentLabel(row: AskedAgentRow, source: LauncherNameSource): string {
  const display = agentDisplayForLauncher(row.launcherId, source);
  if (display) return agentLabel(display.name, display.model);
  return row.launcherId;
}

/**
 * The state of one agent run, in words, or null when there is nothing to say.
 *
 * A run is a range of turns (`first_turn`…`last_turn`, the 1-based creation
 * order the server derives ADR-0068's `agents` list from) and `turns` is the
 * journal's own turn list in that same order — the fold builds it in journal
 * order, and at most one turn per conversation is ever open (ADR-0016), so the
 * two orders are the same order and ordinal `n` is `turns[n-1]`.
 *
 * The rail used to print `Codex turn 2` over a turn the journal says failed:
 * the range read like work that happened. So the turn rows answer, and only
 * for the turns this read actually reaches — a range beyond the transcript the
 * surface holds prints no state rather than borrowing a neighbour's (an absent
 * fact is not a claim). A run with no failed turn says nothing: silence is the
 * honest default, and "completed" would be a guess about cancelled,
 * interrupted and still-open turns.
 */
export function agentRunStateCopy(
  run: { first_turn: number; last_turn: number },
  turns: readonly TurnRecord[],
): string | null {
  if (run.last_turn > turns.length) return null;
  let failed = 0;
  for (let ordinal = run.first_turn; ordinal <= run.last_turn; ordinal += 1) {
    if (turns[ordinal - 1]?.status === "failed") failed += 1;
  }
  if (failed === 0) return null;
  // One failure in a one-turn run is that run's own state; inside a longer run
  // the count is the honest word — the range did not all fail.
  if (failed === 1 && run.first_turn === run.last_turn) return STATES.failed.word;
  return `${failed} ${STATES.failed.word}`;
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
  /** The thread's own branch name, or `NO_BRANCH_YET` while its workspace has
   * no human branch (rcn-2e review defect 2: the raw `<scope-id>/<repo>` run
   * ref used to print here, in a thread that worked in another repo).
   * `null`/undefined = the host holds no workspace for this thread → the
   * section is absent (an absent fact is not a "no branch yet" claim). */
  branch?: string | null;
  /** Files the workspace manifest records as modified; null when the read
   * does not answer it (an older replica, no workspace). */
  filesChanged?: number | null;
  /** A PR with a structured link, if the host has one. None exists today. */
  pullRequest?: { label: string; href?: string } | null;
  /** ADR-0068's derived agents list; empty or absent hides the section. */
  agents?: ConversationChatAgent[] | null;
  /**
   * The journal's turn rows — `transcript.turns` on the chat page. The only
   * thing that says whether a turn in an agent's range finished or failed
   * (`agentRunStateCopy`); absent = the surface holds no turn rows, so each
   * range prints on its own and nothing is claimed about its state.
   */
  turns?: readonly TurnRecord[] | null;
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
   * The host's dismissal of the standing thread → workflow note (design 2e
   * prints `Make a workflow… dismiss` beside it, rcn-chat-rail-390): the
   * standing note is the panel's OWN — not a row of the notes store (ADR-0071)
   * the server owns — so dismissing it hides it for this thread without any
   * write, the way a dismissed notes-store row would disappear. Omit (or
   * false) for hosts where the standing note cannot be dismissed.
   */
  workflowNoteDismissed?: boolean;
  /** Present a dismiss affordance only when dismissing is real behaviour —
   * the same contract `AssistantNote.onDismiss` keeps for its rows. */
  onDismissWorkflowNote?: () => void;
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

/**
 * The WORKS IN switcher (ADR-0067 amendment): the project's repositories plus
 * "Whole project", the declared binding ticked, one pick = one PATCH.
 *
 * The trigger is ONE bordered select-style button wearing the scope's own
 * name and the caret ("storefront ▾", "Whole project ▾") — round-8 review
 * item 3 replaced the name-plus-label-less-▾-box pair with the single
 * control, so at a 390px rail the row reads as one select, not a stretched
 * second box. The testid and aria attributes the e2e journeys read live on
 * that one button.
 *
 * The tick reads the DECLARED binding off the conversation detail
 * (`repository_id`, this thread's own cache entry — the page's read is
 * shared, so no second request) rather than the displayed name: the name is
 * the three-arm derivation, and a thread whose WORKSPACE says `server` is
 * still "whole project" in scope until someone binds it. An in-flight pick
 * disables every row; the fresh response the mutation writes back re-ticks
 * the list without the host having to say anything.
 *
 * Under the trigger, when the project holds more than one repository and the
 * chat is bound to one of them, the quiet hint says what switching to the
 * whole project buys: the agent can read the other repos. The count is the
 * project's repositories read — the one this component already loads, so
 * the hint owes no fetch; one repo (or an unbound chat) owes no hint.
 */
export function WorksInSwitcher({
  projectId,
  conversationId,
  displayName,
  testId = "side-panel-works-in-switch",
}: {
  projectId: string;
  conversationId: string;
  /** The scope name the host already resolved (the panel's `repoName`). */
  displayName?: string | null;
  testId?: string;
}) {
  const { data: conversation } = useConversation(conversationId);
  const { data: repositories } = useRepositories(projectId);
  const change = useChangeConversationScope();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // `undefined` while the read is in flight (or on a replica predating the
  // field) — only an explicit null says the whole project.
  const declaredId = conversation?.repository_id;
  const currentId = declaredId ?? null;
  // The trigger's own word: the DECLARED binding's word (rcn-2e
  // works-in-moved, round 9). A chat whose binding is null says "Whole
  // project" even while its workspace still checked out a repository — the
  // workspace is what the agent sees, not the chat's scope — so the old
  // habit of printing the host's resolved name there (the page's workspace
  // fallback) is gone. A binding the panel's reads never name is a "…",
  // not a guess; a replica that predates `repository_id` (undefined) keeps
  // the host-resolved name, because no read says the thread is unbound.
  const boundName =
    currentId !== null
      ? (displayName ?? repositories?.items.find((repo) => repo.id === currentId)?.name)
      : undefined;
  const scopeName =
    declaredId === null
      ? "Whole project"
      : declaredId !== undefined
        ? (boundName ?? "…")
        : (displayName ?? "Whole project");
  // The other-repos hint: only a BOUND chat (the declared binding names a
  // repository) inside a multi-repo project.
  const otherRepos = (repositories?.items ?? []).length;
  const hintDue = repositories !== undefined && otherRepos > 1 && currentId !== null;
  const items: MenuEntry[] = [
    {
      id: "whole-project",
      label: "Whole project",
      checked: currentId === null,
      disabled: change.isPending,
      testId: "side-panel-scope-item-whole",
      onSelect: () => {
        change.mutate({ conversationId, repositoryId: null });
        setOpen(false);
      },
    },
    ...(repositories?.items ?? []).map((repo) => ({
      id: repo.id,
      label: repo.name,
      checked: repo.id === currentId,
      disabled: change.isPending,
      testId: `side-panel-scope-item-${repo.name}`,
      onSelect: () => {
        change.mutate({ conversationId, repositoryId: repo.id });
        setOpen(false);
      },
    })),
  ];
  return (
    <span className="relative block min-w-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch the repository this thread works in"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-[24px] w-full min-w-0 items-center gap-[6px] rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[12px] text-ink hover:border-ink"
      >
        <span className="min-w-0 truncate">{scopeName}</span>
        <span aria-hidden="true" className="shrink-0 text-[10px] text-muted">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {hintDue ? (
        <p
          className="mt-1 min-w-0 break-words text-[11px] leading-[1.5] text-faint"
          data-testid="side-panel-works-in-switch-hint"
        >
          Switch to Whole project to let the agent read the project's other repos.
        </p>
      ) : null}
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        side="bottom"
        align="end"
        width={200}
        ariaLabel="Switch the repository this thread works in"
        data-testid="side-panel-scope-menu"
        items={items}
      />
    </span>
  );
}

export function ConversationSidePanel({
  projectId,
  repoName,
  worksInNote,
  branch,
  filesChanged,
  pullRequest,
  agents,
  turns,
  skills,
  links,
  assistantNote,
  workflowChat,
  workflowNoteDismissed = false,
  onDismissWorkflowNote,
  onMakeWorkflow,
}: ConversationSidePanelProps) {
  const agentRows = agents ?? [];
  const turnRows = turns ?? [];
  const skillList = (skills ?? []).filter((skill) => skill.trim() !== "");
  const linkRows = links ?? [];
  // Design 3d (round-19): the agents this chat ASKED through agent mail are
  // participants too. The rows fold the SAME `linked_chats` the LINKED CHATS
  // section prints; the names come off the reads the page already shares —
  // the thread's own detail (ADR-0072 § 10: a mailed chat inherits this
  // chat's current profile) and the org profile list — never off a guess.
  const askedRows = askedAgentRows(linkRows);
  const { data: askedProfiles } = useAgentProfiles();
  const { data: askedConversation } = useConversation(workflowChat?.id ?? "");
  const askedNameSource: LauncherNameSource = {
    currentLauncherId: askedConversation?.launcher_id ?? null,
    currentProfileName: askedConversation?.agent_profile_name ?? null,
    currentProfileModel: askedConversation?.agent_profile_model ?? null,
    profiles: (askedProfiles?.items ?? []).map((profile) => ({
      launcherId: profile.launcher_id,
      name: profile.name,
      model: profile.model ?? null,
    })),
  };
  // The standing 2f note, and the dismiss the design prints beside its
  // `Make a workflow…` (rcn-chat-rail-390): the note is the panel's own
  // suggestion — not a notes-store row — so dismissal is the host's to hold
  // (per-conversation, in the chat page) and the panel only obeys it.
  //
  // The entry's own honesty (rcn-review11-2f): the library draft the flow
  // saves needs the library role, read the same single way as every other
  // library surface (authoring.hasLibraryRole off `me.is_org_admin`). An
  // unread identity is not a right — the action stays disabled until the
  // read says otherwise, the same rule the authoring surfaces keep.
  const { data: me } = useMe();
  const canSaveToLibrary = hasLibraryRole(me);
  const standingNoteShown = Boolean(workflowChat) && !workflowNoteDismissed;
  const workflowNote =
    workflowChat && standingNoteShown ? (
      <AssistantNote
        testId={WORKFLOW_NOTE_TEST_ID}
        text={`Turn “${workflowChat.title || "this thread"}” into a repeatable workflow — the assistant drafts the steps and asks what it must decide.`}
        actions={[
          canSaveToLibrary
            ? makeWorkflowNoteAction(() =>
                onMakeWorkflow
                  ? onMakeWorkflow(workflowChat)
                  : openAssistantWorkflowDraft(workflowChat),
              )
            : makeWorkflowNoteActionDisabled(
                `you can't save this as a library workflow — saving needs ${LIBRARY_ROLE_LABEL} (organization admins hold it)`,
              ),
        ]}
        onDismiss={onDismissWorkflowNote}
      />
    ) : null;
  // The 2f entry must always be reachable, so the standing note rides below
  // the store's notes instead of trading places with them. The one thing it
  // must not become is a second `Make a workflow…` button: a note that
  // already offers that action (the generator's own `make_workflow` note)
  // replaces the standing one. AssistantNote stamps `data-action-kind` on
  // every action button, so the panel sees what its slot actually renders
  // without the host having to describe its notes to it. A dismissed
  // standing note is simply not there — no row, no button, no section.
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
  const standingShown = standingNoteShown && !noteOffersMakeWorkflow;
  const slot =
    assistantNote || standingShown ? (
      <>
        {assistantNote}
        {standingShown ? workflowNote : null}
      </>
    ) : null;
  const hasContent =
    Boolean(repoName) ||
    Boolean(workflowChat) ||
    branch != null ||
    agentRows.length > 0 ||
    askedRows.length > 0 ||
    skillList.length > 0 ||
    linkRows.length > 0 ||
    Boolean(slot);
  if (!hasContent) return null;

  return (
    <div data-testid="conversation-side-panel" className="min-w-0 space-y-4 p-3">
      {repoName || workflowChat ? (
        <section aria-labelledby="side-panel-works-in-heading" data-testid="side-panel-works-in">
          <SectionTitle htmlFor="side-panel-works-in-heading">Works in</SectionTitle>
          {workflowChat ? (
            <>
              {/* One select-style trigger — scope name and caret in a single
                  bordered button (round-8 review item 3). The repository
                  page link leaves the line with the name: the scope menu is
                  the rail's one door for this section, and the read-only
                  state below keeps its own link. */}
              <div className="mt-1 min-w-0">
                <WorksInSwitcher
                  projectId={projectId}
                  conversationId={workflowChat.id}
                  displayName={repoName ?? null}
                />
              </div>
              {/* The workspace state stays the section's own second line:
                  one section, one sentence, the same words the header's
                  meta line prints. */}
              {worksInNote ? (
                <p
                  className="mt-1 min-w-0 break-words text-[11.5px] text-muted"
                  data-testid="side-panel-works-in-state"
                >
                  {worksInNote}
                </p>
              ) : null}
            </>
          ) : repoName ? (
            <div className="mt-1 flex min-w-0 items-center">
              <p className="min-w-0 break-words font-mono text-[12px] text-ink">
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
            </div>
          ) : null}
          <p
            className="mt-1 text-[11.5px] leading-[1.5] text-faint"
            data-testid="side-panel-works-in-note"
          >
            {workflowChat
              ? "Applies from the next turn."
              : "Read-only — a thread's repository is recorded when it opens and never moves."}
          </p>
        </section>
      ) : null}
      {branch != null ? (
        <section aria-labelledby="side-panel-branch-heading" data-testid="side-panel-branch">
          <SectionTitle htmlFor="side-panel-branch-heading">Branch</SectionTitle>
          {/* Mono is for a branch NAME (machine-kept identifier, rule 07);
              "no branch yet" is a sentence about the thread, so it wears the
              reader's face — the same split WORKS IN uses between the repo
              name and its state (rcn-2e review defect 2). */}
          <p
            className={`mt-1 min-w-0 break-words text-[12px] text-ink ${
              branch === NO_BRANCH_YET ? "text-muted" : "font-mono"
            }`}
          >
            {branch}
          </p>
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
      {agentRows.length > 0 || askedRows.length > 0 ? (
        <section aria-labelledby="side-panel-agents-heading" data-testid="side-panel-agents">
          <SectionTitle htmlFor="side-panel-agents-heading">Agents in this thread</SectionTitle>
          <ul className="mt-1 space-y-1">
            {agentRows.map((agent, index) => {
              const state = agentRunStateCopy(agent, turnRows);
              return (
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
                  {state ? (
                    // Glyph AND word, never colour alone (rule 06) — the same
                    // treatment the LINKED CHATS rows use for a link's state.
                    <span
                      className={STATES.failed.tagFg}
                      data-testid={`side-panel-agent-state-${index}`}
                    >
                      {"\u00b7 "}
                      <span aria-hidden="true">{STATES.failed.glyph} </span>
                      {state}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {askedRows.map((row, index) => {
              // The asked agent's own row (design 3d): "Codex · gpt-5 api,
              // asked once" — label, repo, count. No turn range: no turn of
              // THIS transcript ran on its profile; the count of asks is the
              // fact the links actually carry. State lives on the LINKED
              // CHATS row, not duplicated here.
              const label = askedAgentLabel(row, askedNameSource);
              return (
                <li
                  key={row.key}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-[6px] font-mono text-[11.5px]"
                  data-testid={`side-panel-asked-row-${index}`}
                >
                  {label ? <span className="min-w-0 break-words text-ink">{label}</span> : null}
                  <span
                    className="min-w-0 break-words text-muted"
                    data-testid={`side-panel-asked-repo-${index}`}
                  >
                    {row.repo}
                  </span>
                  <span className="text-faint" data-testid={`side-panel-asked-count-${index}`}>
                    {", "}
                    {askedCountCopy(row.asks)}
                  </span>
                </li>
              );
            })}
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
          <SectionTitle htmlFor="side-panel-links-heading">Linked threads</SectionTitle>
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
        <section aria-labelledby="side-panel-assistant-heading" data-testid="side-panel-assistant">
          <SectionTitle htmlFor="side-panel-assistant-heading">Assistant</SectionTitle>
          <div
            data-testid="side-panel-assistant-slot"
            ref={slotBoxRef}
            className="mt-[8px] min-w-0 space-y-[14px]"
          >
            <AssistantNoteGroup>{slot}</AssistantNoteGroup>
          </div>
        </section>
      ) : null}
    </div>
  );
}
