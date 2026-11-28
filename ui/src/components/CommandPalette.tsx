/**
 * Search or ask (⌘K) — redesign R6.
 *
 * Opens via `openPalette()` (TopBar's "Search or ask" field), `PALETTE_OPEN_EVENT`,
 * or a short tap (< 500ms) of ⌘K / Ctrl+K via `useHoldToTalk`. Holding ⌘K for
 * 500ms opens Quick chat and starts dictation instead of opening the palette.
 */
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useQueries } from "@tanstack/react-query";
import {
  IconBrandGithub,
  IconBuildingFactory2,
  IconFolder,
  IconFolders,
  IconKey,
  IconMessage,
  IconPlayerPlay,
  IconRobot,
  IconSearch,
  IconServer,
  IconSparkles,
  IconSunrise,
  IconUsers,
} from "@tabler/icons-react";
import { apiFetch } from "../api/client";
import { useHomeConversations } from "../api/home";
import { openAssistantPopover } from "./assistant/AssistantPopover";
import { dispatchHoldAction } from "./assistant/askControl";
import { useHoldToTalk } from "./assistant/HoldToTalk";
import { useDraftAskHandler } from "../lib/draftAsk";
import { isSpeechAvailable, useSpeechPrefs, useSpeechStatus } from "./assistant/useDictation";
import { queryKeys, useAgentProfiles, useProjects } from "../api/queries";
import { usePipelines } from "../api/pipelines";
import { shortId } from "../api/names";
import { routes } from "../lib/routes";
import type { RunSummaryList } from "../api/types";

export type PaletteKind = "page" | "project" | "chat" | "workflow" | "run" | "agent";

export interface PaletteItem {
  id: string;
  group: "Pages" | "Projects" | "Chats" | "Workflows" | "Recent runs" | "Agents";
  kind: PaletteKind;
  label: string;
  /** Mono/searchable metadata — searchable alongside the label. */
  secondary: string;
  to: string;
  icon?: typeof IconSearch;
}

/** Kept for legacy `Sidebar.tsx` imports while the old file stays in tree. */
export const CATCH_UP_PATH = "/catch-up";

const PAGES: PaletteItem[] = [
  {
    id: "page-home",
    group: "Pages",
    kind: "page",
    label: "Home",
    secondary: "page · home · overview · approvals",
    to: routes.scopeHome(),
    icon: IconSunrise,
  },
  {
    id: "page-chats",
    group: "Pages",
    kind: "page",
    label: "Chats",
    secondary: "page · chats · conversations",
    to: routes.chats(),
    icon: IconMessage,
  },
  {
    id: "page-factory",
    group: "Pages",
    kind: "page",
    label: "Factory",
    secondary: "page · factory · workflows · pipelines",
    to: routes.factory(),
    icon: IconBuildingFactory2,
  },
  {
    id: "page-manage-projects",
    group: "Pages",
    kind: "page",
    label: "Manage · Projects",
    secondary: "page · manage · projects",
    to: routes.manage("projects"),
    icon: IconFolders,
  },
  {
    id: "page-manage-repositories",
    group: "Pages",
    kind: "page",
    label: "Manage · Repositories",
    secondary: "page · manage · repositories · repos",
    to: routes.manage("repositories"),
    icon: IconBrandGithub,
  },
  {
    id: "page-manage-people",
    group: "Pages",
    kind: "page",
    label: "Manage · People & access",
    secondary: "page · manage · people · members · access",
    to: routes.manage("people"),
    icon: IconUsers,
  },
  {
    id: "page-manage-runners",
    group: "Pages",
    kind: "page",
    label: "Manage · Runners",
    secondary: "page · manage · runners · workers · replicas",
    to: routes.manage("runners"),
    icon: IconServer,
  },
  {
    id: "page-manage-agents",
    group: "Pages",
    kind: "page",
    label: "Manage · Agents & models",
    secondary: "page · manage · agents · models · profiles · assistant",
    to: routes.manage("agents"),
    icon: IconRobot,
  },
  {
    id: "page-manage-secrets",
    group: "Pages",
    kind: "page",
    label: "Manage · Secrets",
    secondary: "page · manage · secrets · credentials",
    to: routes.manage("secrets"),
    icon: IconKey,
  },
];

const GROUP_ORDER: PaletteItem["group"][] = [
  "Pages",
  "Projects",
  "Chats",
  "Workflows",
  "Recent runs",
  "Agents",
];

const KIND_ICONS: Record<PaletteKind, typeof IconSearch> = {
  page: IconSunrise,
  project: IconFolder,
  chat: IconMessage,
  workflow: IconBuildingFactory2,
  run: IconPlayerPlay,
  agent: IconRobot,
};

const MAX_ITEMS = 30;
const RUNS_PER_PROJECT = 5;

function matches(item: PaletteItem, needle: string): boolean {
  if (!needle) return true;
  return item.label.toLowerCase().includes(needle) || item.secondary.toLowerCase().includes(needle);
}

