/**
 * PALETTE-A — the quick-jump half of the app bar's Ask box (the ask half is
 * the assistant popover, `assistant/AssistantPopover.tsx`, since ADR-0050).
 *
 * The jump list lists only surfaces the user can already see — the app-shell
 * pages (home, inbox, board, threads, settings, plus every section), projects
 * and their sub-pages, library pipelines, recent runs, agent profiles. The Ask row no longer posts to the v1 broker: it hands the
 * question to the assistant popover (which carries it over and sends it) and
 * gets out of the way. ⌘K belongs to the popover; the palette opens from
 * `openPalette()` — the popover's ⌘K-while-open path and, on the phone,
 * the sidebar.
 */
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { openAssistantPopover } from "./assistant/AssistantPopover";
import { queryKeys, useAgentProfiles, useProjects } from "../api/queries";
import { usePipelines } from "../api/pipelines";
import { shortId } from "../api/names";
import { routes } from "../lib/routes";
import type { RunSummaryList } from "../api/types";

export interface PaletteItem {
  id: string;
  group: "Pages" | "Projects" | "Pipelines" | "Recent runs" | "Agents";
  label: string;
  /** Mono secondary line — what the jump is, and searchable like the label. */
  secondary: string;
  to: string;
}

/** The app-shell pages and sections, in the app bar's own order. */
const PAGES: PaletteItem[] = [
  {
    id: "page-home",
    group: "Pages",
    label: "Home",
    secondary: "page · overview",
    to: routes.home(),
  },
  {
    id: "page-inbox",
    group: "Pages",
    label: "Inbox",
    secondary: "page · approvals · decisions",
    to: routes.inbox(),
  },
  {
    id: "page-board",
    group: "Pages",
    label: "Board",
    secondary: "page · kanban · runs board",
    to: routes.board(),
  },
  {
    id: "page-threads",
    group: "Pages",
    label: "Threads",
    secondary: "page · one-off conversations",
    to: routes.threads(),
  },
  {
    id: "page-projects",
    group: "Pages",
    label: "Projects",
    secondary: "page · all projects",
    to: routes.projects(),
  },
  {
    id: "page-library",
    group: "Pages",
    label: "Library",
    secondary: "page · pipeline library",
    to: routes.workflows(),
  },
  {
    id: "page-steps",
    group: "Pages",
    label: "Steps",
    secondary: "page · node templates",
    to: routes.steps(),
  },
  {
    id: "page-agents",
    group: "Pages",
    label: "Agents",
    secondary: "page · agent profiles",
    to: routes.profiles(),
  },
  {
    id: "page-ops",
    group: "Pages",
    label: "Operations",
    secondary: "page · replicas and workers",
    to: routes.ops(),
  },
  {
    id: "page-settings",
    group: "Pages",
    label: "Settings",
    secondary: "page · preferences · trust level",
    to: routes.settings(),
  },
];

/** Each project's own sub-pages, so a jump lands on the tab and not the root. */
const SUB_PAGES = [
  { path: "runs", label: "Runs", hint: "project runs" },
  { path: "pipelines", label: "Pipelines", hint: "project pipelines" },
  { path: "settings", label: "Settings", hint: "project settings" },
] as const;

const GROUP_ORDER: PaletteItem["group"][] = [
  "Pages",
  "Projects",
  "Pipelines",
  "Recent runs",
  "Agents",
];

/** A palette that lists everything is a scroll, not a jump. */
const MAX_ITEMS = 30;

/** Newest five runs per project — the palette shows recent work, not history. */
const RUNS_PER_PROJECT = 5;

/** Case-insensitive substring on the label *and* the secondary line. */
function matches(item: PaletteItem, needle: string): boolean {
  if (!needle) return true;
  return item.label.toLowerCase().includes(needle) || item.secondary.toLowerCase().includes(needle);
}

/**
 * Every jump target the user can already see. Runs come from a `useQueries`
 * fan over the project list on the same cache keys `useProjectRuns` reads
 * (a hook per project is impossible for a list of changing length, and the
 * fan is what `pages/Inbox.tsx` already does for the same aggregate).
 */
