import { problemOf } from "../api/client";

export interface SpinnerProps {
  label: string;
}

/** Loading state that is announced (statuses are never visual-only). */
export function Spinner({ label }: SpinnerProps) {
  return (
    <p role="status" className="text-sm text-gray-600" aria-live="polite">
      {label}…
    </p>
  );
}

export interface FormErrorProps {
  error: unknown;
}

/** Inline problem+json detail for a failed mutation. */
export function FormError({ error }: FormErrorProps) {
  if (!error) return null;
  const problem = problemOf(error);
  const text = problem.detail ? `${problem.title}: ${problem.detail}` : problem.title;
  return (
    <p
      data-testid="form-error"
      role="alert"
      className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
    >
      {text}
    </p>
  );
}

export interface ProblemBannerProps {
  error: unknown;
  /** Copy used when the server gave nothing usable. */
  fallback: string;
  testid?: string;
}

/** Read-state error (e.g. a 404 on a project the caller cannot see). */
export function ProblemBanner({ error, fallback, testid }: ProblemBannerProps) {
  const problem = problemOf(error);
  const text =
    problem.status === 404
      ? fallback
      : problem.detail
        ? `${problem.title}: ${problem.detail}`
        : problem.title;
  return (
    <p
      data-testid={testid}
      role="alert"
      className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
    >
      {text}
    </p>
  );
}

/** Shared input styling: visible focus ring, label always associated. */
export const fieldClass =
  "w-full rounded border border-gray-300 px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700";

export const labelClass = "block text-sm font-medium text-gray-800";

export const submitClass =
  "rounded bg-blue-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50";
