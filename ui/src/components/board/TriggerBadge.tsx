/**
 * The trigger badge: how a run was started (ADR-0056 part 1, artboards 2d / 3c).
 * A small glyph + text badge — `⏱ scheduled`, `#<number>` for an issue start,
 * `↩ from thread` for a thread start — never colour alone, so the kind stays
 * readable for every state. The issue badge links out to the GitHub issue
 * (`https://github.com/<owner>/<repo>/issues/<N>`) when the trigger ref parses;
 * the thread badge links back to the conversation. A `manual` run carries no
 * badge and the component renders nothing for it.
 */
import { Link } from "react-router";
import { routes } from "../../lib/routes";
import type { RunTriggerBadgeState } from "./columns";

export interface RunTriggerBadgeProps {
  badge: RunTriggerBadgeState | null;
  /** Test id of the badge element (the board card wraps it in a per-run row). */
  testId?: string;
}

export function RunTriggerBadge({ badge, testId = "run-trigger-badge" }: RunTriggerBadgeProps) {
  if (!badge) return null;
  if (badge.kind === "schedule") {
    return (
      <span
        data-testid={testId}
        className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-2"
      >
        <span aria-hidden="true">⏱</span>
        <span>scheduled</span>
      </span>
    );
  }
  if (badge.kind === "issue") {
    const href = `https://github.com/${badge.owner}/${badge.repo}/issues/${badge.number}`;
    return (
      <a
        href={href}
        data-testid={testId}
        target="_blank"
        rel="noreferrer"
        title={`#${badge.owner}/${badge.repo}#${badge.number}`}
        className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-2 underline"
      >
        <span aria-hidden="true">#</span>
        <span>{badge.number}</span>
      </a>
    );
  }
  return (
    <Link
      to={routes.thread(badge.conversationId)}
      data-testid={testId}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-2 underline"
    >
      <span aria-hidden="true">↩</span>
      <span>from thread</span>
    </Link>
  );
}
