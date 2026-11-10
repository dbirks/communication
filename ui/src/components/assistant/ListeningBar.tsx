import { IconWaveSine } from "@tabler/icons-react";

/**
 * The dictation rows inside the composer box (handoff §5; exploration "MIC",
 * mock L341–360). They are not a bar under the composer any more — recording
 * happens IN the box, which is itself outlined in a dashed accent border while
 * the mic is open.
 *
 *   <ListeningBar seconds={7} />          — 28 accent bars + the `m:ss` clock
 *   <TranscribingRow model="qwen3-asr" /> — `transcribing · qwen3-asr…`
 *
 * The bars animate on a staggered pulse and go static under
 * `prefers-reduced-motion`. The clock is the caller's (the dictation hook owns
 * it), so a stopped recorder never leaves a row still counting.
 */
const BAR_COUNT = 28;
const BAR_DELAYS = Array.from({ length: BAR_COUNT }, (_, i) => i * 0.07);

export interface ListeningBarProps {
  /** Seconds of audio captured so far. */
  seconds: number;
  className?: string;
}

export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function ListeningBar({ seconds, className = "" }: ListeningBarProps) {
  return (
    <>
      <style>{`
        .composer-wave {
          display: flex;
          align-items: center;
          gap: 2px;
          height: 14px;
          flex: 1 1 auto;
          min-width: 0;
        }
        .composer-wave span {
          width: 3px;
          height: 100%;
          border-radius: 1px;
          background: var(--color-accent);
          animation: composer-wave-pulse 1.1s ease-in-out infinite;
        }
        @keyframes composer-wave-pulse {
          0%, 100% { transform: scaleY(0.3); }
          50% { transform: scaleY(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .composer-wave span {
            animation: none;
            transform: scaleY(0.6);
          }
        }
      `}</style>
      <div
        data-testid="listening-bar"
        role="status"
        aria-label={`Recording ${formatClock(seconds)}`}
        className={`flex items-center gap-[10px] px-[2px] pt-[2px] ${className}`}
      >
        <span className="composer-wave" aria-hidden="true">
          {BAR_DELAYS.map((delay) => (
            <span key={delay} style={{ animationDelay: `${delay}s` }} />
          ))}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
          {formatClock(seconds)}
        </span>
      </div>
    </>
  );
}

export interface TranscribingRowProps {
  /** The configured speech model's id, or "" when this server names none. */
  model: string | null;
  className?: string;
}

/** The clip is at `serve`; the mic and Send wait with it. */
export function TranscribingRow({ model, className = "" }: TranscribingRowProps) {
  return (
    <div
      data-testid="transcribing-row"
      role="status"
      className={`flex items-center gap-[6px] px-[2px] pt-[2px] font-mono text-[11px] text-accent-text ${className}`}
    >
      <IconWaveSine size={13} stroke={2} aria-hidden className="shrink-0" />
      {model ? `transcribing · ${model}…` : "transcribing…"}
    </div>
  );
}