function usePaletteItems(): PaletteItem[] {
  const projects = useProjects();
  const conversations = useHomeConversations(20);
  const pipelines = usePipelines();
  const profiles = useAgentProfiles();
  const list = projects.data?.items ?? [];
  const chatItems = conversations.data?.items ?? [];
  const summaries = pipelines.data?.pipelines ?? [];
  const runs = useQueries({
    queries: list.map((project) => ({
      queryKey: queryKeys.runs(project.id),
      queryFn: () => apiFetch<RunSummaryList>(`/api/v1/projects/${project.id}/runs`),
    })),
  });

  return useMemo(() => {
    const projectById = new Map(list.map((project) => [project.id, project]));
    const slugOf = new Map(summaries.map((pipeline) => [pipeline.id, pipeline.slug]));
    const items: PaletteItem[] = [...PAGES];

    for (const project of list) {
      items.push({
        id: `project-${project.id}`,
        group: "Projects",
        kind: "project",
        label: project.name,
        secondary: `project · /${project.slug}`,
        to: routes.scopeHome(project.id),
      });
    }

    for (const chat of chatItems) {
      if (chat.origin === "run") continue;
      const projectName = projectById.get(chat.project_id)?.name ?? "";
      items.push({
        id: `chat-${chat.id}`,
        group: "Chats",
        kind: "chat",
        label: chat.title || "Untitled chat",
        secondary: `chat · ${projectName}`,
        to: routes.chat(chat.id, chat.project_id),
      });
    }

    for (const pipeline of summaries) {
      items.push({
        id: `pipeline-${pipeline.id}`,
        group: "Workflows",
        kind: "workflow",
        label: pipeline.display_name || pipeline.slug,
        secondary: `workflow · /${pipeline.slug}`,
        to: routes.factoryWorkflow(pipeline.id),
      });
    }

    runs.forEach((result, index) => {
      const project = list[index];
      if (!project) return;
      const recent = [...(result.data?.runs ?? [])].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      );
      for (const run of recent.slice(0, RUNS_PER_PROJECT)) {
        const slug = slugOf.get(run.pipeline_id) ?? "run";
        items.push({
          id: `run-${run.id}`,
          group: "Recent runs",
          kind: "run",
          label: `${slug} #${shortId(run.id)}`,
          secondary: `recent run · ${project.name} · ${run.status}`,
          to: routes.run(run.id),
        });
      }
    });

    for (const profile of profiles.data?.items ?? []) {
      items.push({
        id: `agent-${profile.id}`,
        group: "Agents",
        kind: "agent",
        label: profile.name,
        secondary: `agent profile · ${profile.launcher_id}`,
        to: routes.manage("agents", profile.id),
      });
    }

    return items;
  }, [list, chatItems, summaries, runs, profiles.data]);
}

export interface CommandPaletteProps {
  context: string;
  className?: string;
}

function commandKeyHint(): string {
  const platform = `${navigator.platform} ${navigator.userAgent}`;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}

export const PALETTE_OPEN_EVENT = "communication:palette-open";

export function openPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
}

