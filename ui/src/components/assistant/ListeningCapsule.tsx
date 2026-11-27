/**
 * Dark listening capsule shown above Quick chat's footer while dictation records,
 * transcribes, or displays the brief empty-transcript notice ("Didn't catch that.").
 * Sits in normal flow (never absolutely positioned) so it cannot cover the answer above it.
 */
import { IconMicrophone } from "@tabler/icons-react";
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

/** Bar heights (px) for the four-bar waveform, left to right. */
const WAVEFORM_HEIGHTS = ["6px", "12px", "16px", "9px"];

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

  const transcript = liveTranscript.trim();
  const phaseWords = notice
    ? notice
    : transcribing
      ? model
        ? `Transcribing · ${model}…`
        : "Transcribing…"
      : "Listening…";
  const label = transcript ? `“${transcript}…”` : phaseWords;

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
        @keyframes quick-chat-waveform-bar {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }
        @media (prefers-reduced-motion: no-preference) {
          .quick-chat-waveform-bar {
            transform: scaleY(0.4);
            animation: quick-chat-waveform-bar 0.9s ease-in-out infinite;
          }
          .quick-chat-waveform-bar:nth-child(2) { animation-delay: 0.15s; }
          .quick-chat-waveform-bar:nth-child(3) { animation-delay: 0.3s; }
          .quick-chat-waveform-bar:nth-child(4) { animation-delay: 0.45s; }
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
        className={`mx-[16px] mb-[8px] flex shrink-0 items-center gap-[10px] rounded-full bg-ink px-[12px] py-[8px] text-white ${className}`}
      >
        <span
          aria-hidden="true"
          data-testid="listening-capsule-dot"
          className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-accent ${
            recording ? "quick-chat-listening-dot" : ""
          }`}
        >
          <IconMicrophone size={14} stroke={1.5} aria-hidden />
        </span>
        <span
          aria-hidden="true"
          data-testid="listening-capsule-waveform"
          className="flex h-[16px] shrink-0 items-center gap-[3px]"
        >
          {WAVEFORM_HEIGHTS.map((height, i) => (
            <span
              key={i}
              // The colour class ends at a space on purpose: written flush
              // against `${`, Tailwind's scanner never saw `bg-accent-mid` and
              // the bars rendered transparent.
              className={`w-[3px] rounded-[2px] bg-accent-mid ${
                recording ? "quick-chat-waveform-bar" : ""
              }`}
              style={{ height }}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
        {recording ? (
          <button
            type="button"
            data-testid="listening-capsule-stop"
            onClick={onStop}
            className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-semibold text-white underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-white min-h-[28px] max-md:min-h-[44px]"
          >
            Stop
          </button>
        ) : null}
      </div>
    </>
  );
}
