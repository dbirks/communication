/**
 * The one answer every screen gives when the thing it was opened for is not
 * there — or not there for this reader.
 *
 * `GET /api/v1/projects/{id}` refuses a non-member a 404 that hides existence
 * (ADR-0014 § 3), and the sub-resource routes answer the same way. Each page
 * used to decide that refusal for itself, which is how `/runs` came to show a
 * raw problem banner and `/pipelines` came to render the whole project
 * shell — rail, library, "not assigned to this project" chips — around a
 * project the reader cannot open. The shell is itself a leak: it confirms the
 * project exists and shows what is *not* in it.
 *
 * So the refusal is one component with one sentence, and `projectAccessRefused`
 * is one predicate: 404 (unknown or invisible) and 403 (a role that cannot reach
 * this particular surface) are both "you cannot open this from here", and
 * neither is a banner quoting a server error.
 *
 * The 2026-10-30 review added the other half: a refusal that is a red line under
 * a bare H1 leaves the reader nowhere to go. Four parts, in design order —
 * the page's header band with the parent's breadcrumb (the way back), the
 * sentence, ONE line of what to do, and (when the caller passes `backButton`)
 * the way back as an act beside the sentence. Its H1 names WHAT was missing
 * when the caller passes `missing` (`Project not found`), because a generic
 * section word over a refusal read as an unrelated page (pass-1 review, item
 * 5). It is deliberately not an error box: nothing failed, this thing is simply
 * not here for you. A screen that already draws its own band (`Studio`, a
 * framed project tab) passes no `heading` and names the section with `label`
 * instead, so the page never carries two H1s. Callers outside the project
 * routes pass their own `copy` (a repository is not a project and must not
 * borrow the project's words).
 */
import { Link } from "react-router";
import { ApiError } from "../api/client";

/** The sentence the project screens show; every one of them shows the same one. */
export const PROJECT_UNAVAILABLE_COPY = "Project not found or you do not have access";

/** True when `error` is the API refusing this project to this caller. */
export function projectAccessRefused(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

export interface ProjectUnavailableProps {
  /** The section's own H1, so the page still says which screen it is. Omit it
   * where the page's band already carries the heading — one H1 per page. */
  heading?: string;
  headingId?: string;
  /** The section's accessible name when there is no visible heading. */
  label?: string;
  /** Test handle of the refusal sentence, one per page, so a test can tell the
   * screens apart. It stays on the sentence alone: a test may assert that
   * element's exact text. */
  testid: string;
  /** The sentence. Defaults to the project's. */
  copy?: string;
  /** The page's parent: the breadcrumb link that is the way back. Absent on a
   * screen whose shell already draws that navigation. */
  back?: { to: string; label: string; testid: string };
  /** One line on what to do. */
  hint?: string;
  /**
   * The thing this page was opened for and could not open ("Project",
   * "Repository"). With it the H1 NAMES what was missing — `Project not
   * found` — instead of repeating the section's bare word, which read as a
   * generic page standing over a refusal (pass-1 review, item 5). Omit it
   * where the heading is right on its own.
   */
  missing?: string;
  /**
   * The same way back, as a BUTTON beside the message. The breadcrumb in
   * `back` is the trail; a reader who arrived on a dead link wants the verb,
   * which is what every other failed read offers (`ProblemBanner`'s own
   * `← Back to …`). Pass it with the `back` it repeats.
   */
  backButton?: { label: string; testid: string };
  /** Test handle for the frame the refusal stands in. */
  sectionTestId?: string;
}

export function ProjectUnavailable({
  heading,
  headingId,
  label,
  testid,
  copy = PROJECT_UNAVAILABLE_COPY,
  back,
  hint,
  missing,
  backButton,
  sectionTestId,
}: ProjectUnavailableProps) {
  const sectionProps =
    heading && headingId
      ? { "aria-labelledby": headingId }
      : { "aria-label": label ?? "Not found" };
  return (
    <section {...sectionProps} data-testid={sectionTestId}>
      {heading || back ? (
        <header className="flex flex-col gap-[6px] border-b border-line pb-[12px]">
          {back ? (
            <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
              <Link
                to={back.to}
                className="text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                data-testid={back.testid}
              >
                {back.label}
              </Link>
              {heading ? (
                <span aria-hidden="true" className="px-1.5">
                  /
                </span>
              ) : null}
            </nav>
          ) : null}
          {heading ? (
            <h1 id={headingId} className="text-title-l font-bold">
              {missing ? `${missing} not found` : heading}
            </h1>
          ) : null}
        </header>
      ) : null}
      <p className="text-body" role="alert">
        <span aria-hidden="true" className="text-st-failed-tag-fg">
          ×{" "}
        </span>
        <span className="font-semibold" data-testid={testid}>
          {copy}
        </span>
      </p>
      {hint ? (
        <p
          className={`max-w-[70ch] text-[12.5px] text-muted ${heading ? "mt-[12px]" : "mt-[4px]"}`}
        >
          {hint}
        </p>
      ) : null}
      {/* The way back, as the button the hint only names. It sits with the
          sentence (pass-1 review, item 5) because the breadcrumb above is
          navigation, not an act — and a reader on a dead link should not have
          to aim at an 11px mono trail to leave. */}
      {back && backButton ? (
        <div className="mt-[12px] flex flex-wrap items-center gap-[6px]">
          <Link
            to={back.to}
            className="ds-btn ds-btn--secondary ds-btn--compact inline-flex items-center rounded-[4px]"
            data-testid={backButton.testid}
          >
            {backButton.label}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
