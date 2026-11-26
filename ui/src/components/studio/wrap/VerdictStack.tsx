/**
 * VerdictStack — per-round judge/goal status cards stacked beside a GoalFrame
 * while or after a Repeat-until loop runs.
 */

export type RoundVerdict = "met" | "not_yet" | "running";

export interface VerdictRound {
  n: number;
  verdict: RoundVerdict;
  reason?: string;
}

export interface VerdictStackProps {
  rounds: VerdictRound[];
  className?: string;
}

const VERDICT_META: Record<RoundVerdict, { label: string; className: string }> = {
  met: {
    label: "✓ goal met",
    className: "rounded-[6px] bg-st-done-tag px-[6px] py-[1px] text-st-done-tag-fg",
  },
  not_yet: {
    label: "× not yet",
    className: "text-st-failed-tag-fg",
  },
  running: {
    label: "● judging",
    className: "rounded-[6px] bg-st-running-tag px-[6px] py-[1px] text-st-running-tag-fg",
  },
};

export function VerdictStack({ rounds, className = "" }: VerdictStackProps) {
  return (
    <div data-testid="verdict-stack" className={`flex w-[220px] flex-col gap-[6px] ${className}`}>
      {rounds.map((round) => {
        const meta = VERDICT_META[round.verdict];
        return (
          <div
            key={round.n}
            data-testid={`verdict-round-${round.n}`}
            className="rounded-[10px] border border-line bg-surface px-[10px] py-[8px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10.5px] text-muted">Round {round.n}</span>
              <span className={`font-mono text-[10.5px] font-medium ${meta.className}`}>
                {meta.label}
              </span>
            </div>
            {round.reason ? (
              <p className="mt-[4px] text-[12.5px] leading-[17px] text-ink-2">{round.reason}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
