/**
 * The filter row of the catch-up page (mock 8a): project checkbox chips and
 * the window chips. A chip is 28px tall with a 15px checkbox, the 8px project
 * square and the mono name; the selected chip gets the ink border and the 2px
 * offset shadow every raised surface in the system wears.
 */
import { Check } from "lucide-react";
import { CATCH_UP_WINDOWS, type CatchUpWindow } from "../../api/catchup";
import { projectColor, projectSquareClasses, type ProjectChip } from "./importance";

export function ProjectChips({
  projects,
  selected,
  onToggle,
}: {
  projects: ProjectChip[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-[6px]" role="group" aria-label="Projects">
      {projects.map((project) => {
        const isSelected = selected.includes(project.id);
        return (
          <button
            key={project.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onToggle(project.id)}
            data-testid={`catchup-project-chip-${project.id}`}
            className={`inline-flex h-[28px] items-center gap-[6px] rounded-[3px] border bg-surface pl-[6px] pr-[10px] font-mono text-[12px] font-medium whitespace-nowrap ${
              isSelected
                ? "border-ink shadow-[2px_2px_0_var(--color-ink)]"
                : "border-line-strong text-muted"
            }`}
          >
            <span
              className={`grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[2px] border border-ink font-mono text-[10px] font-bold ${
                isSelected ? "bg-ink text-white" : "bg-surface"
              }`}
              aria-hidden
            >
              {isSelected ? <Check size={10} strokeWidth={3} /> : null}
            </span>
            <span
              className={projectSquareClasses()}
              style={{ background: projectColor(project.color) }}
              aria-hidden
            />
            {project.name}
          </button>
        );
      })}
    </div>
  );
}

const WINDOW_LABEL: Record<CatchUpWindow, string> = {
  unseen: "unseen",
  "6h": "6h",
  "24h": "24h",
  "2d": "2d",
  "7d": "7d",
};

export function WindowChips({
  value,
  onChange,
}: {
  value: CatchUpWindow;
  onChange: (window: CatchUpWindow) => void;
}) {
  return (
    <div className="flex flex-wrap gap-[4px]" role="group" aria-label="Time window">
      {CATCH_UP_WINDOWS.map((window) => {
        const isActive = window === value;
        return (
          <button
            key={window}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(window)}
            data-testid={`catchup-window-${window}`}
            className={`rounded-tag border px-[7px] py-[2px] font-mono text-[10.5px] font-medium whitespace-nowrap ${
              isActive ? "border-ink bg-ink text-paper" : "border-line-strong bg-surface text-ink-2"
            }`}
          >
            {WINDOW_LABEL[window]}
          </button>
        );
      })}
    </div>
  );
}
