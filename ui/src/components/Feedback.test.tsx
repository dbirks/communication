/**
 * The one load-failure treatment (2026-10-30 review). Before it, every screen
 * whose read failed rendered the same compact `× FAILED / Internal Server Error:
 * emulated failure` callout — the vocabulary of a run's status applied to a page
 * that simply could not load, with the server's problem document as the headline
 * and, on half the screens, no way to try again. These tests are the contract
 * the fix owns: a plain heading, the server's words kept as muted evidence, a
 * Retry that refetches, and a way back where the page has a parent. The compact
 * callout a dialog or a form needs is asserted to be unchanged, because ~40 call
 * sites still use it.
 *
 * error-details-r6 moved that evidence one step further off the reading line:
 * the pass-1 reviewers graded the visible `server said: Internal Server Error:
 * emulated failure` line as developer-facing text shown to users. The raw quote
 * is still in the DOM — hiding it would make the failure up — but collapsed
 * behind a `Details` disclosure, and the status itself is said in a plain
 * sentence the reader understands.
 */
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiError } from "../api/client";
import { ProblemBanner } from "./Feedback";
import { ProjectUnavailable } from "./ProjectUnavailable";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

/** The problem the emulator's `server-error.spec.ts` answers with. */
const serverError = new ApiError(
  {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    detail: "emulated failure",
  },
  { type: "about:blank", title: "Internal Server Error", status: 500, detail: "emulated failure" },
);

function show(ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={["/workflows"]}>{ui}</MemoryRouter>);
}

describe("ProblemBanner — a page's load failure (`subject`)", () => {
  it("leads with a plain heading, not the run-status word FAILED", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        testid="library-load-error"
      />,
    );
    const banner = screen.getByTestId("library-load-error");
    expect(banner.textContent).toContain("Couldn't load the workflow library.");
    // `FAILED` is a run's status word; a page that could not load is not a run
    // that failed, so the bar says what happened instead.
    expect(banner.textContent).not.toContain("FAILED");
    expect(banner.textContent).toContain("COULDN'T LOAD");
  });

  it("collapses the server's raw problem behind a Details disclosure, never on the reading line", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        testid="library-load-error"
      />,
    );
    const banner = screen.getByTestId("library-load-error");
    const details = banner.querySelector("details");
    expect(details).toBeTruthy();
    // Collapsed: the raw text is in the DOM but not on the screen — a reader
    // who wants it opens `Details` (a native disclosure: focusable, Enter/Space
    // opens it).
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Details");
    const evidence = screen.getByTestId("library-load-error-server");
    expect(details?.contains(evidence)).toBe(true);
    expect(evidence.textContent).toContain("server said: Internal Server Error: emulated failure");
    expect(evidence.className).toContain("text-faint");
    // The heading is the first line; the server's words are the tail, inside
    // the disclosure.
    expect(banner.textContent?.indexOf("Couldn't load")).toBeLessThan(
      banner.textContent?.indexOf("server said:") ?? 0,
    );
  });

  it("says a 5xx in a plain status sentence the reader can act on", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        testid="library-load-error"
      />,
    );
    expect(screen.getByTestId("library-load-error").textContent).toContain(
      "The server had a problem — try again in a moment.",
    );
  });

  it("says a network failure in a plain status sentence too", () => {
    // Not an ApiError: `problemOf` gives it status 0 — the network's answer.
    show(
      <ProblemBanner
        error={new Error("connect ECONNREFUSED")}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        testid="library-load-error"
      />,
    );
    const banner = screen.getByTestId("library-load-error");
    expect(banner.textContent).toContain(
      "We couldn't reach the server — check your connection and try again.",
    );
    // The raw text still rides behind the disclosure, not on the line.
    expect(screen.getByTestId("library-load-error-server").closest("details")).toBeTruthy();
  });

  it("404 and 403 keep their own words — no generic status sentence", () => {
    const refusal = (status: number, title: string) =>
      new ApiError({ type: "about:blank", title, status }, { type: "about:blank", title, status });
    const notFound = show(
      <ProblemBanner
        error={refusal(404, "Not Found")}
        fallback="The workflow you are looking for is not here."
        subject="the workflow"
        testid="nf-banner"
      />,
    );
    expect(notFound.getByTestId("nf-banner").textContent).toContain(
      "The workflow you are looking for is not here.",
    );
    expect(notFound.getByTestId("nf-banner").textContent).not.toContain("The server had a problem");
    expect(notFound.getByTestId("nf-banner").textContent).not.toMatch(/server said/);

    const forbidden = show(
      <ProblemBanner
        error={refusal(403, "Forbidden")}
        fallback="You do not have access to this project."
        subject="the project"
        testid="fb-banner"
      />,
    );
    expect(forbidden.getByTestId("fb-banner").textContent).toContain(
      "You do not have access to this project.",
    );
    expect(forbidden.getByTestId("fb-banner").textContent).not.toContain(
      "The server had a problem",
    );
    expect(forbidden.getByTestId("fb-banner").textContent).not.toContain("check your connection");
  });

  it("the same block carries the verb a write needs (Couldn't save …)", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="Nothing was changed."
        subject="the trigger"
        verb="save"
        testid="write-banner"
      />,
    );
    const banner = screen.getByTestId("write-banner");
    expect(banner.textContent).toContain("Couldn't save the trigger.");
    expect(banner.textContent).toContain("COULDN'T SAVE");
    expect(banner.textContent).not.toContain("FAILED");
    // A write failure of a server's own 5xx gets the same plain sentence and
    // the same collapsed evidence.
    expect(banner.textContent).toContain("The server had a problem — try again in a moment.");
    expect(banner.querySelector("details")?.textContent).toContain(
      "server said: Internal Server Error: emulated failure",
    );
  });

  it("is the one alert on the page and stays announced", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("Retry refetches, and says so while the read is running", () => {
    const onRetry = vi.fn();
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        retry={{ onClick: onRetry, testid: "workflows-load-retry" }}
      />,
    );
    fireEvent.click(screen.getByTestId("workflows-load-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    show(
      <ProblemBanner
        error={serverError}
        fallback="x"
        subject="the workflow library"
        retry={{ onClick: onRetry, pending: true, testid: "second-retry" }}
      />,
    );
    const again = screen.getByTestId("second-retry");
    expect(again.textContent).toBe("Retrying…");
    expect((again as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the way back only where the page has a parent", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow could not be loaded."
        subject="the workflow"
        back={{ to: "/workflows", label: "← Back to workflows", testid: "workflow-back-to-list" }}
      />,
    );
    const back = screen.getByTestId("workflow-back-to-list");
    expect(back.getAttribute("href")).toBe("/workflows");

    const second = show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        testid="no-parent-banner"
      />,
    );
    // The library index has no parent: no invented link, no second navigation.
    expect(second.getByTestId("no-parent-banner").querySelector("a")).toBeNull();
  });
});

