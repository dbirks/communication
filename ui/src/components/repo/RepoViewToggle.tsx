/**
 * The repo page's List | Lanes segmented control (design 3a header): the
 * active segment is ink-filled with paper text. Both arms are built — Lanes
 * is the 3b board of four lanes. The choice is remembered per repository in
 * lib/prefs (the layout `expanded` map: the server's layout section is
 * closed, the map is open).
 */
import { useRepoView, type RepoView } from "../../lib/prefs";

export interface RepoViewToggleProps {
  repositoryName: string;
}

const VIEWS: { id: RepoView; label: string }[] = [
  { id: "list", label: "List" },
  { id: "lanes", label: "Lanes" },
];

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
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={active}
            onClick={() => setView(entry.id)}
            className={`px-[12px] py-[5px] font-mono text-[11px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              active ? "bg-ink font-semibold text-paper" : "bg-surface text-ink-2 hover:bg-fill"
            }`}
            data-testid={`repo-view-${entry.id}`}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
