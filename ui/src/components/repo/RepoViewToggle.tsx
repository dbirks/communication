/**
 * The repo page's List | Lanes segmented control (design 3a header): the
 * active segment is ink-filled with paper text; Lanes is NOT built yet, so
 * it renders as a disabled segment whose title says so — no fake placeholder
 * page. The choice is remembered per repository in lib/prefs (the layout
 * `expanded` map: the server's layout section is closed, the map is open).
 */
import { useRepoView, type RepoView } from "../../lib/prefs";

export interface RepoViewToggleProps {
  repositoryName: string;
}

const VIEWS: { id: RepoView; label: string }[] = [
  { id: "list", label: "List" },
  { id: "lanes", label: "Lanes" },
];

/** Lanes is the one arm not built yet — the segment shows, is disabled, and
 * says why. Flip this to `false` the day the 3b page exists. */
const LANES_BUILT = false;

export function RepoViewToggle({ repositoryName }: RepoViewToggleProps) {
  const { view, setView } = useRepoView(repositoryName);
  return (
    <div
      role="group"
      aria-label="Repository view"
      className="flex shrink-0 items-stretch overflow-hidden rounded-[4px] border border-ink"
      data-testid="repo-view-toggle"
    >
      {VIEWS.map((entry) => {
        const active = view === entry.id;
        const disabled = entry.id === "lanes" && !LANES_BUILT;
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={disabled ? "Lanes view arrives next" : undefined}
            onClick={() => setView(entry.id)}
            className={`px-[12px] py-[5px] font-mono text-[11px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              active ? "bg-ink font-semibold text-paper" : "bg-surface text-ink-2 hover:bg-fill"
            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            data-testid={`repo-view-${entry.id}`}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
