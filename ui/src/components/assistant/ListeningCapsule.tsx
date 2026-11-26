/**
 * Dark listening capsule shown above Quick chat's footer while dictation records,
 * transcribes, or displays the brief empty-transcript notice ("Didn't catch that.").
 */
import type { DictationPhase } from "./useDictation";

export interface ListeningCapsuleProps {
  phase: DictationPhase;
  /** Live transcript captured so far (or empty while waiting for speech / server). */
  liveTranscript?: string;
  /** Optional configured speech model name shown while transcribing. */
  model?: string | null;
  /** Transient notice (e.g. "Didn't catch that." for 2s). */
  notice?: string | null;
  onStop: () => void;
  className?: string;
}

export default function ListeningCapsule({
  phase,
  liveTranscript = "",
  model = null,
  notice = null,
  onStop,
  className = "",
}: ListeningCapsuleProps) {
  const recording = phase === "recording";
  const transcribing = phase === "transcribing";
  if (!recording && !transcribing && !notice) return null;

  const label = notice
    ? notice
    : transcribing
      ? model
        ? `Transcribing · ${model}…`
        : "Transcribing…"
      : liveTranscript.trim() || "Listening…";

  return (
    <>
      <style>{`
        @keyframes quick-chat-listening-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.45; transform: scale(0.8); }
        }
        .quick-chat-listening-dot {
          animation: quick-chat-listening-pulse 1.2s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .quick-chat-listening-dot {
            animation: none;
            opacity: 1;
            transform: none;
          }
        }
      `}</style>
      <div
        data-testid="listening-capsule"
        role="status"
        aria-live="polite"
        className={`mx-[12px] mb-[8px] flex items-center gap-[10px] rounded-full bg-ink px-[14px] py-[8px] text-[13px] text-surface ${className}`}
      >
        <span
          aria-hidden="true"
          data-testid="listening-capsule-dot"
          className={`h-[8px] w-[8px] shrink-0 rounded-full bg-[#f0a93a] ${
            recording ? "quick-chat-listening-dot" : ""
          }`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {recording ? (
          <button
            type="button"
            data-testid="listening-capsule-stop"
            onClick={onStop}
            className="ml-auto shrink-0 cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-semibold text-surface hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
          >
            Stop
          </button>
        ) : null}
      </div>
    </>
  );
}
