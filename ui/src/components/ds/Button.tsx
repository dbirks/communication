import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

/**
 * BTN-I — locked button variants. All visuals live in `.ds-btn*` in
 * `styles/tokens.css`: tonal border + shadow, hover 4% darker, pressed
 * translates into the shadow, visible royal focus ring with a paper gap.
 * One primary per area (handoff rule: royal = something you can do).
 */

export type ButtonVariant = "primary" | "secondary" | "secondaryPlain" | "ghost" | "danger";

export const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "ds-btn--primary",
  secondary: "ds-btn--secondary",
  secondaryPlain: "ds-btn--secondary-plain",
  ghost: "ds-btn--ghost",
  danger: "ds-btn--danger",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** 26px alert-inline button (ALERT-K). */
  compact?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  compact = false,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`ds-btn ${VARIANT_CLASS[variant]} ${compact ? "ds-btn--compact" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

/** A link styled as a BTN-I button — for navigations that leave the SPA
 * (e.g. the server-side OIDC redirect on the sign-in page). */
export function ButtonLink({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <a className={`ds-btn ${VARIANT_CLASS[variant]} ${className}`} {...rest}>
      {children}
    </a>
  );
}