export default function CommandPalette({ context, className = "" }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const speechPrefs = useSpeechPrefs();
  const speechStatus = useSpeechStatus();
  const speechAvailable = isSpeechAvailable(speechStatus, speechPrefs);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
  }, []);

  useHoldToTalk({
    speechAvailable,
    onTap: () => setOpen(true),
    onHoldStart: () => {
      setOpen(false);
      dispatchHoldAction("start");
    },
    onHoldEnd: () => {
      dispatchHoldAction("stop");
    },
    onHoldCancel: () => {
      dispatchHoldAction("cancel");
    },
  });

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const dialog = panel.current?.querySelector('[role="dialog"]');
      if (wrap.current?.contains(target) || dialog?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrap} className={`relative flex min-w-0 items-center ${className}`}>
      <button
        ref={trigger}
        type="button"
        data-testid="ask-box"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Search or ask — current section ${context}`}
        onClick={() => (open ? close() : setOpen(true))}
        className="hidden h-[30px] w-[240px] items-center gap-[6px] rounded-[4px] border border-line-strong bg-surface px-[8px] text-left font-mono text-[11.5px] text-faint hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent sm:flex"
      >
        <span className="shrink-0 rounded-[3px] bg-accent-tint px-[5px] py-[1px] text-[10px] text-accent-text">
          {context}
        </span>
        <span className="truncate">Search or ask…</span>
        <span className="ml-auto shrink-0 tracking-[.04em]">{commandKeyHint()}</span>
      </button>
      {open
        ? createPortal(
            <div ref={panel} data-testid="palette-root">
              <div
                aria-hidden="true"
                data-testid="palette-backdrop"
                className="fixed inset-0 z-40 bg-ink/20"
              />
              <PalettePanel onClose={close} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function PalettePanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [userMoved, setUserMoved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const items = usePaletteItems();

  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const results = useMemo(
    () => (needle ? items.filter((item) => matches(item, needle)) : items).slice(0, MAX_ITEMS),
    [items, needle],
  );

  const asking = needle.length > 0;
  const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const hasPrefixMatch =
    needle.length > 0 && results.some((item) => item.label.toLowerCase().startsWith(needle));
  const askIsDefault =
    asking &&
    (results.length === 0 || trimmed.endsWith("?") || (wordCount >= 4 && !hasPrefixMatch));

  const askIndex = results.length;
  const rowCount = results.length + (asking ? 1 : 0);
  const defaultIndex = askIsDefault ? askIndex : 0;
  const currentActive =
    rowCount === 0 ? 0 : Math.min(userMoved ? active : defaultIndex, rowCount - 1);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const go = (item: PaletteItem) => {
    onClose();
    navigate(item.to);
  };

  // 1d: on the editor the ask row changes the open workflow (a proposal shown
  // as ghost steps); ⌘↵ still asks the assistant a question.
  const draftAsk = useDraftAskHandler();
  const askAssistant = (plain = false) => {
    if (!trimmed) return;
    if (draftAsk && !plain) draftAsk(trimmed);
    else openAssistantPopover(trimmed);
    onClose();
  };

  const moveActive = (next: number) => {
    setUserMoved(true);
    setActive(next);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      askAssistant(true);
      return;
    }
    if (rowCount === 0) return;
    const last = rowCount - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(currentActive >= last ? 0 : currentActive + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(currentActive <= 0 ? last : currentActive - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveActive(last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (asking && currentActive === askIndex) {
        askAssistant();
        return;
      }
      const item = results[currentActive];
      if (item) go(item);
    }
  };

  const groups = GROUP_ORDER.map((name) => ({
    name,
    entries: results
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.group === name),
  })).filter((group) => group.entries.length > 0);

  const activeId = rowCount > 0 ? `palette-option-${currentActive}` : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search or ask"
      className="fixed left-1/2 top-[84px] z-50 flex max-h-[calc(100dvh-100px)] w-[min(620px,calc(100vw-16px))] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] border border-line-strong bg-surface shadow-[var(--shadow-modal)]"
    >
      <div className="flex h-[48px] shrink-0 items-center gap-[10px] border-b border-line px-[14px]">
        <IconSearch size={17} stroke={1.5} aria-hidden className="shrink-0 text-muted" />
        <input
          ref={input}
          data-testid="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="Search or ask"
          placeholder="Search or ask…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setUserMoved(false);
          }}
          onKeyDown={onInputKeyDown}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none"
        />
        <kbd className="shrink-0 rounded-[6px] border border-line bg-paper px-[6px] py-[2px] font-mono text-[10.5px] text-muted">
          esc
        </kbd>
      </div>

      <ul
        id="palette-listbox"
        role="listbox"
        aria-label="Search results"
        className="min-h-0 flex-1 overflow-y-auto p-[6px]"
      >
        {groups.map((group) => (
          <Fragment key={group.name}>
            <li
              role="presentation"
              className="px-[10px] pt-[8px] pb-[4px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted"
            >
              {group.name}
            </li>
            {group.entries.map(({ item, index }) => {
              const Icon = item.icon ?? KIND_ICONS[item.kind];
              const isActive = index === currentActive;
              return (
                <li
                  key={item.id}
                  id={`palette-option-${index}`}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => moveActive(index)}
                  onClick={() => go(item)}
                  className={`flex h-[38px] cursor-pointer items-center gap-[10px] rounded-[8px] px-[10px] hover:bg-fill ${
                    isActive ? "bg-accent-wash" : ""
                  }`}
                >
                  <Icon size={16} stroke={1.5} aria-hidden className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                    {item.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{item.kind}</span>
                </li>
              );
            })}
          </Fragment>
        ))}

        {results.length === 0 ? (
          <li
            role="presentation"
            data-testid="palette-empty"
            className="px-[10px] py-[10px] font-mono text-[11px] text-faint"
          >
            Nothing matches “{query}”.
          </li>
        ) : null}

        {asking ? (
          <li
            id={`palette-option-${askIndex}`}
            role="option"
            aria-selected={currentActive === askIndex}
            data-testid="palette-ask"
            onMouseEnter={() => moveActive(askIndex)}
            onClick={() => askAssistant()}
            className={`mt-[2px] flex h-[38px] cursor-pointer items-center gap-[10px] rounded-[8px] px-[10px] hover:bg-fill ${
              currentActive === askIndex ? "bg-accent-wash" : ""
            }`}
          >
            <IconSparkles size={16} stroke={1.5} aria-hidden className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
              {draftAsk ? "Change this workflow: " : "Ask: "}
              {`\u201C${trimmed}\u201D`}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">↵</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
