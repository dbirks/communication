/**
 * MARK-E — the C mark and the COMMUNICATION wordmark. Kaisei Opti 500 is
 * allowed nowhere else. The diagonal hatch square sits behind the box,
 * offset by 1/10 of the size to the bottom-right; the box itself is a 1px
 * ink hairline with radius 3 on white.
 */

export interface MarkProps {
  /** Edge of the boxed C in px (28 in the app bar, 40/44 elsewhere). */
  size?: number;
  className?: string;
  /** Accessible name; the mark is decorative when a word follows it. */
  title?: string;
}

export function Mark({ size = 28, className = "", title }: MarkProps) {
  const inset = Math.round(size / 10);
  return (
    <span
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title ?? "Communication"}
    >
      <span
        aria-hidden="true"
        className="ds-hatch-mark absolute rounded-[3px]"
        style={{ top: inset, right: -inset, bottom: -inset, left: inset }}
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center rounded-[3px] border border-ink bg-surface font-mark text-ink"
        // The C sits optically centered: line-height 1 + cap/alphabetic trim
        // (text-box is a progressive enhancement; the fallback stays close).
        style={{
          fontSize: Math.round(size * 0.61),
          lineHeight: 1,
          textBox: "trim-both cap alphabetic",
        }}
      >
        C
      </span>
    </span>
  );
}

export interface WordmarkProps {
  /** Height of each boxed letter in px (16 in the handoff). */
  size?: number;
  className?: string;
}

/** The boxed COMMUNICATION wordmark for sign-in, empty states and the
 * expanded nav: one hairline box per letter, offset in accent-mid. */
export function Wordmark({ size = 16, className = "" }: WordmarkProps) {
  const gap = Math.max(1, Math.round(size * 0.19));
  return (
    <span
      className={`inline-flex ${className}`}
      style={{ gap }}
      role="img"
      aria-label="Communication"
    >
      {"COMMUNICATION".split("").map((letter, index) => (
        <span
          key={`${letter}-${index}`}
          aria-hidden="true"
          className="flex items-center justify-center border border-ink bg-surface font-mark text-ink"
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.69),
            lineHeight: 1,
            boxShadow: `${size * 0.09}px ${size * 0.09}px 0 var(--color-accent-mid)`,
            textBox: "trim-both cap alphabetic",
          }}
        >
          {letter}
        </span>
      ))}
    </span>
  );
}
