/**
 * IssuePicker — the `github_issue` widget of the run-by-hand form (design 1k):
 * a SEARCHABLE picker over the repository's open issues, not a number field.
 *
 * The rows carry what the design's rows carry: `#415` mono, the title, the
 * repo, and “● run in progress” when the issue already has a live run. That
 * badge's source is the same fact the repo page reads (ADR-0056/0064): a run
 * whose `trigger.kind = issue` with `trigger.ref = owner/repo#<n>` that has
 * not finished. When the caller has no run list (or the read failed) the
 * badge is simply absent — a missing fact, never a wrong one.
 *
 * Search is client-side over the read: GitHub's anonymous budget is per IP
 * and a keystroke per request is how the old form got rate-limited. The list
 * is the open issues the API already served; typing filters them.
 */
import { useMemo, useState } from "react";
import { isGitHubRepository, useRepoIssues, type GitHubIssue } from "../../../api/issues";
import { useProjectRuns } from "../../../api/runs";
import { ProblemBanner, Spinner } from "../../Feedback";
import { Input } from "../../ds/Field";

/** The statuses that no longer count as “a run in progress” — the same set
 * the repo page compares against when it badges an issue row. */
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"]);

export interface IssueSelection {
  issue: GitHubIssue;
  /** The `owner/repo` the issue came from — the wire's `repo` member. */
  repository: string;
}

export interface IssuePickerProps {
  projectId: string;
  /** The repository whose tracker is searched; null when the workflow names
   * none (a project-wide pin) — the picker then says so rather than asking a
   * tracker it cannot name. */
  repository: { id: string; git_url: string; name: string } | null;
  id: string;
  value: IssueSelection | undefined;
  invalid?: boolean;
  onSelect: (value: IssueSelection) => void;
}

/** The issue numbers with a run started FROM them that has not finished —
 * the repo page's `activeIssueRuns` rule, read off the ADR-0056/0064 trigger
 * pair the runs list really carries. No runs, no repository echo, no badge. */
export function activeIssueRunNumbers(
  runs: readonly { trigger?: { kind?: string; ref?: string | null }; status: string }[] | undefined,
  repository: string | undefined,
): Set<number> {
  const active = new Set<number>();
  if (!runs || !repository) return active;
  const prefix = `${repository}#`;
  for (const run of runs) {
    const trigger = run.trigger;
    if (!trigger || trigger.kind !== "issue" || !trigger.ref) continue;
    if (!trigger.ref.startsWith(prefix)) continue;
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    const number = Number(trigger.ref.slice(prefix.length));
    if (Number.isInteger(number) && number > 0) active.add(number);
  }
  return active;
}

export function IssuePicker({
  projectId,
  repository,
  id,
  value,
  invalid = false,
  onSelect,
}: IssuePickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const github = repository !== null && isGitHubRepository(repository.git_url);
  const issues = useRepoIssues(projectId, repository?.id ?? "", "", github);
  // The badge's source is the project's own run list — the same read the
  // project pages make, so it rides one cache entry; a failed read simply
  // omits the badge rather than guessing.
  const runs = useProjectRuns(projectId);
  const active = activeIssueRunNumbers(runs.data?.runs, issues.data?.repository);

  const visible = useMemo(() => {
    const items = issues.data?.items ?? [];
    const needle = query.trim().toLowerCase().replace(/^#/, "");
    if (needle === "") return items;
    if (/^\d+$/.test(needle))
      return items.filter((issue) => String(issue.number).startsWith(needle));
    return items.filter((issue) => issue.title.toLowerCase().includes(needle));
  }, [issues.data, query]);

  if (repository === null) {
    return (
      <p className="font-mono text-[11px] text-faint" data-testid={`${id}-no-repo`}>
        this workflow is not pinned to one repository — there is no tracker to pick an issue from
      </p>
    );
  }
  if (!github) {
    return (
      <p className="font-mono text-[11px] text-faint" data-testid={`${id}-not-github`}>
        {`${repository.name} is not a GitHub repository — there is no issue to pick`}
      </p>
    );
  }

  return (
    <div data-testid={`${id}-picker`}>
      <div className="relative">
        <Input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          autoComplete="off"
          placeholder="#41"
          value={open ? query : value ? `#${value.issue.number}` : query}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          invalid={invalid}
          data-testid={id}
        />
        {open ? (
          <ul
            id={`${id}-list`}
            role="listbox"
            aria-label="Open issues"
            className="absolute z-20 mt-[2px] max-h-[168px] w-full overflow-auto rounded-[3px] border border-ink bg-surface py-[2px] [box-shadow:2px_2px_0_var(--color-ink)]"
            data-testid={`${id}-options`}
          >
            {issues.isPending ? (
              <li className="px-[10px] py-[4px]">
                <Spinner label="Reading GitHub" />
              </li>
            ) : null}
            {issues.isError ? (
              <li className="px-[10px] py-[4px]" data-testid={`${id}-error`}>
                <ProblemBanner error={issues.error} fallback="GitHub could not be read." />
              </li>
            ) : null}
            {issues.data && visible.length === 0 ? (
              <li
                className="px-[10px] py-[4px] font-mono text-[11px] text-muted"
                data-testid={`${id}-empty`}
              >
                {`GitHub answered ${issues.data.repository} with no open issue matching`}
              </li>
            ) : null}
            {visible.map((issue) => (
              <li key={issue.number}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value?.issue.number === issue.number}
                  className={`flex w-full items-center gap-[8px] px-[10px] py-[4px] text-left hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none ${
                    value?.issue.number === issue.number ? "bg-accent-wash" : ""
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect({ issue, repository: issues.data!.repository });
                    setOpen(false);
                  }}
                  data-testid={`${id}-option-${issue.number}`}
                >
                  <span className="shrink-0 font-mono text-[11.5px] font-semibold text-ink">
                    {`#${issue.number}`}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] text-ink"
                    title={issue.title}
                  >
                    {issue.title}
                  </span>
                  {active.has(issue.number) ? (
                    <span
                      className="shrink-0 font-mono text-[10.5px] text-accent-text"
                      data-testid={`${id}-running-${issue.number}`}
                    >
                      {"● run in progress"}
                    </span>
                  ) : null}
                  {issue.labels.length > 0 ? (
                    <span className="shrink-0 font-mono text-[10.5px] text-faint">
                      {issue.labels[0]}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
