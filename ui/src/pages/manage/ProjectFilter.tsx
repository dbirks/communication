/**
 * The project filter three Manage sections share (redesign R7): Repositories,
 * People & access and Secrets all answer the same question — *which project?* —
 * and the answer lives in the URL as `?project=<id>`, not in component state.
 * A filter that is a chip row rather than a `<select>` is the redesign's call
 * (README §7: the sections read as a glance), but the value stays a linkable
 * one: `/manage/people?project=<id>` is what `/p/:p/members` redirects to
 * (CONTRACT "Redirects"), so a bookmark keeps working.
 *
 * "All projects" is the chip that clears the parameter — it is a real choice,
 * not the absence of one, and it is marked `aria-current` like the rest of the
 * redesign's selected chips.
 */
export interface ProjectFilterOption {
  id: string;
  name: string;
}

export interface ProjectFilterProps {
  projects: readonly ProjectFilterOption[];
  /** The selected id, or "" for All projects. */
  value: string;
  onChange: (projectId: string) => void;
  /** Secrets cannot answer for more than one project at a time. */
  allLabel?: string;
  testid?: string;
}

const CHIP_BASE =
  "inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-[6px] rounded-full border border-line bg-surface px-[11px] text-[12.5px] text-ink-2 no-underline hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const CHIP_ON = "border-ink bg-ink text-white hover:border-ink";

export function ProjectFilter({
  projects,
  value,
  onChange,
  allLabel = "All projects",
  testid = "project-filter",
}: ProjectFilterProps) {
  return (
    <div
      role="group"
      aria-label="Project"
      className="flex flex-wrap items-center gap-[6px]"
      data-testid={testid}
    >
      <button
        type="button"
        aria-current={value === "" ? "true" : undefined}
        className={`${CHIP_BASE} ${value === "" ? CHIP_ON : ""}`}
        data-testid={`${testid}-all`}
        onClick={() => onChange("")}
      >
        {allLabel}
      </button>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          aria-current={value === project.id ? "true" : undefined}
          className={`${CHIP_BASE} ${value === project.id ? CHIP_ON : ""}`}
          data-testid={`${testid}-${project.id}`}
          onClick={() => onChange(project.id)}
        >
          {project.name}
        </button>
      ))}
    </div>
  );
}
