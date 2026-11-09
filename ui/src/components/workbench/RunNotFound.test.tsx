/**
 * `RunNotFound` — the run-surface answer to a 404, exact (finding 12).
 *
 * The old line explained the build to the reviewer (the control plane, the
 * status code, why the page shows no scaffold). The rulebook asks three
 * questions instead: what happened, is my work safe, what do I do now. The
 * strings are pinned here character for character, in both shapes the component
 * serves: the project-scoped run route (a project to name, so both doors are
 * links) and the project-less deep link (no project, so the ask is a sentence).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RunNotFound } from "./RunNotFound";

const RUN_ID = "01987b00-1111-7000-8000-aaaaaaaaaaaa";
const PROJECT_ID = "01987a61-2222-7000-8000-bbbbbbbbbbbb";

function renderNotFound(projectId?: string) {
  return render(
    <MemoryRouter>
      <RunNotFound runId={RUN_ID} projectId={projectId} />
    </MemoryRouter>,
  );
}

/** Collapse the JSX's line-wrapping to the one-line sentence a reader sees. */
function oneLine(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(cleanup);

describe("RunNotFound copy (finding 12)", () => {
  it("says the plain fact, then both doors, on a project-scoped run", () => {
    renderNotFound(PROJECT_ID);

    expect(oneLine(screen.getByTestId("run-not-found-summary"))).toBe(
      "This run doesn't exist or you don't have access to it.",
    );
    // The id the reader followed, on its own mono line — data, not prose.
    expect(oneLine(screen.getByTestId("run-not-found-id"))).toBe(`run ${RUN_ID}`);

    const back = screen.getByTestId("run-not-found-runs");
    expect(oneLine(back)).toBe("Back to Runs");
    expect(back.getAttribute("href")).toBe(`/p/${PROJECT_ID}/runs`);

    const access = screen.getByTestId("run-not-found-access");
    expect(oneLine(access)).toBe("Ask for access");
    expect(access.getAttribute("href")).toBe(`/p/${PROJECT_ID}/members`);
  });

  it("names who to ask when no project is known (the /runs/:runId deep link)", () => {
    renderNotFound();

    expect(oneLine(screen.getByTestId("run-not-found-summary"))).toBe(
      "This run doesn't exist or you don't have access to it.",
    );
    // With no project there is no members page to link: Today is the way back,
    // and the ask is a sentence naming who to ask.
    expect(screen.getByTestId("run-not-found-runs").getAttribute("href")).toBe("/");
    expect(oneLine(screen.getByTestId("run-not-found-access"))).toBe(
      "Ask an admin of the project this run belongs to for access.",
    );
  });

  it("prints no build words, no status code and no retry", () => {
    renderNotFound(PROJECT_ID);

    const copy = oneLine(screen.getByTestId("run-not-found"));
    expect(copy).not.toMatch(/404|control plane|scaffold|endpoint|API/i);
    // A 404 is a refusal, not a break: re-asking answers the same.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
