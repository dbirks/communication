/**
 * HomePrompt — the prompt box of the redesigned Home (handoff README §2,
 * CONTRACT.md "Shared components"): ask, plan or start something.
 *
 * Submitting creates a conversation with EXACTLY the body
 * `NewConversationDialog` sends (`agent_profile_id`, `title`, optional
 * `prompt`, optional `repository`) — the typed text is the first prompt, and
 * the title is its first line — then navigates to the new chat
 * (`routes.chat(id, projectId)`). The agent chip is the shared `AgentPicker`
 * and defaults to nothing chosen, exactly as the dialog's required profile
 * select does.
 *
 * In All scope the box carries a project chip (IconFolder + the project
 * name) opening a ds `Menu` of `useProjects()`, and starts on the most
 * recently used project (localStorage key `communication.home.project`). In
 * a project scope (`projectId` given) the chip is fixed and not shown. When
 * the chosen project has more than one repository a repository chip joins
 * it; its default is the dialog's default — no repository — and picking one
 * sends its name in the create body.
 *
 * With no projects at all the box is disabled and the footer says so with a
 * link to Manage → Projects.
 */
import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { IconFolder, IconPackage, IconRobot } from "@tabler/icons-react";
import {
  useAgentProfiles,
  useCreateConversation,
  useProjects,
  useRepositories,
} from "../../api/queries";
import { AgentPicker } from "../shell/AgentPicker";
import { Menu } from "../ds/Menu";
import { PromptBox, PromptChip } from "../ds/PromptBox";
import { FormError } from "../Feedback";
import { routes } from "../../lib/routes";

