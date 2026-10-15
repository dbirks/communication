import { problemOf } from "../api/client";
import { Alert } from "./ds/Alert";

export interface SpinnerProps {
  label: string;
}

/** Loading state that is announced (statuses are never visual-only). */
export function Spinner({ label }: SpinnerProps) {
  return (
    <p role="status" className="font-mono text-[11px] text-muted" aria-live="polite">
      · {label}…
    </p>
  );
}

export interface FormErrorProps {
  error: unknown;
  testid?: string;
}

/** Inline problem+json detail for a failed mutation (ALERT-K, pale failed). */
export function FormError({ error, testid = "form-error" }: FormErrorProps) {
  if (!error) return null;
  const problem = problemOf(error);
  const text = problem.detail ? `${problem.title}: ${problem.detail}` : problem.title;
  return (
    <Alert state="failed" label="FAILED" role="alert" testid={testid}>
      {text}
    </Alert>
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
    <Alert state="failed" label="FAILED" role="alert" testid={testid}>
      {text}
    </Alert>
  );
}
