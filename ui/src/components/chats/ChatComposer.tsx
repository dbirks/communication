/**
 * ChatComposer — PromptBox-based composer for an open chat thread (redesign R3).
 *
 * Preserves every action from AgentConversationComposer:
 * - posting prompts with 409 conflict adoption via `useConversationSession`
 * - stopping an open turn (trailing Stop button)
 * - switching next-turn agent via `AgentPicker` with `agentSwitchBlockedReason`
 * - attaching skills (`/`) and GitHub issues (`#`)
 * - agent-mail `@repo` mentions when `agent_mail_enabled` is true
 * - opening `HandToWorkflowDialog` via the "Run workflow" chip
 * - rendering controller/turn/archived explainers and errors in the footer
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconBuildingFactory2 } from "@tabler/icons-react";
import { useAgentProfiles, useProject, useRepositories } from "../../api/queries";
import { isGitHubRepository, useRepoIssues } from "../../api/issues";
import { turnStatusText } from "../../api/transcript";
import { FormError } from "../Feedback";
import {
  issueQueryAtCaret,
  mailAskFromPrompt,
  mentionQueryAtCaret,
  skillQueryAtCaret,
} from "../conversation/AgentConversationPanel";
import { agentSwitchBlockedReason } from "../conversation/ComposerAgentChip";
import { ComposerIssueMenu, type ComposerIssueMenuState } from "../conversation/ComposerIssueMenu";
import { ComposerSkillMenu, type ComposerSkillMenuState } from "../conversation/ComposerSkillMenu";
import type { ConversationSession } from "../conversation/useConversationSession";
import { Menu, type MenuEntry } from "../ds/Menu";
import { PromptBox, PromptChip } from "../ds/PromptBox";
import { AgentPicker } from "../shell/AgentPicker";

export interface ChatComposerProps {
  session: ConversationSession;
  onOpenWorkflow: () => void;
  /** Rendered directly above the PromptBox (e.g. WorkflowSuggestion), outside `<form>`. */
  aboveBox?: ReactNode;
}

