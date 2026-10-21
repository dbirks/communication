import { useRef, useState } from "react";
import { DEFAULT_TRUST_LEVEL, TRUST_LEVELS, trustPillLabel, type TrustLevel } from "./types";

/**
 * Trust-level pill for the assistant header strip (2a/4d §1).
 *
 * A per-person switch, like Claude Code's permission modes. Presentational:
 * the current level and the persistence of a change are the caller's job —
 * this component just owns the menu (radio semantics, keyboard, esc) and
 * reports the choice back. The trust level gates the server-side tool loop
 * (ADR-0050 Decision 4); the pill never claims to gate anything itself.
 */
export interface TrustPillProps {
  value: TrustLevel;
  onChange: (level: TrustLevel) => void;
  className?: string;
}

export function TrustPill({ value, onChange, className = "" }: TrustPillProps) {
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) pillRef.current?.focus();
  };

  // Close on focus leaving the whole widget (tabbing away, or clicking
  // outside — the outside element that takes focus is not inside).
  const handleBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget;
    if (
      next &&
      !menuRef.current?.contains(next as Node) &&
      !pillRef.current?.contains(next as Node)
    ) {
      setOpen(false);
    }
  };

  const moveFocus = (to: number) => {
    const index = (to + TRUST_LEVELS.length) % TRUST_LEVELS.length;
    itemRefs.current[index]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = itemRefs.current;
    const focused = items.findIndex((item) => item === document.activeElement);
    switch (event.key) {
      case "Escape":
        // Close the menu, not the panel: stop the event from reaching the
        // panel's window listener and put focus back on the pill.
        event.stopPropagation();
        close(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(focused === -1 ? 0 : focused + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(focused === -1 ? items.length - 1 : focused - 1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveFocus(items.length - 1);
        break;
      case "Enter":
      case " ":
        if (focused !== -1) {
          event.preventDefault();
          onChange(TRUST_LEVELS[focused].value);
          close(true);
        }
        break;
    }
  };

  return (
    <div
      className={className}
      onBlur={handleBlur}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        ref={pillRef}
        type="button"
        data-testid="assistant-pill"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Trust level: ${trustPillLabel(value)}`}
        onClick={() => {
          setOpen((nextOpen) => !nextOpen);
          if (open) return;
          // Open into the first item so arrow keys work immediately.
          requestAnimationFrame(() => itemRefs.current[0]?.focus());
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          padding: "2px 7px",
          border: "1px solid var(--color-line-strong)",
          borderRadius: 4,
          background: "var(--color-surface)",
          color: "var(--color-ink-2)",
          cursor: "pointer",
          lineHeight: 1.4,
        }}
      >
        {trustPillLabel(value)}
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Trust level"
          data-testid="assistant-pill-menu"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 30,
            width: 300,
            background: "var(--color-surface)",
            border: "1px solid var(--color-ink)",
            borderRadius: 4,
            boxShadow: "2px 2px 0 var(--color-ink)",
            padding: 8,
          }}
        >
          {TRUST_LEVELS.map((level, index) => {
            const checked = level.value === value;
            return (
              <button
                key={level.value}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                data-testid={`assistant-pill-option-${level.value}`}
                onClick={() => {
                  onChange(level.value);
                  close(true);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "none",
                  background: checked ? "var(--color-accent-wash)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <span
                  className="flex items-center gap-[6px] text-[12.5px] text-ink"
                  style={{ fontWeight: 600 }}
                >
                  <span aria-hidden="true" style={{ width: 12, flexShrink: 0 }}>
                    {checked ? "✓" : ""}
                  </span>
                  {level.label}
                  {level.value === DEFAULT_TRUST_LEVEL ? (
                    <span className="font-mono text-[9.5px] text-faint">default</span>
                  ) : null}
                </span>
                <span className="block pl-[18px] text-[11px] leading-[1.4] text-muted">
                  {level.blurb}
                </span>
              </button>
            );
          })}
          <p
            className="mt-[6px] border-t border-line-soft pt-[6px] font-mono text-[9.5px] leading-[1.5] text-faint"
            style={{ padding: "6px 8px 0" }}
          >
            just for you · never reads secret values · never goes beyond your project role
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default TrustPill;
