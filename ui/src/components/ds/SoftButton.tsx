import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Redesign soft button (docs/design/redesign/README.md "Design tokens"):
 * radius 8, 1px line, no hard 2px offset shadow. Kept separate from the old
 * hard-shadow `Button` so kept pages (run workbench, approvals, artifacts,
 * repository, catch-up item) stay unchanged.
 */

export type SoftButtonVariant = "primary" | "secondary" | "secondaryPlain" | "ghost" | "danger";
export type SoftButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<SoftButtonVariant, string> = {
  primary: "border-accent bg-accent text-white hover:border-accent-edge hover:bg-accent-edge",
  secondary: "border-line bg-surface text-ink hover:border-line-strong hover:bg-paper",
  secondaryPlain: "border-line bg-surface text-ink hover:border-line-strong hover:bg-paper",
  ghost:
    "border-transparent bg-transparent text-accent-text hover:bg-accent-wash hover:text-accent-edge",
  danger: "border-st-failed-btn-edge bg-st-failed-tag text-st-failed-tag-fg hover:brightness-96",
};

const SIZE_CLASS: Record<SoftButtonSize, string> = {
  sm: "h-[30px] px-[12px] text-[12.5px]",
  md: "h-[30px] px-[12px] text-[12.5px]",
  lg: "h-[34px] px-[14px] text-[13px]",
};

export function softButtonClassName({
  variant = "secondary",
  size = "md",
  compact = false,
  className = "",
}: {
  variant?: SoftButtonVariant;
  size?: SoftButtonSize;
  compact?: boolean;
  className?: string;
} = {}): string {
  const sizeClass = compact ? "h-[26px] px-[10px] text-[12px]" : SIZE_CLASS[size];
  return [
    "inline-flex cursor-pointer items-center justify-center gap-[6px] rounded-[8px] border font-ui font-semibold whitespace-nowrap transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:cursor-not-allowed disabled:border-line disabled:bg-disabled-bg disabled:text-disabled-fg",
    "max-[559px]:min-h-[44px]",
    sizeClass,
    VARIANT_CLASS[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface SoftButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SoftButtonVariant;
  size?: SoftButtonSize;
  compact?: boolean;
  children: ReactNode;
}

export function SoftButton({
  variant = "secondary",
  size = "md",
  compact = false,
  className = "",
  children,
  type = "button",
  ...rest
}: SoftButtonProps) {
  return (
    <button
      type={type}
      className={softButtonClassName({ variant, size, compact, className })}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface SoftButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: SoftButtonVariant;
  size?: SoftButtonSize;
  compact?: boolean;
  children: ReactNode;
}

export function SoftButtonLink({
  variant = "secondary",
  size = "md",
  compact = false,
  className = "",
  children,
  ...rest
}: SoftButtonLinkProps) {
  return (
    <a className={softButtonClassName({ variant, size, compact, className })} {...rest}>
      {children}
    </a>
  );
}
