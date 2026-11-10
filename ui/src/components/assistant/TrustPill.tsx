import { useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { ComposerMenu } from "./ContextButton";
import { DEFAULT_TRUST_LEVEL, TRUST_LEVELS, trustPillLabel, type TrustLevel } from "./types";

/**
 * The trust pill in the composer's bottom row (handoff §4; mock L357–366 and
 * the TRUST menu at L441–455).
 *
 * A per-person switch, like Claude Code's permission modes. Presentational: the
 * current level and its persistence are the caller's job — this owns the pill,
 * the menu (radio semantics, keyboard, esc) and reports the choice back. The
 * level gates the server-side tool loop; the pill never claims to gate anything
 * itself, and the copy says what each level does — no promise that a change can
 * be undone, because only draft edits can be (§4).
 *
 * The menu is the composer's `ComposerMenu` (imported from the page-context
 * control, which owns that box): it renders outside the panel, so the popover's
 * `overflow: hidden` cannot clip it.
 */
/** The menu the design draws is 290px wide. */
const TRUST_MENU_WIDTH_PX = 290;

export interface TrustPillProps {
  value: TrustLevel;
  onChange: (level: TrustLevel) => void;
  className?: string;
}

export function TrustPill({ value, onChange, className = "" }: TrustPillProps) {
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) pillRef.current?.focus();
  };

  const moveFocus = (to: number) => {
    const index = (to + TRUST_LEVELS.length) % TRUST_LEVELS.length;
    // Focus lands on the button itself; the menu lives in a portal off
    // `document.body`, so the active element IS one of these refs.
    itemRefs.current[index]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = itemRefs.current;
    const focused = items.findIndex((item) => item === document.activeElement);
    switch (event.key) {
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
    <span className={`relative inline-flex min-w-0 shrink-0 ${className}`}>
      <button
        ref={pillRef}
        type="button"
        data-testid="assistant-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Trust level: ${trustPillLabel(value)}`}
        onClick={() => {
          setOpen((nextOpen) => !nextOpen);
          if (open) return;
          // Open into the first item so arrow keys work immediately.
          requestAnimationFrame(() => itemRefs.current[0]?.focus());
        }}
        className="inline-flex h-[26px] min-w-0 shrink-0 cursor-pointer items-center gap-[4px] overflow-hidden whitespace-nowrap rounded-[4px] border border-line bg-surface px-[7px] font-mono text-[11px] leading-none text-ink-2 hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
      >
        {trustPillLabel(value)}
        <IconChevronDown size={13} stroke={2} aria-hidden className="shrink-0" />
      </button>
      <ComposerMenu
        triggerRef={pillRef}
        open={open}
        onClose={() => close(true)}
        width={TRUST_MENU_WIDTH_PX}
        ariaLabel="Trust level"
        data-testid="assistant-pill-menu"
      >
        <div role="menu" aria-label="Trust level" onKeyDown={onMenuKeyDown}>
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
                className={`block w-full cursor-pointer rounded-[4px] border-none px-2 py-[6px] text-left ${
                  checked ? "bg-accent-wash" : "bg-transparent hover:bg-accent-wash"
                }`}
              >
                <span className="flex items-center gap-[6px] text-[13px] font-semibold text-ink">
                  <span aria-hidden="true" className="grid w-[12px] shrink-0 place-items-center">
                    {checked ? <IconCheck size={12} stroke={2} className="shrink-0" /> : null}
                  </span>
                  {level.label}
                  {level.value === DEFAULT_TRUST_LEVEL ? (
                    <span className="font-mono text-[9.5px] font-normal text-faint">default</span>
                  ) : null}
                </span>
                <span className="block pl-[18px] text-[11px] leading-[1.4] text-muted">
                  {level.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </ComposerMenu>
    </span>
  );
}

export default TrustPill;
