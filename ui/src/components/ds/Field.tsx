import {
  cloneElement,
  isValidElement,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/**
 * INPUT-A — hairline input on white: gray at rest, ink edge + pale royal
 * ring on focus, red edge + inline message on error. Content is mono (rule
 * 07: what a machine produced or typed as a value); labels are mono labels
 * as designed.
 */

/** Shared input styling: visible focus ring, label always associated. At
 * phone width (<560px) the app-shell touch rule takes over: every control is
 * ≥ 44px tall (see APP-SHELL-PHONE in `styles/tokens.css`). */
export const fieldClass =
  "w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink placeholder:text-faint max-[560px]:min-h-[44px] " +
  "focus-visible:border-ink focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--color-accent-ring)]";

export const fieldErrorClass = "border-st-failed-strong";

export const labelClass =
  "block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted";

export interface FieldProps {
  id: string;
  label: string;
  /** Rendered below the control in red when set (INPUT-A error). */
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ id, label, error, hint, className = "", children }: FieldProps) {
  // INPUT-A: the red edge and the message must reach assistive tech too, so the
  // message is wired to the control it describes.
  const control =
    error && isValidElement(children)
      ? cloneElement(
          children as ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>,
          {
            "aria-describedby": `${id}-error`,
            "aria-invalid": true,
          },
        )
      : children;
  return (
    <div className={`space-y-1 ${className}`}>
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      {control}
      {error ? (
        <p id={`${id}-error`} role="alert" className="font-mono text-[11px] text-st-failed-tag-fg">
          {error}
        </p>
      ) : (
        hint
      )}
    </div>
  );
}

export interface DsInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid = false, className = "", ...rest }: DsInputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={`${fieldClass} ${invalid ? fieldErrorClass : ""} ${className}`}
      {...rest}
    />
  );
}

export interface DsTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid = false, className = "", ...rest }: DsTextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={`${fieldClass} ${invalid ? fieldErrorClass : ""} font-ui ${className}`}
      {...rest}
    />
  );
}

export interface DsSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({ invalid = false, className = "", children, ...rest }: DsSelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={`${fieldClass} ${invalid ? fieldErrorClass : ""} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