function usePaletteItems(): PaletteItem[] {
  const projects = useProjects();
  const pipelines = usePipelines();
  const profiles = useAgentProfiles();
  const list = projects.data?.items ?? [];
  const summaries = pipelines.data?.pipelines ?? [];
  const runs = useQueries({
    queries: list.map((project) => ({
      queryKey: queryKeys.runs(project.id),
      queryFn: () => apiFetch<RunSummaryList>(`/api/v1/projects/${project.id}/runs`),
    })),
  });

  return useMemo(() => {
    const slugOf = new Map(summaries.map((pipeline) => [pipeline.id, pipeline.slug]));
    const items: PaletteItem[] = [...PAGES];

    for (const project of list) {
      items.push({
        id: `project-${project.id}`,
        group: "Projects",
        label: project.name,
        secondary: `project · /${project.slug}`,
        to: routes.project(project.id),
      });
      for (const sub of SUB_PAGES) {
        items.push({
          id: `project-${project.id}-${sub.path}`,
          group: "Projects",
          label: `${project.name} · ${sub.label}`,
          secondary: `project · ${sub.hint}`,
          to: routes.projectTab(project.id, sub.path),
        });
      }
    }

    for (const pipeline of summaries) {
      items.push({
        id: `pipeline-${pipeline.id}`,
        group: "Pipelines",
        label: pipeline.display_name || pipeline.slug,
        secondary: `pipeline · /${pipeline.slug}`,
        to: routes.workflow(pipeline.id),
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
        label: profile.name,
        secondary: `agent profile · ${profile.launcher_id}`,
        to: routes.profile(profile.id),
      });
    }

    return items;
  }, [list, summaries, runs, profiles.data]);
}

export interface CommandPaletteProps {
  /** Section name in the box's context chip (design 6a: "inbox"). */
  context: string;
}

/** The popover's ⌘K-while-open path opens the jump palette this way. */
export const PALETTE_OPEN_EVENT = "communication:palette-open";

export function openPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
}

/**
 * The outer half is the box and the ways out. The panel mounts *only while
 * open*, so the app bar costs a page no read of its own: the project list, the
 * run fan and the profile read start when the user asks to jump, not on every
 * mount of the shell. `Cmd/Ctrl+K` is bound on the window rather than on the
 * box, because below `sm` the box is hidden and the shortcut is not.
 */