describe("ProblemBanner — the compact inline callout (unchanged)", () => {
  it("a dialog or a form still quotes the problem in the FAILED alert", () => {
    show(<ProblemBanner error={serverError} fallback="nothing" testid="inline-callout" />);
    const banner = screen.getByTestId("inline-callout");
    expect(banner.textContent).toContain("FAILED");
    expect(banner.textContent).toContain("Internal Server Error: emulated failure");
    expect(banner.querySelector("button")).toBeNull();
  });

  it("quotes nothing that is not an answer (`undefined` never reaches the screen)", () => {
    // A call site that knows "some of these reads broke" but holds no single
    // error passes `undefined`; `problemOf` stringifies it, and the banner used
    // to print that string.
    show(<ProblemBanner error={undefined} fallback="x" testid="no-error-callout" />);
    expect(screen.getByTestId("no-error-callout").textContent).toBe("× FAILEDNetwork error");

    show(
      <ProblemBanner
        error={undefined}
        fallback="Some rows could not be read in full."
        subject="some rows"
        testid="no-error-subject"
      />,
    );
    const banner = screen.getByTestId("no-error-subject");
    expect(banner.textContent).not.toMatch(/undefined/);
    // The network answer is said plainly; the raw quote sits behind Details.
    expect(banner.textContent).toContain(
      "We couldn't reach the server — check your connection and try again.",
    );
    expect(banner.querySelector("details")?.textContent).toContain("server said: Network error");
    expect(banner.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("a 404 in the compact form is the caller's sentence, not a server quote", () => {
    const refused = new ApiError(
      { type: "about:blank", title: "Not Found", status: 404 },
      { type: "about:blank", title: "Not Found", status: 404 },
    );
    show(
      <ProblemBanner
        error={refused}
        fallback="The project you are looking for is not here."
        testid="refused-callout"
      />,
    );
    expect(screen.getByTestId("refused-callout").textContent).toBe(
      "× FAILEDThe project you are looking for is not here.",
    );
  });
});

describe("ProjectUnavailable — the refusal is a page, not a red line", () => {
  it("carries the heading, the one sentence, and a line of what to do", () => {
    show(
      <ProjectUnavailable
        heading="Repository"
        headingId="repo-not-found-heading"
        testid="repo-not-found"
        copy="Repository not found or you do not have access"
        hint="Check the name in the link, or go back to the project and pick a repository it does have."
        back={{ to: "/p/1", label: "Northwind", testid: "repo-breadcrumb" }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Repository");
    // The test handle stays on the sentence alone: a test may assert its exact
    // text, and the emulator does (`toHaveText`).
    expect(screen.getByTestId("repo-not-found").textContent).toBe(
      "Repository not found or you do not have access",
    );
    expect(screen.getByText(/Check the name in the link/)).toBeTruthy();
    expect(screen.getByRole("alert").getAttribute("role")).toBe("alert");
  });

  it("the breadcrumb is the way back, and the sentence still announces itself", () => {
    show(
      <ProjectUnavailable
        heading="Project"
        headingId="project-heading"
        testid="project-not-found"
        back={{ to: "/projects", label: "Projects", testid: "project-back" }}
      />,
    );
    expect(screen.getByTestId("project-back").getAttribute("href")).toBe("/projects");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });

  it("under a page that already has a heading, it does not draw a second H1", () => {
    show(
      <ProjectUnavailable
        label="Draft unavailable"
        testid="studio-draft-error"
        copy="Draft not found or you do not have access."
        hint="The breadcrumb above opens the workflow."
      />,
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("region", { name: "Draft unavailable" })).toBeTruthy();
  });
});
