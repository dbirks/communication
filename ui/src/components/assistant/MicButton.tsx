import { isSpeechRecognitionSupported } from "../../lib/speech";

/**
 * Mic toggle for the assistant composer, Board drawer and thread composer
 * (handoff "Assistant popover", Assets: Lucide-style mic). 36px
 * secondary-style square. Renders nothing where the Web Speech API is
 * absent — callers also gate on `supported` for their own layout.
 */
export interface MicButtonProps {
  listening: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}

export function MicIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export default function MicButton({
  listening,
  onToggle,
  disabled = false,
  className = "",
}: MicButtonProps) {
  // A dead mic is worse than no mic: unsupported browsers (Firefox) get
  // nothing rendered.
  if (!isSpeechRecognitionSupported()) return null;
  return (
    <button
      type="button"
      data-testid="mic-button"
      aria-pressed={listening}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      title={listening ? "Stop dictation" : "Start dictation"}
      disabled={disabled}
      onClick={onToggle}
      className={`ds-btn ds-btn--secondary ${className}`}
      style={{
        width: 36,
        height: 36,
        padding: 0,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      <MicIcon />
    </button>
  );
}
