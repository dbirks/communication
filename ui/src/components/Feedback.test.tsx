/**
 * The one load-failure treatment (2026-10-30 review). Before it, every screen
 * whose read failed rendered the same compact `× FAILED / Internal Server Error:
 * emulated failure` callout — the vocabulary of a run's status applied to a page
 * that simply could not load, with the server's problem document as the headline
 * and, on half the screens, no way to try again. These tests are the contract
 * the fix owns: a plain heading, the server's words kept as muted evidence (not
 * hidden — hiding them would make the failure up), a Retry that refetches, and a
 * way back where the page has a parent. The compact callout a dialog or a form
 * needs is asserted to be unchanged, because ~40 call sites still use it.
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

  it("keeps the server's own problem as muted evidence, not as the headline", () => {
    show(
      <ProblemBanner
        error={serverError}
        fallback="The workflow library could not be read."
        subject="the workflow library"
        testid="library-load-error"
      />,
    );
    const evidence = screen.getByText(/server said:/);
    expect(evidence.textContent).toContain("Internal Server Error: emulated failure");
    expect(evidence.className).toContain("text-faint");
    // The heading is the first line; the server's words are the muted tail.
    const banner = screen.getByTestId("library-load-error");
    expect(banner.textContent?.indexOf("Couldn't load")).toBeLessThan(
      banner.textContent?.indexOf("server said:") ?? 0,
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
    expect(banner.textContent).toContain("server said: Network error");
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
