/**
 * The shared "live ACP conversation with controls" surface.
 *
 * Two places used to implement it — the conversation page
 * (`pages/Conversation.tsx`) and the attempt pane's agent work
 * (`components/m4/AttemptDetail.tsx`) — with the same hooks, the same
 * controller badge, the same take / return / stop buttons, the same
 * transcript and the same composer. The Run Workbench dock needs exactly this
 * too, so it exists once here: the session logic lives in
 * `useConversationSession`, and this file renders it three ways:
 *
 * - `AgentConversationPanel` — the whole surface. `variant="dock"` draws a
 *   compact header with an "Open full conversation" link, the control banner,
 *   the transcript and the composer; `variant="page"` draws only the reading
 *   surface (transcript + composer) because the page keeps its two-column
 *   layout and renders the controls in its context rail itself.
 * - `AgentConversationControls` — the controller badge and the control
 *   buttons, for the page's rail.
 * - `AgentConversationComposer` — the prompt form.
 *
 * Callers that render a part and the panel from one session pass `session`
 * through; the panel computes its own session only when none is supplied.
 * Every historical `data-testid` is preserved via the `ids` overrides.
 */
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { useAgentProfiles, useProject, useRepositories } from "../../api/queries";
import { isGitHubRepository, useRepoIssues } from "../../api/issues";
import { ComposerSkillMenu, type ComposerSkillMenuState } from "./ComposerSkillMenu";
import { ComposerIssueMenu, type ComposerIssueMenuState } from "./ComposerIssueMenu";
import { agentDisplayForLauncher, launcherNameSource } from "./agentNames";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import { Button } from "../ds/Button";
import { Menu, type MenuEntry } from "../ds/Menu";
import { Textarea } from "../ds/Field";
import Transcript from "../Transcript";
import { TakeControlCard } from "../workbench/TakeControlCard";
import { useConversationSession, type ConversationSession } from "./useConversationSession";
import { renderSplitAtTurnFailures } from "./TurnFailureNotice";
import { useStickyTranscript } from "./useTranscriptScroll";
import type { ConversationControl, ConversationTurn } from "../../api/types";
import type { TranscriptItem } from "../../api/transcript";
import { automationViaWords, submitterCopy, turnStatusText } from "../../api/transcript";

/**
 * The glyph the badge wears when nobody holds the conversation.
 *
 * Projects Review 1g drops the "controller: nobody" sentence: an unheld thread
 * is stated by a glyph and its accessible label alone, and `Take control` next
 * to it is the way forward. `○` is the ring the held states fill in (`●`), so
 * the shape — not a printed sentence — carries the fact.
 */
export const NO_CONTROLLER_GLYPH = "○";

/** The name the unheld glyph wears for assistive tech (never printed). */
export const NO_CONTROLLER_LABEL = "No controller";

/**
 * Copy for the controller badge — ownership someone holds is written in words.
 *
 * The design's pill is the lower-case `● you're in control` (Projects Review
 * 1g), so the controller's own line reads that way on every surface; the pane
 * header draws the leading glyph, this string is the words.
 *
 * Nobody holding it is the exception 1g carves out: it returns the short label
 * `No controller`, which is the glyph's accessible name — `AgentConversation-
 * Controls` draws `NO_CONTROLLER_GLYPH` rather than printing it.
 *
 * `control.display_name` is server-resolved and usually present, but the API may
 * omit it (an older replica, a member the projection did not name). The session
 * already holds an actor directory, so a named member is named; "another member"
 * is the last resort, and a uuid is never offered as a label.
 */
export function controllerCopy(
  control: ConversationControl,
  isController: boolean,
  nameOf?: (userId: string) => string,
): string {
  if (isController) return "you're in control";
  if (control.kind === "run_attempt") return "Controlled by a pipeline run";
  if (control.kind === "human") {
    const named = control.display_name ?? (control.user_id ? nameOf?.(control.user_id) : undefined);
    // `nameOf` degrades to "someone (abc12345)", which is not a label a badge
    // should wear — the directory either knows this person or says it does not.
    return named && !named.startsWith("someone (")
      ? `Controlled by ${named}`
      : "Controlled by another member";
  }
  return NO_CONTROLLER_LABEL;
}

/**
 * The stable hooks each surface wears. The page keeps the ids the browser QA
 * and vitest suites have always found — data-testid="controller-badge",
 * data-testid="take-control", data-testid="return-control",
 * data-testid="stop-turn", data-testid="composer-input",
 * data-testid="composer-send", data-testid="composer-explainer" — and the
 * attempt pane keeps its historical `attempt-*` ids via an override. New
 * surfaces may add ids freely — never rename or drop one.
 */
