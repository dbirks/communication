/**
 * PromptBox — the one prompt box the redesign uses on Home (All and project),
 * the New chat pane and the Chats composer (handoff README §2, §3).
 *
 * Radius 14, 1px line-strong border, padding 14 16, the soft prompt shadow.
 * A growing textarea on top; a row of chips on the left below it; the round
 * 32px accent send button on the right. Enter sends, Shift+Enter breaks the
 * line. The box is presentational: the caller owns the text and what "send"
 * does, and passes its own chips (project picker, agent chip, "or run a
 * workflow", "Run workflow").
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { IconArrowUp, IconChevronDown } from "@tabler/icons-react";

export interface PromptBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text; never with an empty one. */
  onSubmit: (text: string) => void;
  placeholder: string;
  /** Accessible name of the text field. */
  label: string;
  /** Chips on the left of the bottom row (use `PromptChip`). */
  chips?: ReactNode;
  /** Controls between the chips and the send button (a mic, a Stop button). */
  trailing?: ReactNode;
  /** A line under the row (an error, "a turn is running"). */
  footer?: ReactNode;
  disabled?: boolean;
  /** True while the send is in flight: the button is disabled, text stays. */
  busy?: boolean;
  autoFocus?: boolean;
  /** Minimum textarea rows (1 in a composer, 2 on Home). */
  rows?: number;
  testid?: string;
  className?: string;
}

const MAX_HEIGHT_PX = 220;

export function PromptBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
  chips,
  trailing,
  footer,
  disabled = false,
  busy = false,
  autoFocus = false,
  rows = 2,
  testid = "prompt-box",
  className = "",
}: PromptBoxProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const text = value.trim();
  const canSend = text !== "" && !disabled && !busy;

  // Grow with the text up to a cap, then scroll inside.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const send = () => {
    if (canSend) onSubmit(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <form
      data-testid={testid}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      className={`rounded-[14px] border border-line-strong bg-surface px-[16px] py-[14px] shadow-[var(--shadow-prompt)] focus-within:border-accent ${className}`}
    >
      <textarea
        ref={area}
        data-testid={`${testid}-input`}
        aria-label={label}
        value={value}
        rows={rows}
        disabled={disabled}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="block w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-[22px] text-ink outline-none placeholder:text-faint disabled:text-disabled-fg"
      />
      <div className="mt-[10px] flex items-center gap-[8px]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[6px]">{chips}</div>
        {trailing}
        {/* `data-round` opts the button out of the phone touch-target floor in
            tokens.css (APP-SHELL-PHONE) so it stays a 32px circle at every
            width; that rule gives it the 44px hit area through a transparent
            ::before instead of stretching it into a capsule. */}
        <button
          type="submit"
          data-testid={`${testid}-send`}
          data-round
          aria-label="Send"
          disabled={!canSend}
          className="relative grid aspect-square h-[32px] w-[32px] shrink-0 place-items-center rounded-full p-0 bg-accent text-white hover:bg-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-disabled-bg disabled:text-disabled-fg"
        >
          <IconArrowUp size={17} stroke={2} aria-hidden />
        </button>
      </div>
      {footer ? <div className="mt-[8px] text-[12.5px] text-muted">{footer}</div> : null}
    </form>
  );
}

export interface PromptChipProps {
  children: ReactNode;
  icon?: ReactNode;
  /** Trailing muted chevron: the chip opens a menu (a plain action has none). */
  chevron?: boolean;
  onClick?: () => void;
  /** Forwarded so a ds `Menu` can anchor to the chip. */
  buttonRef?: React.Ref<HTMLButtonElement>;
  disabled?: boolean;
  title?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu" | "dialog" | "listbox";
  testid?: string;
}

/** A chip in the prompt box's bottom row: 26px tall, radius 8, 1px line,
 * 12.5px/600 text-ink in the UI font; `chevron` adds the trailing 12px
 * muted chevron that marks a chip as a menu trigger. */
export function PromptChip({
  children,
  icon,
  chevron = false,
  onClick,
  buttonRef,
  disabled,
  title,
  testid,
  ...aria
}: PromptChipProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid={testid}
      title={title}
      disabled={disabled}
      onClick={onClick}
      {...aria}
      className="inline-flex h-[26px] max-w-full items-center gap-[5px] rounded-[8px] border border-line bg-surface px-[8px] font-ui text-[12.5px] text-ink hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:text-disabled-fg"
    >
      {icon}
      <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{children}</span>
      {chevron ? (
        <IconChevronDown size={12} stroke={1.5} className="shrink-0 text-muted" aria-hidden />
      ) : null}
    </button>
  );
}

export default PromptBox;