export function ChatComposer({ session, onOpenWorkflow, aboveBox }: ChatComposerProps) {
  const {
    data,
    control,
    isController,
    canRequestControl,
    turnInProgress,
    activeTurn,
    transcript,
    nameOf,
    prompt,
    setPrompt,
    sendMessage,
    switchAgent,
    cancelTurn,
  } = session;

  const projectId = data?.project_id ?? "";
  const project = useProject(projectId);
  const agentMailOn = project.data?.agent_mail_enabled === true;

  const repositoryName = data?.repository_name ?? "";
  const repositories = useRepositories(
    agentMailOn || (isController && repositoryName !== "") ? projectId : "",
  );
  const otherRepos = useMemo(
    () =>
      (repositories.data?.items ?? [])
        .map((repo) => repo.name ?? "")
        .filter((name) => name !== "" && name !== repositoryName),
    [repositories.data, repositoryName],
  );

  const [mention, setMention] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [issueQuery, setIssueQuery] = useState<string | null>(null);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const textareaEl = () => anchorRef.current?.querySelector("textarea") ?? null;

  const mentionOpen = agentMailOn && isController && mention !== null;
  const skillOpen = isController && skillQuery !== null;

  const profiles = useAgentProfiles();
  const nextProfile = (profiles.data?.items ?? []).find(
    (profile) => profile.id === data?.agent_profile_id,
  );
  const skillMenuState: ComposerSkillMenuState = {
    profile: nextProfile,
    loading: profiles.isPending,
    readFailed: profiles.isError,
    filter: skillQuery ?? "",
  };

  const chatRepository = (repositories.data?.items ?? []).find(
    (repo) => repo.name === repositoryName,
  );
  const repositoryId = chatRepository?.id ?? "";
  const issuesAnswerable =
    repositoryName !== "" &&
    chatRepository !== undefined &&
    isGitHubRepository(chatRepository.git_url);
  const issueOpen = isController && issueQuery !== null && issuesAnswerable;
  const issues = useRepoIssues(projectId, repositoryId, "", issueOpen);
  const issueMenuState: ComposerIssueMenuState = {
    issues: issues.data,
    loading: issues.isPending,
    readFailed: issues.isError,
    filter: issueQuery ?? "",
  };

  const candidates = otherRepos.filter((name) =>
    name.toLowerCase().startsWith((mention ?? "").toLowerCase()),
  );

  useLayoutEffect(() => {
    if (mentionOpen || skillOpen || issueOpen) {
      textareaEl()?.focus();
    }
  }, [mentionOpen, skillOpen, issueOpen]);

  const pendingCaret = useRef<{ value: string; position: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (pending === null) return;
    pendingCaret.current = null;
    const el = textareaEl();
    el?.focus();
    if (el !== null && el.value === pending.value) {
      el.setSelectionRange(pending.position, pending.position);
    }
  }, [prompt]);

  const handleChange = (value: string) => {
    if (pendingCaret.current !== null && pendingCaret.current.value !== value) {
      pendingCaret.current = null;
    }
    setPrompt(value);
    const el = textareaEl();
    const caret = el?.selectionStart ?? value.length;
    if (isController) {
      setSkillQuery(skillQueryAtCaret(value, caret));
      setIssueQuery(issueQueryAtCaret(value, caret));
    }
    if (!agentMailOn || !isController) return;
    setMention(mentionQueryAtCaret(value, caret));
  };

  const pickMention = (repo: string) => {
    const el = textareaEl();
    const value = el?.value ?? prompt;
    const caret = el?.selectionStart ?? value.length;
    const query = mentionQueryAtCaret(value, caret) ?? mention ?? "";
    const cut = Math.max(0, caret - query.length - 1);
    const next = `${value.slice(0, cut)}@${repo} ${value.slice(caret)}`;
    pendingCaret.current = { value: next, position: cut + repo.length + 2 };
    setPrompt(next);
    setMention(null);
  };

  const pickSkill = (skill: string) => {
    const el = textareaEl();
    const value = el?.value ?? prompt;
    const caret = el?.selectionStart ?? value.length;
    const query = skillQueryAtCaret(value, caret) ?? skillQuery ?? "";
    const cut = Math.max(0, caret - query.length - 1);
    const next = `${value.slice(0, cut)}/${skill} ${value.slice(caret)}`;
    pendingCaret.current = { value: next, position: cut + skill.length + 2 };
    setPrompt(next);
    setSkillQuery(null);
  };

  const pickIssue = (number: number) => {
    const el = textareaEl();
    const value = el?.value ?? prompt;
    const caret = el?.selectionStart ?? value.length;
    const query = issueQueryAtCaret(value, caret) ?? issueQuery ?? "";
    const cut = Math.max(0, caret - query.length - 1);
    const token = `#${number} `;
    const next = `${value.slice(0, cut)}${token}${value.slice(caret)}`;
    pendingCaret.current = { value: next, position: cut + token.length };
    setPrompt(next);
    setIssueQuery(null);
  };

  const handleSubmit = (trimmed: string) => {
    if (!isController || turnInProgress || data?.status === "archived") return;
    const ask = agentMailOn && isController ? mailAskFromPrompt(trimmed, otherRepos) : null;
    if (ask) {
      sendMessage.mutate(
        { prompt: ask.question, mail_to: ask.repo },
        { onSuccess: () => setPrompt("") },
      );
      return;
    }
    sendMessage.mutate({ prompt: trimmed }, { onSuccess: () => setPrompt("") });
  };

  const mentionMenuItems: MenuEntry[] =
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

  const agentBlocked = agentSwitchBlockedReason(session);
  const archived = data?.status === "archived";

  const chips = (
    // The chips keep their natural width and wrap when the row is too narrow.
    // The row must never scroll: `overflow-x: auto` clips vertically too, which
    // put the pickers opened from it under the transcript. Send stays outside.
    <div
      data-testid="composer-chips"
      className="flex w-full min-w-0 flex-wrap items-center gap-[6px] [&>*]:shrink-0"
    >
      <AgentPicker
        value={data?.agent_profile_id ?? null}
        onChange={(profileId) => switchAgent.mutate({ agent_profile_id: profileId })}
        disabled={agentBlocked !== null || switchAgent.isPending}
        disabledReason={agentBlocked ?? undefined}
        testid="composer-agent-chip"
      />
      <PromptChip
        icon={<IconBuildingFactory2 size={14} stroke={1.5} aria-hidden="true" />}
        onClick={onOpenWorkflow}
        testid="chat-run-workflow"
      >
        Run workflow
      </PromptChip>
      <ComposerSkillMenu
        state={skillMenuState}
        open={skillOpen}
        onOpenChange={(next) => setSkillQuery(next ? "" : null)}
        onPick={pickSkill}
        disabled={!isController}
        chip
      />
      {issuesAnswerable ? (
        <PromptChip
          // A muted mono glyph plus the word, the same anatomy as `/ skill`
          // and every other PromptChip (rx-c1) — no icon drawing for a
          // character the composer already types.
          icon={
            <span className="font-mono text-muted" aria-hidden="true">
              #
            </span>
          }
          chevron
          onClick={() => setIssueQuery((q) => (q === null ? "" : null))}
          disabled={!isController}
          testid="chat-issue-button"
          aria-haspopup="menu"
          aria-expanded={issueOpen}
          title="Attach a GitHub issue"
        >
          issue
        </PromptChip>
      ) : null}
    </div>
  );

  const trailing =
    isController && turnInProgress ? (
      <button
        type="button"
        data-testid="stop-turn"
        disabled={cancelTurn.isPending || Boolean(activeTurn?.cancel_requested_at)}
        onClick={() => cancelTurn.mutate()}
        className="inline-flex h-[32px] shrink-0 items-center rounded-full border border-st-failed-btn-edge bg-st-failed-tag px-[12px] text-[12.5px] font-semibold text-st-failed-tag-fg hover:brightness-95 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {cancelTurn.isPending
          ? "Stopping…"
          : activeTurn?.cancel_requested_at
            ? "Stop requested"
            : "Stop"}
      </button>
    ) : undefined;

  const explainerText = !isController
    ? !canRequestControl
      ? "You can watch this thread. Prompting and taking control need a project contributor role."
      : control?.kind === "human"
        ? `Only the controller (${control.display_name ?? nameOf(control.user_id ?? "")}) can send prompts. Take control to drive.`
        : "Nobody is driving. Take control to send a prompt."
    : archived
      ? "This thread is archived — nothing more runs on it."
      : turnInProgress
        ? `A turn is already open (${turnStatusText(transcript.turns, activeTurn)}). Wait for it to finish, or press Stop — a second prompt into the same turn is refused.`
        : null;

  const hasFooterContent = Boolean(
    explainerText ||
    (agentMailOn && isController) ||
    switchAgent.isPending ||
    switchAgent.error ||
    sendMessage.error ||
    cancelTurn.error,
  );

  const footer = hasFooterContent ? (
    <div className="space-y-[4px]">
      {explainerText ? (
        <p data-testid="composer-explainer" className="text-[12.5px] text-muted">
          {explainerText}
        </p>
      ) : null}
      {agentMailOn && isController ? (
        <p className="font-mono text-[11px] text-muted" data-testid="composer-mail-hint">
          @ another repo&apos;s agent to ask it directly — replies arrive in this thread, and the
          asked agent runs read-only.
        </p>
      ) : null}
      {switchAgent.isPending ? (
        <p
          className="font-mono text-[11px] text-faint"
          role="status"
          data-testid="composer-agent-switch-pending"
        >
          Switching the next-turn agent…
        </p>
      ) : null}
      {switchAgent.error ? (
        <FormError error={switchAgent.error} testid="composer-agent-switch-error" />
      ) : null}
      {sendMessage.error ? (
        <FormError error={sendMessage.error} testid="composer-send-error" />
      ) : null}
      {cancelTurn.error ? (
        <FormError error={cancelTurn.error} testid="composer-cancel-error" />
      ) : null}
    </div>
  ) : undefined;

  return (
    <div data-testid="chat-composer" className="shrink-0 bg-surface px-[20px] pb-[16px] pt-[6px]">
      <div className="mx-auto w-full max-w-[720px]">
        {aboveBox}
        <div ref={anchorRef} className="relative">
          <PromptBox
            value={prompt}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={
              isController ? "Reply, or type / for commands…" : "Only the controller can prompt."
            }
            label="Prompt for the agent"
            rows={1}
            disabled={!isController || archived}
            busy={sendMessage.isPending || turnInProgress}
            chips={chips}
            trailing={trailing}
            footer={footer}
            testid="composer"
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
            items={mentionMenuItems}
          />
          <ComposerIssueMenu
            state={issueMenuState}
            open={issueOpen}
            onClose={() => setIssueQuery(null)}
            triggerRef={anchorRef}
            onPick={pickIssue}
          />
        </div>
        <p className="sr-only" aria-live="polite">
          {sendMessage.isSuccess ? "Prompt queued." : ""}
        </p>
      </div>
    </div>
  );
}