export default function CommandPalette({ context }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    // Focus goes back to whatever opened the palette, never to the body. When
    // the box is display:none below `sm` this is a no-op, which is honest.
    trigger.current?.focus();
  };

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
  }, []);

  // A press outside the box and the panel closes it.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div ref={wrap} className="relative flex min-w-0 items-center">
      <button
        ref={trigger}
        type="button"
        data-testid="ask-box"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Ask or jump — current section ${context}`}
        onClick={() => (open ? close() : setOpen(true))}
        className="hidden h-[30px] w-[240px] items-center gap-[6px] rounded-[4px] border border-line-strong bg-surface px-[8px] text-left font-mono text-[11.5px] text-faint hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent sm:flex"
      >
        <span className="shrink-0 rounded-[3px] bg-accent-tint px-[5px] py-[1px] text-[10px] text-accent-text">
          {context}
        </span>
        <span className="truncate">Ask…</span>
        <span className="ml-auto shrink-0 tracking-[.04em]">Ctrl K</span>
      </button>
      {open ? (
        <>
          <div
            aria-hidden="true"
            data-testid="palette-backdrop"
            className="fixed inset-0 z-30 bg-ink/25"
          />
          <PalettePanel onClose={close} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The panel owns its query and its caret, so every open starts empty and the
 * reads behind the list exist only while the list is on screen.
 */
function PalettePanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const items = usePaletteItems();

  const needle = query.trim().toLowerCase();
  const results = useMemo(
    () => (needle ? items.filter((item) => matches(item, needle)) : items).slice(0, MAX_ITEMS),
    [items, needle],
  );

  // A question exists as soon as there is text, so the Ask row leads the caret
  // order from the first keystroke.
  const asking = needle.length > 0;
  const offset = asking ? 1 : 0;
  const rowCount = results.length + offset;

  // Opening means typing — the input takes focus, so the first keystroke is a
  // filter and not a scroll of the page behind it.
  useEffect(() => {
    input.current?.focus();
  }, []);

  // Refetches and filtering shrink the list; the caret may not fall off the end.
  useEffect(() => {
    setActive((current) => (rowCount === 0 ? 0 : Math.min(current, rowCount - 1)));
  }, [rowCount]);

  const go = (item: PaletteItem) => {
    onClose();
    navigate(item.to);
  };

  /** One turn belongs to the assistant popover: hand the question over (it
   * carries it into the popover and sends it) and get out of the way. */
  const askAssistant = () => {
    openAssistantPopover(needle);
    onClose();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      askAssistant();
      return;
    }
    if (rowCount === 0) return;
    const last = rowCount - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current >= last ? 0 : current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current <= 0 ? last : current - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (offset === 1 && active === 0) {
        askAssistant();
        return;
      }
      const item = results[active - offset];
      if (item) go(item);
    }
  };

  const groups = GROUP_ORDER.map((name) => ({
    name,
    entries: results
      .map((item, index) => ({ item, index: index + offset }))
      .filter(({ item }) => item.group === name),
  })).filter((group) => group.entries.length > 0);

  const activeId = rowCount > 0 ? `palette-option-${active}` : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Jump to"
      className="absolute right-0 top-[calc(100%+8px)] z-40 w-[min(560px,calc(100vw-24px))] overflow-hidden rounded-[4px] border border-ink bg-surface shadow-raised"
    >
      <div className="border-b border-line px-[10px]">
        <input
          ref={input}
          data-testid="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="Jump to"
          placeholder="Ask… or type to jump"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
          className="w-full bg-transparent py-[10px] font-mono text-[12.5px] text-ink placeholder:text-faint focus:outline-none"
        />
      </div>

      <ul
        id="palette-listbox"
        role="listbox"
        aria-label="Jump targets"
        className="max-h-[320px] overflow-y-auto py-[4px]"
      >
        {asking ? (
          <li
            id="palette-option-0"
            role="option"
            aria-selected={active === 0}
            data-testid="palette-ask"
            onMouseEnter={() => setActive(0)}
            onClick={askAssistant}
            className={`flex cursor-pointer items-baseline gap-[8px] px-[10px] py-[6px] hover:bg-fill ${
              active === 0 ? "bg-accent-wash" : ""
            }`}
          >
            <span className="truncate text-[13px] text-ink">Ask: {query.trim()}</span>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">Enter</span>
          </li>
        ) : null}
        {groups.map((group) => (
          <Fragment key={group.name}>
            <li
              role="presentation"
              className="px-[10px] pb-[3px] pt-[6px] font-mono text-[10px] uppercase tracking-[.06em] text-faint"
            >
              {group.name}
            </li>
            {group.entries.map(({ item, index }) => (
              <li
                key={item.id}
                id={`palette-option-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item)}
                className={`flex cursor-pointer items-baseline gap-[8px] px-[10px] py-[6px] hover:bg-fill ${
                  index === active ? "bg-accent-wash" : ""
                }`}
              >
                <span className="truncate text-[13px] text-ink">{item.label}</span>
                <span className="ml-auto shrink-0 truncate font-mono text-[10.5px] text-faint">
                  {item.secondary}
                </span>
              </li>
            ))}
          </Fragment>
        ))}
        {results.length === 0 ? (
          <li
            role="presentation"
            data-testid="palette-empty"
            className="px-[10px] py-[10px] font-mono text-[11px] text-faint"
          >
            Nothing to jump to for “{query}”.
          </li>
        ) : null}
      </ul>

      <p
        data-testid="palette-footer"
        className="border-t border-line bg-paper px-[10px] py-[6px] font-mono text-[10.5px] text-muted"
      >
        The Ask row opens the assistant popover · the list below is quick jumps.
      </p>
    </div>
  );
}
