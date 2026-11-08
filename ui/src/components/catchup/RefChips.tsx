/**
 * The ref chips a catch-up header carries: every issue, PR and commit the
 * assistant named, each with its own glyph. Labels, not links — these are
 * the model's claims about the repository, not join keys (ADR-0078
 * § Decision 6). Shared by the piece-of-work page (8b) and the tour
 * player (7b).
 */
import type { ReactNode } from "react";
import { CircleDot, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import type { CatchUpRefs } from "../../api/catchup";

export function RefChips({ refs }: { refs: CatchUpRefs }) {
  const chips: { key: string; icon: ReactNode; label: string }[] = [];
  for (const issue of refs.issue_numbers ?? []) {
    chips.push({
      key: `issue-${issue}`,
      icon: <CircleDot size={12} aria-hidden />,
      label: `#${issue}`,
    });
  }
  for (const pr of refs.pr_numbers ?? []) {
    chips.push({
      key: `pr-${pr}`,
      icon: <GitPullRequest size={12} aria-hidden />,
      label: `PR #${pr}`,
    });
  }
  for (const sha of refs.commit_shas ?? []) {
    chips.push({
      key: `commit-${sha}`,
      icon: <GitCommitHorizontal size={12} aria-hidden />,
      label: sha.slice(0, 7),
    });
  }
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-[8px]">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-[4px] font-mono text-[11px] text-ink-2 whitespace-nowrap"
        >
          {chip.icon}
          {chip.label}
        </span>
      ))}
    </span>
  );
}
