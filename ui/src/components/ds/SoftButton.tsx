import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The redesign's button. Since the Nov 27 visual language (README section 8)
 * it IS BTN-I, rounded: every visual lives in `.ds-btn*` in
 * `styles/tokens.css` (radius 8, height 32, tonal border and 2px offset
 * shadow, pressed moves into the shadow). This file keeps the redesign's
 * import path and its `size` prop; `lg` is the 34px editor button.
 */

export type SoftButtonVariant = "primary" | "secondary" | "secondaryPlain" | "ghost" | "danger";
export type SoftButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<SoftButtonVariant, string> = {
  primary: "ds-btn--primary",
  secondary: "ds-btn--secondary",
  secondaryPlain: "ds-btn--secondary-plain",
  ghost: "ds-btn--ghost",
  danger: "ds-btn--danger",
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
  return [
    "ds-btn",
    VARIANT_CLASS[variant],
    compact ? "ds-btn--compact" : size === "lg" ? "ds-btn--tall" : "",
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
