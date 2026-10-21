import { useEffect, useState } from "react";
import { Button } from "../ds/Button";

/**
 * Listening row shown under the composer while dictation is in progress
 * (handoff "Assistant popover": royal waveform bars + timer + Done).
 * The transcript stays editable text in the caller's input; the caller
 * sends it — nothing is sent automatically.
 *
 * Mount it only while listening; the timer starts at mount. The royal
 * bars honour prefers-reduced-motion (static mid-height bars instead of
 * animating).
 */
const BAR_COUNT = 24;
const BAR_DELAYS = Array.from({ length: BAR_COUNT }, (_, i) => i * 0.07);

export interface ListeningBarProps {
  /** Latest in-progress transcript fragment. */
  interim: string;
  /** Accumulated final transcript (editable text in the caller's input). */
  final: string;
  onDone: () => void;
  className?: string;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function ListeningBar({
  interim,
  final,
  onDone,
  className = "",
}: ListeningBarProps) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const transcript = [final, interim].filter((part) => part.trim() !== "").join(" ");

  return (
    <div
      className={`speech-listening ${className}`}
      data-testid="listening-bar"
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        border: "1px dashed var(--color-accent-mid)",
        borderRadius: 4,
        background: "var(--color-accent-wash)",
      }}
    >
      <style>{`
        .speech-bars {
          display: flex;
          align-items: center;
          gap: 2px;
          height: 14px;
          flex-shrink: 0;
        }
        .speech-bars span {
          width: 3px;
          height: 100%;
          border-radius: 1px;
          background: var(--color-accent);
          animation: speech-bar-pulse 1.1s ease-in-out infinite;
        }
        @keyframes speech-bar-pulse {
          0%, 100% { transform: scaleY(0.3); }
          50% { transform: scaleY(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .speech-bars span {
            animation: none;
            transform: scaleY(0.6);
          }
        }
      `}</style>
      <span className="speech-bars" aria-hidden="true">
        {BAR_DELAYS.map((delay) => (
          <span key={delay} style={{ animationDelay: `${delay}s` }} />
        ))}
      </span>
      <span
        aria-live="polite"
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--color-accent-text)",
        }}
      >
        {transcript || "Listening…"}
      </span>
      <span
        style={{
          flexShrink: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-muted)",
        }}
      >
        {formatClock(seconds)}
      </span>
      <Button compact data-testid="listening-done" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