/** The Home pages' most-recently-used project (All scope only). */
export const HOME_PROJECT_KEY = "communication.home.project";

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(HOME_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeStoredProject(projectId: string): void {
  try {
    localStorage.setItem(HOME_PROJECT_KEY, projectId);
  } catch {
    /* a private-mode browser keeps the default; the prompt still works */
  }
}

/** The conversation title from the typed text: its first line, capped — the
 * dialog asks for a title; here the prompt IS the intent, so its first line
 * names the chat. Nothing else is invented. */
export function titleFromPrompt(text: string): string {
  const line = text.split(/\r?\n/)[0].trim().replace(/\s+/g, " ");
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

export interface HomePromptProps {
  /** Project scope: the box is fixed to this project and shows no picker. */
  projectId?: string;
  /** Override the prompt placeholder (the project home names the project). */
  placeholder?: string;
  /** Extra chips for the bottom row (the project home's "or run a workflow"). */
  extraChips?: ReactNode;
}

export function HomePrompt({ projectId, placeholder, extraChips }: HomePromptProps) {
  const navigate = useNavigate();
  const projectsQuery = useProjects();
  const projects = projectsQuery.data?.items ?? [];

  const [storedId, setStoredId] = useState<string | null>(() => readStoredProject());
  const [repository, setRepository] = useState<string | null>(null);
  const [agentPicks, setAgentPicks] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const projectRef = useRef<HTMLButtonElement>(null);
  const repoRef = useRef<HTMLButtonElement>(null);

  // A stored project only counts while it still exists.
  const picked = storedId && projects.some((project) => project.id === storedId) ? storedId : "";
  const selectedId = projectId ?? (picked || projects[0]?.id || "");
  const selected = projects.find((project) => project.id === selectedId) ?? null;

  const profilesQuery = useAgentProfiles();
  const profiles = profilesQuery.data?.items ?? [];
  let storedAgent: string | null = null;
  try {
    storedAgent = selectedId
      ? localStorage.getItem(`communication.home.agent.${selectedId}`)
      : null;
  } catch {
    // Storage may be unavailable in private browsing.
  }
  const preferredAgent = agentPicks[selectedId] ?? storedAgent;
  // NewConversationDialog initializes its profile to ""; it has no default,
  // so fall back to the first profile.
  const profileId = selectedId
    ? (profiles.find((profile) => profile.id === preferredAgent)?.id ?? profiles[0]?.id ?? null)
    : null;
  const pickAgent = (id: string) => {
    setAgentPicks((picks) => ({ ...picks, [selectedId]: id }));
    try {
      localStorage.setItem(`communication.home.agent.${selectedId}`, id);
    } catch {
      // Keep the selection in memory when storage is unavailable.
    }
  };

  const reposQuery = useRepositories(selectedId);
  const repos = reposQuery.data?.items ?? [];
  const chosenRepo =
    repository && repos.some((repo) => repo.name === repository) ? repository : null;

  const create = useCreateConversation(selectedId);
  const noProjects = projectsQuery.isSuccess && projects.length === 0;

  const pickProject = (id: string) => {
    setStoredId(id);
    writeStoredProject(id);
    setRepository(null);
    setProjectMenuOpen(false);
  };

  const submit = (value: string) => {
    if (!selectedId || !profileId) return;
    create.mutate(
      {
        agent_profile_id: profileId,
        title: titleFromPrompt(value),
        prompt: value,
        ...(chosenRepo ? { repository: chosenRepo } : {}),
      },
      {
        onSuccess: (conversation) => {
          writeStoredProject(selectedId);
          setText("");
          navigate(routes.chat(conversation.id, selectedId));
        },
      },
    );
  };

  const footer = noProjects ? (
    <span data-testid="home-prompt-no-projects">
      Add a project to start.{" "}
      <Link
        to={routes.manage("projects")}
        className="text-accent-text underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        Add a project
      </Link>
    </span>
  ) : create.isError ? (
    <FormError error={create.error} testid="home-prompt-error" />
  ) : text !== "" && !selectedId ? (
    <span data-testid="home-prompt-need-project">Choose a project first.</span>
  ) : text !== "" && selectedId && !profileId ? (
    <span data-testid="home-prompt-need-agent">Choose an agent first.</span>
  ) : null;

  return (
    <div data-testid="home-prompt-wrap">
      <PromptBox
        testid="home-prompt"
        label="Ask, plan or start something"
        placeholder={placeholder ?? "Ask, plan or start something…"}
        value={text}
        onChange={setText}
        onSubmit={submit}
        rows={2}
        disabled={noProjects}
        busy={create.isPending || !selectedId || !profileId}
        footer={footer}
        chips={
          <>
            {projectId ? null : (
              <>
                <PromptChip
                  buttonRef={projectRef}
                  testid="home-prompt-project"
                  icon={<IconFolder size={14} stroke={1.5} aria-hidden />}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  disabled={projects.length === 0}
                  title="Choose the project"
                  onClick={() => setProjectMenuOpen((open) => !open)}
                >
                  {selected?.name ?? "Pick a project"}
                </PromptChip>
                <Menu
                  data-testid="home-prompt-project-menu"
                  open={projectMenuOpen}
                  onClose={() => setProjectMenuOpen(false)}
                  triggerRef={projectRef}
                  side="bottom"
                  width={220}
                  caption="PROJECT"
                  ariaLabel="Project"
                  items={projects.map((project) => ({
                    id: project.id,
                    label: project.name,
                    checked: project.id === selectedId,
                    testId: `home-prompt-project-option-${project.id}`,
                    onSelect: () => pickProject(project.id),
                  }))}
                />
              </>
            )}
            {chosenRepo || repos.length > 1 ? (
              <>
                <PromptChip
                  buttonRef={repoRef}
                  testid="home-prompt-repository"
                  icon={<IconPackage size={14} stroke={1.5} aria-hidden />}
                  aria-haspopup="menu"
                  aria-expanded={repoMenuOpen}
                  title="Choose the repository"
                  onClick={() => setRepoMenuOpen((open) => !open)}
                >
                  {chosenRepo ?? "No repository"}
                </PromptChip>
                <Menu
                  data-testid="home-prompt-repository-menu"
                  open={repoMenuOpen}
                  onClose={() => setRepoMenuOpen(false)}
                  triggerRef={repoRef}
                  side="bottom"
                  width={220}
                  caption="REPOSITORY"
                  ariaLabel="Repository"
                  items={[
                    {
                      id: "",
                      label: "No repository",
                      checked: chosenRepo === null,
                      testId: "home-prompt-repository-option-",
                      onSelect: () => {
                        setRepository(null);
                        setRepoMenuOpen(false);
                      },
                    },
                    ...repos.map((repo) => ({
                      id: repo.name,
                      label: repo.name,
                      checked: repo.name === chosenRepo,
                      testId: `home-prompt-repository-option-${repo.name}`,
                      onSelect: () => {
                        setRepository(repo.name);
                        setRepoMenuOpen(false);
                      },
                    })),
                  ]}
                />
              </>
            ) : null}
            {selectedId && profilesQuery.isSuccess && profiles.length === 0 ? (
              <PromptChip
                testid="home-prompt-agent"
                icon={<IconRobot size={14} stroke={1.5} aria-hidden />}
                onClick={() => navigate(routes.manage("agents"))}
              >
                No agents yet
              </PromptChip>
            ) : (
              <AgentPicker
                value={profileId}
                onChange={pickAgent}
                side="bottom"
                testid="home-prompt-agent"
                disabled={noProjects || !selectedId}
                disabledReason={noProjects ? "Add a project first" : "Choose a project first"}
              />
            )}
            {extraChips}
          </>
        }
      />
    </div>
  );
}

export default HomePrompt;