export interface ConversationPanelIds {
  /** The control-banner wrapper (the attempt pane); the page has no wrapper. */
  controlBanner: string | null;
  /** The inline stream-state readout (the attempt pane). */
  stream: string | null;
  /** The controller badge ("who is driving"). */
  badge: string;
  takeControl: string;
  returnControl: string;
  stopTurn: string;
  /** The composer form wrapper; null draws the form without a testid. */
  composerForm: string | null;
  composerInput: string;
  composerSend: string;
  composerExplainer: string;
}

const PAGE_PANEL_IDS: ConversationPanelIds = {
  controlBanner: null,
  stream: null,
  badge: "controller-badge",
  takeControl: "take-control",
  returnControl: "return-control",
  stopTurn: "stop-turn",
  composerForm: null,
  composerInput: "composer-input",
  composerSend: "composer-send",
  composerExplainer: "composer-explainer",
};

interface ControlsProps {
  session: ConversationSession;
  ids: Pick<ConversationPanelIds, "badge" | "takeControl" | "returnControl" | "stopTurn"> &
    Partial<Pick<ConversationPanelIds, "controlBanner" | "stream">>;
  /** Append "· you are watching" to the badge (the attempt pane). */
  watching?: boolean;
  /** A viewer gets a disabled button plus the composer's explainer, not none. */
  disabledTakeForViewer?: boolean;
  /** The page rail: "control version: N" under the buttons. */
  showVersionLine?: boolean;
  /** The page rail: the "You are driving this conversation." note. */
  showDrivingNote?: boolean;
  /**
   * Two-step takeover (the workbench dock): the first `Take control` click
   * shows the confirm card instead of firing the mutation, which only runs
   * when the card confirms. Off keeps the historical one-click take.
   */
  confirmTakeover?: boolean;
  /** The step the confirm card names (the dock passes the node instance key). */
  stepName?: string;
}

