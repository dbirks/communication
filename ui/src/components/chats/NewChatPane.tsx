/**
 * NewChatPane — start a new chat or pick up a recent one (redesign R3).
 *
 * Its placeholder is the one sentence every new chat starts behind, "Ask,
 * plan, or hand off a task…" — the same string the all-projects Home box
 * prints, so the two entry points ask for the same thing.
 *
 * Uses PromptBox with project picker (in a project scope the project is a
 * fact, so a fixed, disabled chip replaces the picker), repository chip (when
 * the selected project has > 1 repository), and AgentPicker. Creates the
 * conversation with its first prompt and navigates to the new thread.
 *
 * The agent chip starts on `pickDefaultAgent` (ADR-0086) — the choice stored
 * for this project, else the project's default agent, else the first profile —
 * and a profile picked here is stored the same way the Home box stores it, so
 * the two boxes remember one choice instead of two.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconChevronDown,
  IconFolder,
  IconGitBranch,
} from "@tabler/icons-react";
import {
  useAgentProfiles,
  useCreateConversation,
  useProject,
  useProjects,
  useRepositories,
} from "../../api/queries";
import { formatAge, shortId } from "../../lib/format";
import { previewLine } from "../../lib/preview";
import { routes } from "../../lib/routes";
import { FormError } from "../Feedback";
import { Menu, type MenuEntry } from "../ds/Menu";
import { PromptBox, PromptChip } from "../ds/PromptBox";
import { AgentPicker } from "../shell/AgentPicker";
import { pickDefaultAgent, rememberAgentChoice, storedAgentChoice } from "../../lib/defaultAgent";
import { useThreadList } from "../threads/ThreadListPane";
import { legacyRunThreadTitle } from "../threads/runThreadTitle";

function deriveChatTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (firstLine.length <= 80) return firstLine;
  return `${firstLine.slice(0, 77).trimEnd()}…`;
}

export interface NewChatPaneProps {
  scope: string | null;
  showBack?: boolean;
}

export function NewChatPane({ scope, showBack = false }: NewChatPaneProps) {
  const navigate = useNavigate();
  const projects = useProjects();
  const scopedProject = useProject(scope ?? "");
  const profiles = useAgentProfiles();
  const recentList = useThreadList(scope ?? "", null);

  const writableProjects = useMemo(
    () => (projects.data?.items ?? []).filter((p) => p.my_role !== "viewer"),
    [projects.data],
  );

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);

  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const repoTriggerRef = useRef<HTMLButtonElement>(null);

  const activeProjectId =
    scope ?? (selectedProjectId || (writableProjects.length === 1 ? writableProjects[0].id : ""));

  const resolvedScopedProject = scope
    ? (scopedProject.data ?? (projects.data?.items ?? []).find((p) => p.id === scope) ?? null)
    : null;
  const activeProject = scope
    ? resolvedScopedProject
    : (writableProjects.find((p) => p.id === activeProjectId) ?? null);

  const isScopedViewer = Boolean(scope && resolvedScopedProject?.my_role === "viewer");
  const noWritableProjects = !scope && projects.data !== undefined && writableProjects.length === 0;
  const cannotStartChat = isScopedViewer || noWritableProjects;
  const viewerNotice = isScopedViewer
    ? resolvedScopedProject?.name
      ? `You can read chats in ${resolvedScopedProject.name}, but only members can start one.`
      : "You can read chats here, but only members can start one."
    : noWritableProjects
      ? "You can read chats, but only members can start one."
      : null;

  const repositories = useRepositories(activeProjectId);
  const repoItems = repositories.data?.items ?? [];

  const profileItems = profiles.data?.items ?? [];
  // ADR-0086's one preselect order, shared with the Home prompt box: an
  // explicit pick in this pane wins, then the choice stored for this project,
  // then the project's own default agent while it is still offered, then the
  // first profile.
  const effectiveProfileId =
    selectedProfileId ??
    pickDefaultAgent({
      stored: storedAgentChoice(activeProjectId),
      projectDefault: activeProject?.default_agent_profile_id,
      profiles: profileItems,
    });

  const create = useCreateConversation(activeProjectId);

  // The first three chats are already at the top of the left list, so "OR PICK
  // UP" continues where that list stops: with more than three chats it shows
  // the next five (ranks 4–8); with three or fewer there is nothing to skip.
  const recentChats = useMemo(() => {
    const items = scope ? recentList.items.filter((c) => c.project_id === scope) : recentList.items;
    return items.length > 3 ? items.slice(3, 8) : items;
  }, [recentList.items, scope]);

  const projectNameOf = (id: string) =>
    projects.data?.items.find((project) => project.id === id)?.name ?? shortId(id);

  const projectMenuItems: MenuEntry[] =
    writableProjects.length > 0
      ? writableProjects.map((project) => ({
          id: project.id,
          label: project.name,
          checked: project.id === activeProjectId,
          testId: `new-chat-project-${project.id}`,
          onSelect: () => {
            setSelectedProjectId(project.id);
            setSelectedRepo(null);
            setValidationError(null);
            setProjectMenuOpen(false);
          },
        }))
      : [
          {
            id: "no-projects",
            label: projects.isPending
              ? "Loading projects…"
              : "No projects where you can start a chat.",
            onSelect: () => {},
            disabled: true,
          },
        ];

  const repoMenuItems: MenuEntry[] = [
    {
      id: "whole-project",
      label: "Whole project",
      checked: selectedRepo === null,
      testId: "new-chat-repo-all",
      onSelect: () => {
        setSelectedRepo(null);
        setRepoMenuOpen(false);
      },
    },
    ...repoItems.map((repo) => ({
      id: repo.id,
      label: repo.name,
      checked: selectedRepo === repo.name,
      testId: `new-chat-repo-${repo.id}`,
      onSelect: () => {
        setSelectedRepo(repo.name);
        setRepoMenuOpen(false);
      },
    })),
  ];

  const handleSubmit = (submitted: string) => {
    if (!activeProjectId) {
      setValidationError("Pick a project before starting a chat.");
      return;
    }
    if (!effectiveProfileId) {
      setValidationError("Choose an agent before starting a chat.");
      return;
    }
    setValidationError(null);
    create.mutate(
      {
        agent_profile_id: effectiveProfileId,
        title: deriveChatTitle(submitted),
        prompt: submitted,
        ...(selectedRepo ? { repository: selectedRepo } : {}),
      },
      {
        onSuccess: (conversation) => {
          navigate(routes.chat(conversation.id, activeProjectId));
        },
      },
    );
  };

  const chips = (
    <>
      {scope && activeProject ? (
        // In a project scope the project is a fact, not a choice: a fixed chip
        // with no menu where the picker used to sit.
        <PromptChip
          testid="chat-new-project-fixed"
          disabled
          icon={<IconFolder size={14} stroke={1.5} aria-hidden="true" />}
        >
          {activeProject.name}
        </PromptChip>
      ) : null}
      {scope ? null : (
        <span className="relative inline-flex max-w-full">
          <PromptChip
            buttonRef={projectTriggerRef}
            testid="new-chat-project-chip"
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            icon={<IconFolder size={14} stroke={1.5} aria-hidden="true" />}
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <span className="inline-flex items-center gap-[4px]">
              <span>{activeProject?.name ?? "Pick a project"}</span>
              <IconChevronDown size={12} stroke={1.5} className="text-muted" aria-hidden="true" />
            </span>
          </PromptChip>
          <Menu
            open={projectMenuOpen}
            onClose={() => setProjectMenuOpen(false)}
            triggerRef={projectTriggerRef}
            side="bottom"
            width={220}
            className="max-h-[min(320px,calc(100vh-140px))] overflow-y-auto"
            caption="PROJECT"
            ariaLabel="Project"
            data-testid="new-chat-project-menu"
            items={projectMenuItems}
          />
        </span>
      )}
      {repoItems.length > 1 ? (
        <span className="relative inline-flex max-w-full">
          <PromptChip
            buttonRef={repoTriggerRef}
            testid="new-chat-repo-chip"
            aria-haspopup="menu"
            aria-expanded={repoMenuOpen}
            icon={<IconGitBranch size={14} stroke={1.5} aria-hidden="true" />}
            onClick={() => setRepoMenuOpen((open) => !open)}
          >
            <span className="inline-flex items-center gap-[4px]">
              <span>{selectedRepo ?? "Whole project"}</span>
              <IconChevronDown size={12} stroke={1.5} className="text-muted" aria-hidden="true" />
            </span>
          </PromptChip>
          <Menu
            open={repoMenuOpen}
            onClose={() => setRepoMenuOpen(false)}
            triggerRef={repoTriggerRef}
            side="bottom"
            width={220}
            className="max-h-[min(320px,calc(100vh-140px))] overflow-y-auto"
            caption="REPOSITORY"
            ariaLabel="Repository"
            data-testid="new-chat-repo-menu"
            items={repoMenuItems}
          />
        </span>
      ) : null}
      <AgentPicker
        value={effectiveProfileId}
        onChange={(id) => {
          setSelectedProfileId(id);
          // The same key the Home prompt box writes: the pick is one choice per
          // project, not one per box.
          rememberAgentChoice(activeProjectId, id);
          setValidationError(null);
        }}
        testid="new-chat-agent-picker"
      />
    </>
  );

  const footer = (
    <>
      {validationError ? (
        <p role="alert" className="text-[12.5px] text-st-failed-tag-fg">
          {validationError}
        </p>
      ) : null}
      {create.error ? <FormError error={create.error} testid="new-chat-error" /> : null}
    </>
  );

  return (
    <div
      data-testid="chat-new-pane"
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface"
    >
      {showBack ? (
        <div className="flex h-[54px] shrink-0 items-center border-b border-line-soft px-[16px]">
          <Link
            to={routes.chats(scope)}
            data-testid="chat-back"
            aria-label="Back to chats"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[8px] text-ink-2 hover:bg-rail focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconArrowLeft size={18} stroke={1.5} aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      <div
        data-testid="new-chat-body"
        className="mx-auto flex min-h-full w-full max-w-[740px] flex-col justify-center gap-[18px] px-[20px] py-[48px] max-md:justify-start max-md:pt-[24px]"
      >
        <h2 className="text-center text-[24px] font-bold text-ink">New chat</h2>

        {cannotStartChat ? (
          <div
            data-testid="new-chat-prompt"
            className="rounded-[14px] border border-line-strong bg-surface px-[16px] py-[14px] shadow-[var(--shadow-prompt)]"
          >
            <textarea
              data-testid="new-chat-prompt-input"
              aria-label="New chat prompt"
              value=""
              rows={2}
              readOnly
              disabled
              placeholder="Ask, plan, or hand off a task…"
              className="block w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-[22px] text-ink outline-none placeholder:text-faint disabled:text-disabled-fg"
            />
            <div className="mt-[10px] flex items-center gap-[8px]">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[6px]">{chips}</div>
            </div>
            {viewerNotice ? (
              <div
                className="mt-[8px] text-[12.5px] text-muted"
                data-testid="new-chat-viewer-notice"
              >
                {viewerNotice}
              </div>
            ) : null}
          </div>
        ) : (
          <PromptBox
            value={text}
            onChange={(next) => {
              setText(next);
              if (validationError) setValidationError(null);
            }}
            onSubmit={handleSubmit}
            placeholder="Ask, plan, or hand off a task…"
            label="New chat prompt"
            autoFocus
            rows={2}
            busy={create.isPending}
            chips={chips}
            footer={validationError || create.error ? footer : undefined}
            testid="new-chat-prompt"
          />
        )}

        {recentChats.length > 0 ? (
          <div className="mt-[10px] flex flex-col gap-[4px]" data-testid="new-chat-pick-up">
            <span className="px-[2px] pb-[4px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
              OR PICK UP
            </span>
            {recentChats.map((chat) => {
              const legacy =
                chat.origin === "run" ? legacyRunThreadTitle(chat.title, chat.run_link) : null;
              const title = legacy ? legacy.title : chat.title;
              const preview = previewLine(chat.last_agent_line);
              return (
                <Link
                  key={chat.id}
                  to={routes.chat(chat.id, scope)}
                  data-testid={`new-chat-recent-${chat.id}`}
                  className="flex items-center gap-[12px] rounded-[8px] border border-line-soft px-[12px] py-[10px] hover:border-line-strong hover:bg-rail focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <IconArrowBackUp
                    size={14}
                    stroke={1.5}
                    className="shrink-0 text-accent-edge"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">
                      {title}
                    </span>
                    {preview ? (
                      <span className="block truncate text-[12.5px] text-muted">{preview}</span>
                    ) : null}
                  </span>
                  {scope ? null : (
                    <span
                      data-testid={`new-chat-recent-project-${chat.id}`}
                      className="max-w-[140px] shrink-0 truncate font-mono text-[11px] text-muted"
                    >
                      {projectNameOf(chat.project_id)}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    {formatAge(chat.updated_at)}
                  </span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
