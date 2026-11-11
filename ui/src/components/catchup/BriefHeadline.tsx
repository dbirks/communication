/**
 * The brief's HEADLINE (ADR-0081 § The model's job): the model's one or two
 * sentences over rows the server assembled, plus its per-project lines.
 *
 * Three honest states, because the headline is the ONLY part of the brief that
 * waits on a model and the sections must never wait on it:
 *
 * - `ready` — the text, at the reading size (15px), clamped to the two lines
 *   the generator is asked for, with the per-project list under it.
 * - `pending` — the generation has started and has not answered: one skeleton
 *   bar at the height the text lands at and the words `writing headline…`. A
 *   bare gap would read as "there was nothing to say".
 * - `unavailable` — no model, or the model failed: render NOTHING. An empty
 *   box claiming a headline exists would be a placeholder, and the sections
 *   below are already the answer.
 *
 * The text is model output about titles the model does not control: it is
 * drawn as text and never re-read as markup (ADR-0034).
 */
import type { CatchUpBriefHeadline, CatchUpBriefProjectLine } from "../../api/catchup";
import { BriefProjectChip } from "./BriefSection";

export function BriefHeadline({
  headline,
  byProject,
}: {
  headline: CatchUpBriefHeadline;
  /** The model's per-project lines; empty is its own answer, never a filler. */
  byProject: CatchUpBriefProjectLine[];
}) {
  if (headline.state === "unavailable") return null;

  if (headline.state === "pending") {
    return (
      <div className="flex flex-col gap-[6px]" data-testid="catchup-brief-headline-pending">
        <span className="h-[14px] w-[70%] rounded-[2px] bg-fill" aria-hidden />
        <span className="font-mono text-[10.5px] whitespace-nowrap text-faint">
          writing headline…
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[8px]" data-testid="catchup-brief-headline">
      <p className="line-clamp-2 max-w-[760px] text-[15px] leading-[22px] font-normal text-ink">
        {headline.text}
      </p>
      {byProject.length > 0 ? (
        <ul className="flex flex-col gap-[4px]" data-testid="catchup-brief-by-project">
          {byProject.map((entry) => (
            <li
              key={entry.project.id}
              className="flex min-w-0 flex-wrap items-baseline gap-x-[8px] gap-y-[2px]"
              data-testid={`catchup-brief-project-${entry.project.id}`}
            >
              <BriefProjectChip project={entry.project} />
              <span className="min-w-0 flex-1 text-[12.5px] leading-[1.45] text-ink-2">
                {entry.line}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default BriefHeadline;