/** The controller badge and the only control acts: take, return, stop. */
export function AgentConversationControls({
  session,
  ids,
  watching = false,
  disabledTakeForViewer = false,
  showVersionLine = false,
  showDrivingNote = false,
  confirmTakeover = false,
  stepName,
}: ControlsProps) {
  const {
    data,
    control,
    isController,
    roleKnown,
    canRequestControl,
    turnInProgress,
    activeTurn,
    status,
    nameOf,
    takeControl,
    returnControl,
    cancelTurn,
  } = session;
  // The confirm card (two-step takeover) is open state, not server state.
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!data || !control) return null;

  // 1g: an unheld thread is the glyph and its label with no pill of its own,
  // never a sentence; every other state (a member, a pipeline run, you) keeps
  // the design's worded pill.
  const unheld = control.kind === "none" && !isController;

  const badge = (
    <span
      data-testid={ids.badge}
      className={
        ids.controlBanner
          ? "min-w-0 text-[12px] font-semibold"
          : unheld
            ? "inline-flex h-[22px] items-center font-mono text-[13px] leading-none text-ink-2"
            : "inline-flex h-[22px] items-center rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[10.5px] font-medium text-ink-2"
      }
    >
      {unheld ? (
        <span
          role="img"
          aria-label={NO_CONTROLLER_LABEL}
          title={NO_CONTROLLER_LABEL}
          data-testid={`${ids.badge}-glyph`}
        >
          <span aria-hidden="true">{NO_CONTROLLER_GLYPH}</span>
        </span>
      ) : (
        controllerCopy(control, isController, nameOf)
      )}
      {watching ? <span className="ml-1 font-normal text-muted">· you are watching</span> : null}
    </span>
  );

  // The version we last read; a stale one is a 409 we adopt (§9). With
  // `confirmTakeover` the first click only opens the card — the mutation
  // fires from the card's confirm button, which says exactly what a
  // takeover does (the current attempt is interrupted; the same step runs
  // again on hand-back) before the user commits (ADR-0043, ADR-0016 §5).
  const takeButton = (
    <Button
      variant="primary"
      data-testid={ids.takeControl}
      disabled={takeControl.isPending || !roleKnown || !canRequestControl}
      onClick={() => {
        if (confirmTakeover) setConfirmOpen(true);
        else takeControl.mutate({ version: control.version });
      }}
    >
      {takeControl.isPending ? "Taking…" : "Take control"}
    </Button>
  );

  const actions = (
    <span className="flex flex-wrap items-center gap-2">
      {ids.stream ? (
        <span className="font-mono text-[10.5px] text-faint" data-testid={ids.stream}>
          {status}
        </span>
      ) : null}
      {isController ? (
        <>
          <Button
            variant="secondaryPlain"
            data-testid={ids.returnControl}
            disabled={returnControl.isPending || control.kind !== "human"}
            onClick={() => returnControl.mutate({ version: control.version })}
          >
            {returnControl.isPending ? "Returning…" : "Return control"}
          </Button>
          {turnInProgress ? (
            <Button
              variant="danger"
              data-testid={ids.stopTurn}
              disabled={cancelTurn.isPending || Boolean(activeTurn?.cancel_requested_at)}
              onClick={() => cancelTurn.mutate()}
            >
              {cancelTurn.isPending
                ? "Stopping…"
                : activeTurn?.cancel_requested_at
                  ? "Stop requested"
                  : "Stop"}
            </Button>
          ) : null}
        </>
      ) : canRequestControl || disabledTakeForViewer ? (
        takeButton
      ) : null}
      {showVersionLine ? (
        <span className="font-mono text-[11px] text-faint">control version: {control.version}</span>
      ) : null}
    </span>
  );

  const controlError = takeControl.error ?? returnControl.error ?? null;

  return (
    <>
      {ids.controlBanner ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-line-strong bg-surface px-[8px] py-[6px]"
          data-testid={ids.controlBanner}
        >
          {badge}
          {actions}
        </div>
      ) : (
        <div className="space-y-2">
          {badge}
          {actions}
        </div>
      )}
      {confirmOpen && confirmTakeover && !isController ? (
        <TakeControlCard
          step={stepName ?? "the current step"}
          onConfirm={() => {
            setConfirmOpen(false);
            takeControl.mutate({ version: control.version });
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
      {controlError ? <FormError error={controlError} /> : null}
      {cancelTurn.error ? <FormError error={cancelTurn.error} /> : null}
      {showDrivingNote && isController && takeControl.isSuccess ? (
        <p className="text-[12.5px] text-muted" role="status">
          You are driving this conversation.
        </p>
      ) : null}
    </>
  );
}

interface ComposerProps {
  session: ConversationSession;
  ids: Pick<ConversationPanelIds, "composerInput" | "composerSend" | "composerExplainer"> &
    Partial<Pick<ConversationPanelIds, "composerForm">>;
  inputId: string;
  rows: number;
  /** Placeholder a non-controller reads in the input. */
  nonControllerPlaceholder: string;
  /** The page's "Prompt" heading; the dock keeps the form compact. */
  heading?: boolean;
  /**
   * A control for the row under the textbox — the chat page's ADR-0068 agent
   * chip (`ComposerAgentChip`). Surfaces that do not pass it (the attempt
   * dock: a run-attempt thread cannot switch agents) are unchanged.
   */
  agentPicker?: ReactNode;
}

/**
 * The composer's @-ask (ADR-0072 § 9): `@<repo> <question>` asks the agent
 * of another project repository directly — the POST carries `mail_to`, no
 * turn is queued on this chat, and the answer returns through the mail
 * journal exactly as for an agent-dispatched ask.
 *
 * `mentionQueryAtCaret` is the open-menu test: an `@` that begins a word,
 * with the repository-name alphabet (`Repository.name` in openapi:
 * `[A-Za-z0-9._-]`) trailing it up to the caret. `mailAskFromPrompt` is the
 * send test: a leading `@<token>`, then a non-empty question, and the token
 * names one of the OFFERED repositories — the project's, minus this chat's
 * own (the menu offers "other repos" and the send path agrees with it, so a
 * typed `@<own repo>` stays an ordinary prompt to one's own agent). A prompt
 * that is not a mention routes nowhere and posts as always.
 */
const mentionAtCaret = new RegExp(`(?:^|\\s)@([A-Za-z0-9._-]*)$`);
const mentionSent = /^@(\S+)[ \t]+([\s\S]+)$/;

/**
 * The composer's `/`-skill and `#`-issue opens (design 2e/1h): the trigger
 * characters are only meaningful at the very start of the message — a `/` or
 * `#` mid-sentence is the person's punctuation, not a menu. `skillQueryAtCaret`
 * is the `/` test: a leading `/` plus whatever the person typed after it (the
 * filter; the menu is filtered by prefix). `issueQueryAtCaret` is the `#`
 * test: a leading `#` plus the issue-number prefix the person typed so far.
 * Either returns the query ("" on the bare trigger character) or `null` =
 * closed.
 */
const skillAtCaret = /^\/([^\s]*)$/;
const issueAtCaret = /^#(\d*)$/;

export function skillQueryAtCaret(value: string, caret: number): string | null {
  const match = skillAtCaret.exec(value.slice(0, Math.max(0, caret)));
  return match ? (match[1] ?? "") : null;
}

export function issueQueryAtCaret(value: string, caret: number): string | null {
  const match = issueAtCaret.exec(value.slice(0, Math.max(0, caret)));
  return match ? (match[1] ?? "") : null;
}

export function mentionQueryAtCaret(value: string, caret: number): string | null {
  const match = mentionAtCaret.exec(value.slice(0, Math.max(0, caret)));
  return match ? (match[1] ?? "") : null;
}

export function mailAskFromPrompt(
  text: string,
  offeredRepos: readonly string[],
): { repo: string; question: string } | null {
  const match = mentionSent.exec(text.trim());
  if (!match) return null;
  const question = (match[2] ?? "").trim();
  if (!question) return null;
  const named = (match[1] ?? "").toLowerCase();
  const repo =
    offeredRepos.find((candidate) => candidate === match[1]) ??
    offeredRepos.find((candidate) => candidate.toLowerCase() === named);
  return repo ? { repo, question } : null;
}

/** The prompt form: enabled for the controller only, with the explainer copy
 * and — while the project's agent-mail setting is on — the composer @-menu
 * (ADR-0072 § 9). */
export function AgentConversationComposer({
  session,
  ids,
  inputId,
  rows,
  nonControllerPlaceholder,
  heading = false,
  agentPicker,
}: ComposerProps) {
  const {
    control,
    isController,
    canRequestControl,
    turnInProgress,
    activeTurn,
    transcript,
    nameOf,
    prompt,
    setPrompt,
    onSend,
    sendMessage,
  } = session;
  const explainerId = `${ids.composerExplainer}-copy`;
  // ADR-0072: the 3d composer hint ("@ for another repo's agent") shows only
  // when the project's agent-mail setting is on. The project read is the
  // page's own query key, so this rides cached data — no extra fetch when the
  // page already holds it.
  const project = useProject(session.data?.project_id ?? "");
  const agentMailOn = project.data?.agent_mail_enabled === true;
  // The @-menu's candidates exist only for a controller of a mail-enabled
  // project; the repos read rides the project page's own query key, so this
  // costs a fetch only on a surface that never showed the list. A repo-scoped
  // chat also rides this read: the `#`-menu needs the thread's repository
  // `git_url` to know whether the remote is GitHub-hosted.
  const repositoryName = session.data?.repository_name ?? "";
  const repositories = useRepositories(
    agentMailOn || (isController && repositoryName !== "") ? (session.data?.project_id ?? "") : "",
  );
  const ownRepo = session.data?.repository_name ?? "";
  const otherRepos = useMemo(
    () =>
      (repositories.data?.items ?? [])
        .map((repo) => repo.name ?? "")
        .filter((name) => name !== "" && name !== ownRepo),
    [repositories.data, ownRepo],
  );
  // The @-menu's live query: null = closed, "" = opened on the bare `@`.
  const [mention, setMention] = useState<string | null>(null);
  // The `/`-skill and `#`-issue live queries: the same null/"" contract.
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [issueQuery, setIssueQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const mentionOpen = agentMailOn && isController && mention !== null;

  // The SKILLS menu: the profile the NEXT turn runs on is the conversation
  // read's own `agent_profile_id`; its `apm_contents.skills` are the names
  // the worker's lock recorded (api `AgentProfile.apm_contents`) — the org
  // profile list is the read that carries them, and the chip already rode
  // that key, so this is a cache hit, not a fetch.
  const profiles = useAgentProfiles();
  const nextProfile = (profiles.data?.items ?? []).find(
    (profile) => profile.id === session.data?.agent_profile_id,
  );
  const skillMenuState: ComposerSkillMenuState = {
    profile: nextProfile,
    loading: profiles.isPending,
    readFailed: profiles.isError,
    filter: skillQuery ?? "",
  };
  const skillOpen = isController && skillQuery !== null;

  // The ISSUES menu: only a repo-scoped chat whose repository remote is
  // GitHub-hosted can answer — `isGitHubRepository` is the same guard the
  // handoff surface uses, so a `file://` or foreign remote opens nothing and
  // the `#` stays typed punctuation. The conversation read names the thread's
  // repository (ADR-0065/0067's resolution, `repository_name`); the project's
  // repos read supplies the row whose `git_url` the guard must inspect. The
  // open-issues read fires ONLY while the menu is open: the GitHub budget is
  // per replica IP, and a rendered chat must not spend it.
  const chatRepository = (repositories.data?.items ?? []).find(
    (repo) => repo.name === repositoryName,
  );
  const repositoryId = chatRepository?.id ?? "";
  const issuesAnswerable =
    repositoryName !== "" &&
    chatRepository !== undefined &&
    isGitHubRepository(chatRepository.git_url);
  const issueOpen = isController && issueQuery !== null && issuesAnswerable;
  const issues = useRepoIssues(session.data?.project_id ?? "", repositoryId, "", issueOpen);
  const issueMenuState: ComposerIssueMenuState = {
    issues: issues.data,
    loading: issues.isPending,
    readFailed: issues.isError,
    filter: issueQuery ?? "",
  };
  // ds `Textarea` accepts no `ref` prop, so the composer's textarea is reached
  // through its own anchor span — the element the menu is already placed
  // against. The change handler caches the same node; this is the path that
  // works before the first keystroke.
  const composerElement = () =>
    inputRef.current ?? anchorRef.current?.querySelector("textarea") ?? null;
  const candidates = otherRepos.filter((name) =>
    name.toLowerCase().startsWith((mention ?? "").toLowerCase()),
  );
  // The ds Menu parks focus on its first item when it opens (a child layout
  // effect). The person is typing, not tabbing into a menu — the composer
  // owns the caret. A parent layout effect runs after the child's in the
  // same synchronous commit, so the refocus lands before any queued keystroke
  // could hit the menu button: the menu answers the pointer and the arrow
  // keys, never a keystroke the textarea should have had.
  useLayoutEffect(() => {
    if (mentionOpen || skillOpen || issueOpen) inputRef.current?.focus();
  }, [mentionOpen, skillOpen, issueOpen]);

  // The caret the completion owes the person, applied in the SAME synchronous
  // commit that writes the completed value and only while the field still
  // holds exactly that value. A `requestAnimationFrame` restore (8408a14) ran a
  // frame LATE: a fast typist (and Playwright) had already put keystrokes in the
  // field, so the parked caret jumped back into the middle of the question and
  // the rest of it was typed out of order — run 41542324484, passes 1–4, lost
  // "the question rode through verbatim" exactly that way. Any keystroke clears
  // the pending restore first: after that the person owns the caret.
  const pendingCaret = useRef<{ value: string; position: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (pending === null) return;
    pendingCaret.current = null;
    const element = composerElement();
    // The menu took focus when it opened and never gives it back on a pick, so
    // the composer reclaims it — but the caret only moves for the value the
    // completion itself wrote.
    element?.focus();
    if (element !== null && element.value === pending.value) {
      element.setSelectionRange(pending.position, pending.position);
    }
  }, [prompt]);

  const onPromptChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const element = event.currentTarget;
    inputRef.current = element;
    if (pendingCaret.current !== null && pendingCaret.current.value !== value) {
      pendingCaret.current = null;
    }
    setPrompt(value);
    const caret = element.selectionStart ?? value.length;
    // All three menus are keyed to the start of the message, so one caret
    // read serves them; a message can only owe one menu at a time.
    if (isController) {
      setSkillQuery(skillQueryAtCaret(value, caret));
      setIssueQuery(issueQueryAtCaret(value, caret));
    }
    if (!agentMailOn || !isController) return;
    setMention(mentionQueryAtCaret(value, caret));
  };

  // Replace the open `@query` before the caret with `@<repo> ` — the token
  // the send path parses back into `mail_to` — and park the caret right
  // after it, ready for the question.
  const pickMention = (repo: string) => {
    const element = composerElement();
    const value = element?.value ?? prompt;
    const caret = element?.selectionStart ?? value.length;
    const query = mentionQueryAtCaret(value, caret) ?? mention ?? "";
    const cut = Math.max(0, caret - query.length - 1);
    const next = `${value.slice(0, cut)}@${repo} ${value.slice(caret)}`;
    pendingCaret.current = { value: next, position: cut + repo.length + 2 };
    setPrompt(next);
    setMention(null);
  };

  /** The same completion for the `/`-skill pick: replace the typed `/query`
   * with `/<skill> ` and park the caret right after it. */
  const pickSkill = (skill: string) => {
    const element = composerElement();
    const value = element?.value ?? prompt;
    const caret = element?.selectionStart ?? value.length;
    const query = skillQueryAtCaret(value, caret) ?? skillQuery ?? "";
    const cut = Math.max(0, caret - query.length - 1);
    const next = `${value.slice(0, cut)}/${skill} ${value.slice(caret)}`;
    pendingCaret.current = { value: next, position: cut + skill.length + 2 };
    setPrompt(next);
    setSkillQuery(null);
  };

  /** The same completion for the `#`-issue pick: replace the typed `#query`
   * with `#<number> ` and park the caret right after it. */
  const pickIssue = (number: number) => {
    const element = composerElement();
    const value = element?.value ?? prompt;
    const caret = element?.selectionStart ?? value.length;
    const query = issueQueryAtCaret(value, caret) ?? issueQuery ?? "";
    const cut = Math.max(0, caret - query.length - 1);
    const token = `#${number} `;
    const next = `${value.slice(0, cut)}${token}${value.slice(caret)}`;
    pendingCaret.current = { value: next, position: cut + token.length };
    setPrompt(next);
    setIssueQuery(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const ask = agentMailOn && isController ? mailAskFromPrompt(trimmed, otherRepos) : null;
    if (ask) {
      // The mail arm: `mail_to` rides the same messages route; nothing is
      // queued on this chat (ADR-0072 § 9). The card, the LINKED CHATS row
      // and the answer all arrive on the conversation's own stream.
      sendMessage.mutate(
        { prompt: ask.question, mail_to: ask.repo },
        { onSuccess: () => setPrompt("") },
      );
      return;
    }
    onSend(event);
  };

  const menuItems: MenuEntry[] =
    candidates.length > 0
      ? candidates.map((name) => ({
          id: name,
          label: name,
          testId: `composer-mail-repo-${name}`,
          onSelect: () => pickMention(name),
        }))
      : [
          {
            id: "no-match",
            label: otherRepos.length === 0 ? "No other repo to ask." : "No repository matches.",
            onSelect: () => {},
            disabled: true,
          },
        ];
  return (
    <section aria-labelledby={heading ? "composer-heading" : undefined} className="space-y-2">
      {heading ? (
        <h2
          id="composer-heading"
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          Prompt
        </h2>
      ) : null}
      <form onSubmit={submit} className="space-y-2" data-testid={ids.composerForm ?? undefined}>
        <label className="sr-only" htmlFor={inputId}>
          Prompt for the agent
        </label>
        {/* Design 2e: the textbox owns the whole row — `flex-1 min-w-0` lets
            it take every remaining px beside nothing, so the full
            "Reply, / for skills, # for issues…" placeholder fits at 1280
            instead of clipping; the chip, the / skill button and Send sit
            in their own row below it. In a host that sets the form to a
            wrapping flex row (the chat pane's ink box), the `w-full` keeps
            the box on its own line; the textarea itself wraps rather than
            clip if the layout is ever too narrow for the placeholder. */}
        <span ref={anchorRef} className="relative block w-full min-w-0 flex-1">
          <Textarea
            id={inputId}
            data-testid={ids.composerInput}
            rows={rows}
            value={prompt}
            onChange={onPromptChange}
            disabled={!isController}
            aria-describedby={turnInProgress || !isController ? explainerId : undefined}
            placeholder={
              // Design 2e/1h: the placeholder names the two typed affordances
              // — `/` opens the skills menu, `#` the open issues — and the
              // `@` affordance stays with the line under the box
              // (`composer-mail-hint`) when agent mail is on.
              isController ? "Reply, / for skills, # for issues…" : nonControllerPlaceholder
            }
          />
          <Menu
            open={mentionOpen}
            onClose={() => setMention(null)}
            triggerRef={anchorRef}
            side="top"
            width={260}
            caption="ASK ANOTHER REPO'S AGENT"
            ariaLabel="The project repositories whose agent you can ask"
            data-testid="composer-mail-menu"
            items={menuItems}
          />
          <ComposerIssueMenu
            state={issueMenuState}
            open={issueOpen}
            onClose={() => setIssueQuery(null)}
            triggerRef={anchorRef}
            onPick={pickIssue}
          />
        </span>
        {agentMailOn && isController ? (
          <p className="font-mono text-[11px] text-muted" data-testid="composer-mail-hint">
            @ another repo's agent to ask it directly — replies arrive in this chat, and the asked
            agent runs read-only.
          </p>
        ) : null}
        {/* The controls row: the next-turn agent chip, the / skill button
            and Send share ONE line under the textbox (design 2e). The chip
            is a caller-supplied node whose own box truncates; the row wraps
            only when even that cannot fit (390 keeps all three on the line
            because the chip shrinks). */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
          {agentPicker}
          <ComposerSkillMenu
            state={skillMenuState}
            open={skillOpen}
            onOpenChange={(next) => setSkillQuery(next ? "" : null)}
            onPick={pickSkill}
            disabled={!isController}
          />
          <Button
            type="submit"
            variant="primary"
            data-testid={ids.composerSend}
            // Enabled for the controller only, and never while a turn is open:
            // the API refuses a second prompt into a running turn (01 invariant,
            // 06 "do not send competing prompts"), so we say so instead of failing.
            disabled={!isController || turnInProgress || sendMessage.isPending || !prompt.trim()}
          >
            {sendMessage.isPending
              ? "Sending…"
              : mailAskFromPrompt(prompt, otherRepos) !== null
                ? "Ask"
                : "Send"}
          </Button>
        </div>
      </form>
      {!isController ? (
        <p
          id={explainerId}
          className="text-[12.5px] text-muted"
          data-testid={ids.composerExplainer}
        >
          {!canRequestControl
            ? "You can watch this conversation. Prompting and taking control need a project contributor role."
            : control?.kind === "human"
              ? `Only the controller (${control.display_name ?? nameOf(control.user_id ?? "")}) can send prompts. Take control to drive.`
              : "Nobody is driving. Take control to send a prompt."}
        </p>
      ) : turnInProgress ? (
        <p
          id={explainerId}
          className="text-[12.5px] text-muted"
          data-testid={ids.composerExplainer}
        >
          {/* The same words the thread header's status line uses — a raw wire
              status like `leased` is not something a member reads. */}
          A turn is already open ({turnStatusText(transcript.turns, activeTurn)}). Wait for it to
          finish, or press Stop — a second prompt into the same turn is refused.
        </p>
      ) : null}
      {sendMessage.error ? (
        <FormError error={sendMessage.error} />
      ) : (
        <p className="sr-only" aria-live="polite">
          {sendMessage.isSuccess ? "Prompt queued." : ""}
        </p>
      )}
    </section>
  );
}

export interface AgentConversationPanelProps {
  conversationId: string;
  projectId: string;
  variant: "page" | "dock";
  /** A session the caller already computed (the page renders the controls in
   *  its rail from the same one); the panel computes its own only if absent. */
  session?: ConversationSession;
  /** Show only the transcript items of this turn (the attempt pane). */
  turnFilter?: string;
  /**
   * The turn this surface's attempt ran (the Run Workbench dock). The
   * transcript still shows the WHOLE conversation — a takeover opens a new
   * turn in the same conversation — but a marker row is inserted where that
   * turn begins, and every turn a human started (a user message) is marked
   * with the person's name. `null` items keep journal order.
   */
  attemptTurnId?: string;
  /** Compact dock header content, next to "Open full conversation". */
  header?: ReactNode;
  /** Dock: the "Open full conversation" target (defaults to the page). */
  openFullHref?: string;
  /** Id/copy overrides; the attempt pane keeps its historical testids. */
  ids?: Partial<ConversationPanelIds>;
  /** Badge suffix "· you are watching" (the attempt pane). */
  watching?: boolean;
  /** Rendered instead of an empty transcript. */
  empty?: { testid: string; copy: string };
  /** Rendered while the conversation read is pending. */
  pending?: ReactNode;
  /** Rendered when the API answers 404 (the page's full not-found view). */
  notFound?: ReactNode;
  /** ProblemBanner fallback when the conversation cannot be read. */
  errorFallback?: string;
  composer?: {
    inputId: string;
    rows: number;
    nonControllerPlaceholder: string;
  };
  /**
   * Two-step takeover on this surface's `Take control` button. Defaults to
   * `variant === "dock"`: the workbench dock always confirms before it
   * interrupts the attempt, the standalone Conversation page keeps its
   * one-click take. Pass `false` on a dock to opt out.
   */
  confirmTakeover?: boolean;
  /** The step the confirm card names (the dock passes the node instance key). */
  stepName?: string;
}

/**
 * The whole-conversation transcript for a surface bound to one attempt turn.
 *
 * A takeover cancels the attempt's turn and opens a NEW one in the same
 * conversation, so the dock shows every turn; this inserts a marker row
 * before the first frame of (a) the attempt's own turn and (b) each turn a
 * human started — `conversation.message.user` is appended only by a person's
 * own `POST …/messages` or thread creation, so a user frame is a human
 * submission. Markers are plain system rows, so they render through the same
 * journal styling as everything the stream itself wrote.
 *
 * Since ADR-0062 `submitted_by` alone is no longer proof a person typed the
 * prompt: an unattended turn carries the authorising human's id with
 * `submitted_via='schedule'|'issue_trigger'|'child_run'`, and a marker that
 * read "human turn" off the id alone would say something the turn row
 * contradicts. Where the two disagree the row wins, and the row is also the
 * only name an unattended turn has: the claim seam stamps the turn without a
 * prompt frame, so without it this dock would call the factory's work nobody's.
 */
function markTurns(
  items: TranscriptItem[],
  attemptTurnId: string | undefined,
  nameOf: (userId: string) => string,
  turnRows: readonly ConversationTurn[] = [],
): TranscriptItem[] {
  if (!attemptTurnId) return items;
  const authorByTurn = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "user" && item.turnId) {
      authorByTurn.set(item.turnId, item.authorUserId);
    }
  }
  const rowByTurn = new Map(turnRows.map((row) => [row.id, row]));
  const out: TranscriptItem[] = [];
  let lastTurn: string | null = null;
  for (const item of items) {
    const turn = "turnId" in item ? item.turnId : null;
    if (turn !== null && turn !== lastTurn) {
      lastTurn = turn;
      const author = authorByTurn.get(turn);
      const row = rowByTurn.get(turn);
      const labels: string[] = [];
      if (automationViaWords(row?.submitted_via)) {
        // The wire's own name for the person outranks a directory read, exactly
        // as the controller badge prefers `control.display_name`; the journal's
        // `submitted_by` names the same human when it is present at all.
        const submitterId = row?.submitted_by ?? author;
        const named = row?.submitted_by_display_name || (submitterId ? nameOf(submitterId) : "");
        labels.push(`unattended turn — ${submitterCopy(named, row?.submitted_via)}`);
      } else if (author) {
        labels.push(`human turn — prompted by ${nameOf(author)}`);
      }
      if (turn === attemptTurnId) labels.push("this attempt's turn starts here");
      if (labels.length > 0) {
        out.push({
          kind: "system",
          id: `mark-turn-${turn}`,
          text: labels.join(" · "),
          at: "at" in item ? item.at : "",
        });
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * The whole conversation surface: compact header and controls (dock only),
 * the transcript — permission cards included — and the composer.
 */
export function AgentConversationPanel(props: AgentConversationPanelProps) {
  if (props.session) {
    return <PanelInner {...props} session={props.session} />;
  }
  return <PanelWithOwnSession {...props} />;
}

/** Hook isolation: the session is computed here, not conditionally. */
function PanelWithOwnSession(props: Omit<AgentConversationPanelProps, "session">) {
  const session = useConversationSession(props.conversationId, props.projectId);
  return <PanelInner {...props} session={session} />;
}

function PanelInner({
  conversationId,
  projectId,
  variant,
  session,
  turnFilter,
  attemptTurnId,
  header,
  openFullHref,
  ids,
  watching = false,
  empty,
  pending,
  notFound,
  errorFallback,
  composer,
  confirmTakeover,
  stepName,
}: AgentConversationPanelProps & { session: ConversationSession }) {
  const merged: ConversationPanelIds = { ...PAGE_PANEL_IDS, ...ids };
  const { conversation, data } = session;
  // The thread's pin (rcn-review10): like the page, this surface keeps the
  // newest row at the bottom of whatever scroller owns it (a no-op where it
  // has none). The ref wraps the transcript block in both variants below —
  // the callback re-arms the pin when the transcript lands after the
  // loading state.
  const transcriptRef = useStickyTranscript();

  if (conversation.isPending) {
    return pending ?? <Spinner label="Loading conversation" />;
  }
  if (conversation.error instanceof ApiError && conversation.error.status === 404) {
    return (
      notFound ?? (
        <ProblemBanner
          error={conversation.error}
          fallback="The conversation could not be loaded."
        />
      )
    );
  }
  if (conversation.error || !data) {
    return (
      <ProblemBanner
        error={conversation.error}
        fallback={errorFallback ?? "The conversation could not be loaded."}
      />
    );
  }

  // Fold the journal, then keep only the turn this surface is about — a turn
  // filter means this surface is one unit's (the attempt pane), not every
  // turn the conversation ever ran.
  const items = turnFilter
    ? session.transcript.items.filter((item) => "turnId" in item && item.turnId === turnFilter)
    : markTurns(session.transcript.items, attemptTurnId, session.nameOf, session.turnRows);

  const transcriptFor = (list: TranscriptItem[]) => (
    <Transcript
      items={list}
      agentName={data.agent_profile_name ?? "agent"}
      canDecide={session.isController}
      controllerName={
        data.control.display_name ??
        (data.control.user_id ? session.nameOf(data.control.user_id) : null)
      }
      nameOf={session.nameOf}
      onDecide={session.onDecide}
      decidingRequestId={session.decidingRequestId}
      decisionError={session.decide.error}
      decisionErrorRequestId={
        session.decide.isError ? (session.decide.variables?.requestId ?? null) : null
      }
    />
  );

  // A failed turn cuts this list too (error-details-r6): the dock and the
  // attempt pane read the journal, and `Turn failed: worker: prepare
  // workspace for project <uuid>: …` is the worker's text, not the reader's.
  const transcriptBlock =
    empty && items.length === 0 ? (
      <p className="text-[12px] text-muted" data-testid={empty.testid}>
        {empty.copy}
      </p>
    ) : (
      renderSplitAtTurnFailures(
        items,
        session.events,
        "panel",
        transcriptFor,
        // rcn-2f review item 3: this surface names the agent a failed turn
        // was run by, from the conversation's own profile row and the switch
        // dividers in its stream — `launcher "codex" is not signed in` reads
        // as "Codex isn't signed in on this worker, so this turn couldn't
        // start." A launcher neither read names keeps the machine's word.
        (launcherId) =>
          agentDisplayForLauncher(launcherId, launcherNameSource(data, session.events, []))?.name ??
          null,
      )
    );

  const composerBlock = (
    <AgentConversationComposer
      session={session}
      ids={merged}
      inputId={composer?.inputId ?? `conversation-prompt-${conversationId}`}
      rows={composer?.rows ?? 2}
      nonControllerPlaceholder={
        composer?.nonControllerPlaceholder ?? "Only the controller can prompt."
      }
      heading={variant === "page"}
    />
  );

  if (variant === "dock") {
    return (
      <div className="space-y-[8px]">
        <div className="flex items-center justify-between gap-2">
          {header ? (
            <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{header}</span>
          ) : null}
          <Link
            to={openFullHref ?? `/projects/${projectId}/conversations/${conversationId}`}
            className="text-accent-text hover:text-ink"
            data-testid="dock-open-conversation"
          >
            Open full conversation
          </Link>
        </div>
        <AgentConversationControls
          session={session}
          ids={merged}
          watching={watching}
          disabledTakeForViewer
          confirmTakeover={confirmTakeover ?? variant === "dock"}
          stepName={stepName}
        />
        <div ref={transcriptRef}>{transcriptBlock}</div>
        {composerBlock}
      </div>
    );
  }

  // The page composes this surface into its transcript column; its controls
  // live in the context rail, rendered from the same session.
  return (
    <>
      <div ref={transcriptRef}>{transcriptBlock}</div>
      {composerBlock}
    </>
  );
}
