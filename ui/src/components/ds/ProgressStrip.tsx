import { SEGMENT_COLOR, STATES, type StateName } from "./states";

/**
 * PROGRESS-J (run header strip) and PROGRESS-K (per-stage rows). Flat state
 * colors, no texture; counts always accompany the segments (rule 06: state
 * is never color-only).
 */

export interface ProgressSegment {
  /** Segment kind: done | running | waiting | failed | interrupted | open. */
  kind: keyof typeof SEGMENT_COLOR;
  count: number;
  /** Word for screen readers and the count line; defaults to the kind. */
  word?: string;
}

export interface ProgressStage {
  /** Mono stage label, e.g. "implement". */
  label: string;
  /** State glyph for a whole-stage cell (J); `pending` renders "–". */
  state?: StateName | "pending";
  /** Present on the active cell: the segmented bar + counts. */
  segments?: ProgressSegment[];
  /** Free-form mono count line shown above the bar, e.g. "implement ×214". */
  detail?: string;
  active?: boolean;
}

export interface ProgressStripProps {
  stages: ProgressStage[];
  className?: string;
  /** "J" = run-header strip of cells; "K" = per-stage bars. */
  variant?: "J" | "K";
}

function bar(segments: ProgressSegment[], height: string, radius: string) {
  return (
    <div
      className={`flex ${height} ${radius} overflow-hidden`}
      role="img"
      aria-label={segments
        .map((segment) => `${segment.count} ${segment.word ?? segment.kind}`)
        .join(", ")}
    >
      {segments.map((segment) => (
        <span
          key={segment.kind}
          className={SEGMENT_COLOR[segment.kind]}
          style={{ flexGrow: segment.count, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

export function ProgressStrip({ stages, className = "", variant = "J" }: ProgressStripProps) {
  if (variant === "K") {
    return (
      <div
        className={`grid grid-cols-[80px_minmax(0,1fr)_90px] gap-x-3 gap-y-2 font-mono text-[11px] text-ink-2 ${className}`}
      >
        {stages.map((stage) => (
          <StageRow key={stage.label} stage={stage} />
        ))}
      </div>
    );
  }
  return (
    <div
      className={`flex items-stretch overflow-hidden rounded-[3px] border border-ink bg-surface ${className}`}
    >
      {stages.map((stage, index) => (
        <div
          key={stage.label}
          className={`flex flex-col gap-[3px] px-[11px] py-[7px] ${
            stage.active ? "flex-1 bg-accent-wash" : "shrink-0"
          } ${index < stages.length - 1 ? "border-r border-line" : ""}`}
        >
          <span className="font-mono text-[10px] text-faint">{stage.label}</span>
          {stage.segments ? (
            <>
              <span className="font-mono text-[10px] text-accent-text">{stage.detail}</span>
              {bar(
                stage.segments,
                "h-[7px]",
                "rounded-[1px] shadow-[inset_0_0_0_0.5px_var(--color-ink)]",
              )}
            </>
          ) : (
            <span className="text-[12.5px] font-semibold">
              {stage.state && stage.state !== "pending" ? (
                <span>
                  <span aria-hidden="true">{STATES[stage.state].glyph}</span>
                  <span className="sr-only">{STATES[stage.state].word}</span>
                </span>
              ) : (
                <span className="text-faint" aria-hidden="true">
                  –
                </span>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function StageRow({ stage }: { stage: ProgressStage }) {
  const counts = (stage.segments ?? [])
    .map((segment) => `${segment.count} ${segment.word ?? segment.kind}`)
    .join(" · ");
  return (
    <>
      <span>{stage.label}</span>
      {bar(stage.segments ?? [], "h-[10px]", "rounded-[2px] border border-ink")}
      <span className="text-right">{stage.detail ?? counts}</span>
    </>
  );
}
