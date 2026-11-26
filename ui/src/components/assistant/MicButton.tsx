import { IconMicrophone, IconPlayerStop } from "@tabler/icons-react";
import { KEEP_COMPOSER_SIZE_PX } from "./ContextButton";
import type { DictationPhase } from "./useDictation";

/**
 * The composer's mic (handoff §1/§5; mock L341–380 and the MIC section of the
 * exploration canvas): a 30px square that matches the send button beside it.
 *
 * It is ALWAYS present — including while the box holds text, because dictation
 * appends to what the person typed (handoff §5). Three looks, one per phase:
 *
 *   idle         — the fill button: `fill` on a `fill-edge` border and shadow
 *   recording    — `st-failed-strong` with the stop glyph: one tap ends it
 *   transcribing — the disabled pair: the clip is at the server, wait
 *
 * Whether audio is recorded here or transcribed by the browser is
 * `useDictation`'s business; this button only draws the phase and reports the
 * tap.
 */
export interface MicButtonProps {
  phase: DictationPhase;
  onToggle: () => void;
  /** A turn is in flight, the clip is at the server, or speech is unavailable. */
  disabled?: boolean;
  /** Shown as title/aria-label when disabled because speech is unavailable. */
  disabledReason?: string;
  /** Circular 32px redesign variant used in Quick chat. */
  circle?: boolean;
  className?: string;
}

const TITLES: Record<DictationPhase, string> = {
  idle: "Dictate (adds to the end)",
  recording: "Stop and transcribe",
  transcribing: "Transcribing…",
};

export default function MicButton({
  phase,
  onToggle,
  disabled = false,
  disabledReason,
  circle = false,
  className = "",
}: MicButtonProps) {
  const recording = phase === "recording";
  const waiting = phase === "transcribing";
  const isDisabled = disabled || waiting;
  const label = disabled && disabledReason ? disabledReason : TITLES[phase];
  if (circle) {
    return (
      <button
        type="button"
        data-testid="mic-button"
        aria-pressed={recording}
        aria-label={label}
        title={label}
        disabled={isDisabled}
        onClick={onToggle}
        className={`grid h-[32px] w-[32px] shrink-0 place-items-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring ${
          recording
            ? "border-[#2f4bd6] bg-[#2f4bd6] text-surface"
            : isDisabled
              ? "cursor-not-allowed border-line bg-disabled-bg text-disabled-fg"
              : "border-line bg-surface text-ink-2 hover:bg-fill"
        } ${className}`}
      >
        {recording ? (
          <IconPlayerStop size={15} stroke={1.75} aria-hidden className="shrink-0" />
        ) : (
          <IconMicrophone size={15} stroke={1.75} aria-hidden className="shrink-0" />
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-testid="mic-button"
      aria-pressed={recording}
      aria-label={label}
      title={label}
      disabled={isDisabled}
      onClick={onToggle}
      className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[4px] border ${KEEP_COMPOSER_SIZE_PX} focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring ${
        recording
          ? "border-st-failed-pale-fg bg-st-failed-strong text-st-failed-strong-fg"
          : waiting
            ? "cursor-default border-line bg-disabled-bg text-disabled-fg"
            : "border-fill-edge bg-fill text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-disabled-bg"
      } ${className}`}
    >
      {recording ? (
        <IconPlayerStop size={15} stroke={2} aria-hidden className="shrink-0" />
      ) : (
        <IconMicrophone size={15} stroke={2} aria-hidden className="shrink-0" />
      )}
    </button>
  );
}
