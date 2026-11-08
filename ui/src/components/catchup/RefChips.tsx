/**
 * The ref chips a catch-up header carries: every issue, PR and commit the
 * assistant named, each with its own glyph. A chip is a LINK only when the
 * server put a `url` beside the number — and that url is computed at read time
 * from the repository's own remote, never from the model's text (ADR-0078
 * § Decision 6). Without one the chip stays the label it shipped as: a number
 * the assistant claimed, with nothing to click. Shared by the piece-of-work
 * page (8b) and the tour player (7b).
 */
import type { ReactNode } from "react";
import { CircleDot, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import type { CatchUpRefs } from "../../api/catchup";

interface RefChip {
  key: string;
  icon: ReactNode;
  label: string;
  href?: string;
}

const CHIP_CLASSES =
  "inline-flex items-center gap-[4px] font-mono text-[11px] text-ink-2 whitespace-nowrap";

export function RefChips({ refs }: { refs: CatchUpRefs }) {
  const chips: RefChip[] = [];
  for (const issue of refs.issues ?? []) {
    chips.push({
      key: `issue-${issue.number}`,
      icon: <CircleDot size={12} aria-hidden />,
      label: `#${issue.number}`,
      href: issue.url,
    });
  }
  for (const pr of refs.pull_requests ?? []) {
    chips.push({
      key: `pr-${pr.number}`,
      icon: <GitPullRequest size={12} aria-hidden />,
      label: `PR #${pr.number}`,
      href: pr.url,
    });
  }
  for (const commit of refs.commits ?? []) {
    chips.push({
      key: `commit-${commit.sha}`,
      icon: <GitCommitHorizontal size={12} aria-hidden />,
      label: commit.sha.slice(0, 7),
      href: commit.url,
    });
  }
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-[8px]">
      {chips.map((chip) =>
        chip.href ? (
          <a
            key={chip.key}
            href={chip.href}
            target="_blank"
            rel="noreferrer"
            data-testid={`catchup-ref-${chip.key}`}
            className={`${CHIP_CLASSES} underline decoration-line-strong underline-offset-2`}
          >
            {chip.icon}
            {chip.label}
          </a>
        ) : (
          <span key={chip.key} data-testid={`catchup-ref-${chip.key}`} className={CHIP_CLASSES}>
            {chip.icon}
            {chip.label}
          </span>
        ),
      )}
    </span>
  );
}
