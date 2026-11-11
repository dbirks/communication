/**
 * The brief's NEEDS YOU panel (ADR-0081 § needs_you): the few things that wait
 * on THIS reader — a gate they may decide, a tour beat that asked and got no
 * answer, their own run whose newest attempt failed. It is the section the old
 * recap could not have at all, and it is the only one drawn as a panel with an
 * accent edge: this is the block the page exists to surface.
 *
 * The server's order is kept as-is. `needs_you` is sorted OLDEST first because
 * the thing that has waited longest is the thing somebody else is blocked on —
 * re-sorting it here would silently undo that.
 *
 * Each row is a link to the page where the reader answers it (the gate, the
 * beat inside its tour, the run). The `detail` line is the one sentence saying
 * what is being asked; the 40px row has no room for it, so it rides as the
 * row's own tooltip rather than as a second line that would break the grid.
 */
import { IconAlertTriangle, IconChecklist, IconMessageQuestion } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { CatchUpBriefNeed } from "../../api/catchup";
import { BriefProjectChip, shortAge } from "./BriefSection";

/** The kind's own glyph: a checklist for a gate, a question for a beat that
 * asked, a warning triangle for a run that went red on the reader's own name. */
function needIcon(kind: CatchUpBriefNeed["kind"]): ReactNode {
  if (kind === "approval") return <IconChecklist size={16} aria-hidden />;
  if (kind === "question") return <IconMessageQuestion size={16} aria-hidden />;
  return (
    <IconAlertTriangle
      size={16}
      aria-hidden
      className="text-[var(--color-seg-failed)]"
      data-testid="catchup-brief-failed-glyph"
    />
  );
}

export function BriefNeedsYou({ needs, now }: { needs: CatchUpBriefNeed[]; now?: Date }) {
  if (needs.length === 0) return null;
  return (
    <section
      data-testid="catchup-brief-needs-you"
      className="overflow-hidden rounded-[4px] border border-line border-l-[3px] border-l-accent bg-surface"
    >
      <h2 className="flex h-[32px] items-center gap-[8px] border-b border-line px-[10px] font-mono text-[10.5px] font-semibold tracking-[.06em] text-ink-2 uppercase">
        <span className="min-w-0 truncate whitespace-nowrap">needs you · {needs.length}</span>
      </h2>
      <ul>
        {needs.map((need, index) => {
          return (
            <li key={`${need.link}:${index}`}>
              <Link
                to={need.link}
                title={need.detail}
                aria-label={`${need.kind}: ${need.title}`}
                data-testid={`catchup-brief-need-${index}`}
                className="flex h-[40px] items-center gap-[8px] border-b border-line px-[10px] last:border-b-0 hover:bg-line-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span className="flex shrink-0 items-center">{needIcon(need.kind)}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{need.title}</span>
                <BriefProjectChip project={need.project} />
                <span className="shrink-0 text-right font-mono text-[11px] whitespace-nowrap text-faint">
                  {shortAge(need.at, now)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default BriefNeedsYou;
