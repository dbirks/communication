/**
 * The plan a gate is decided on, read as a plan rather than as a JSON string
 * (`live-run-inspector.png` shows the wall this replaces). Three rules with
 * teeth: the known keys render structurally, anything unknown is still
 * reachable, and a payload that is not JSON renders as the text it is.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanView, splitPlanText } from "./PlanView";

afterEach(cleanup);

/** The planner node's output, as the fixture pipeline serves it (`samplePipeline`
 * gate summary = title + this document), shortened to two steps. */
const PLAN = JSON.stringify({
  acceptance_criteria: ["Tests pass", "The reviewer approves"],
  context:
    "hello.py is not in the working directory root, and my attempt to list the repo was aborted.",
  goal: "Document and fix add() in hello.py",
  risks: ["The tool call to explore the repo was aborted, so step 1 needs read permissions"],
  steps: [
    {
      actions: ["Call hello.py; confirm which one is meant before editing"],
      done_when: "The paths to hello.py and its tests are known",
      id: 1,
      title: "Find the file and its tests",
    },
    {
      actions: ["Run the test suite and record which tests fail", "Read add() and its callers"],
      done_when: "The bug is identified and a failing test shows it",
      id: 2,
      title: "Run the tests before changing anything",
    },
  ],
});

describe("a plan served as JSON", () => {
  const show = () => render(<PlanView text={PLAN} />);

  it("puts the goal on a heading line of its own", () => {
    show();
    expect(screen.getByTestId("plan-goal").textContent).toBe("Document and fix add() in hello.py");
    expect(screen.getByTestId("plan-view").textContent).not.toContain('"acceptance_criteria"');
  });

  it("lists the steps in order, each with its actions and its done-when", () => {
    show();
    const steps = screen.getByTestId("plan-steps");
    expect(steps.textContent).toContain("Find the file and its tests");
    expect(steps.textContent).toContain("Run the tests before changing anything");
    expect(screen.getByTestId("plan-step-1").textContent).toContain(
      "confirm which one is meant before editing",
    );
    expect(screen.getByTestId("plan-step-2").textContent).toContain("Read add() and its callers");
    expect(screen.getByTestId("plan-step-done-when-1").textContent).toContain(
      "done when The paths to hello.py",
    );
    // Each step carries only title/actions/done_when/id, so no step shows an
    // other-fields block for its own id.
    expect(screen.queryByTestId("plan-step-other-1")).toBeNull();
    expect(screen.queryByTestId("plan-step-other-2")).toBeNull();
  });

  it("shows the risks and the acceptance criteria as lists, and the context as prose", () => {
    show();
    expect(screen.getByTestId("plan-risks").textContent).toContain("read permissions");
    expect(screen.getByTestId("plan-criteria").textContent).toContain("Tests pass");
    expect(screen.getByTestId("plan-context").textContent).toContain("working directory root");
  });

  it("keeps keys it does not know in a collapsed other-fields block", () => {
    render(<PlanView text={JSON.stringify({ goal: "Ship", owner: "team-a", budget: 3 })} />);
    const toggle = screen.getByTestId("plan-other");
    expect(toggle.textContent).toContain("other fields (2)");
    expect(screen.getByTestId("plan-other-json").hidden).toBe(true);
    fireEvent.click(toggle.querySelector("button") as HTMLButtonElement);
    expect(screen.getByTestId("plan-other-json").hidden).toBe(false);
    expect(screen.getByTestId("plan-other-json").textContent).toContain('"owner": "team-a"');
    expect(screen.getByTestId("plan-goal").textContent).toBe("Ship");
  });

  it("does not treat a step's id as an unknown field", () => {
    render(
      <PlanView
        text={JSON.stringify({
          steps: [
            {
              title: "Find the file",
              actions: ["List the repo"],
              done_when: "the path is known",
              id: 1,
            },
          ],
        })}
      />,
    );
    // The ordered list already numbers this step, so `id` renders nothing extra.
    expect(screen.queryByTestId("plan-step-other-1")).toBeNull();
    expect(screen.queryByTestId("plan-step-id-1")).toBeNull();
    expect(screen.getByTestId("plan-step-1").textContent).toContain("Find the file");
  });

  it("shows a step id that disagrees with its list position", () => {
    render(<PlanView text={JSON.stringify({ steps: [{ title: "Find the file", id: 7 }] })} />);
    expect(screen.getByTestId("plan-step-id-1").textContent).toBe("id 7");
    expect(screen.queryByTestId("plan-step-other-1")).toBeNull();
  });

  it("keeps an id the view cannot read as a number in the other-fields block", () => {
    render(
      <PlanView text={JSON.stringify({ steps: [{ title: "Find the file", id: { ref: 7 } }] })} />,
    );
    expect(screen.getByTestId("plan-step-other-1").textContent).toContain("other fields (1)");
    expect(screen.getByTestId("plan-step-other-1-json").textContent).toContain('"ref": 7');
  });

  it("leaves other unknown step fields in the step's other-fields block", () => {
    render(
      <PlanView
        text={JSON.stringify({ steps: [{ title: "Find the file", id: 1, owner: "team-a" }] })}
      />,
    );
    expect(screen.getByTestId("plan-step-other-1").textContent).toContain("other fields (1)");
    expect(screen.getByTestId("plan-step-other-1-json").textContent).toContain('"owner": "team-a"');
  });
});

describe("a payload that is not a plan", () => {
  it("renders plain text verbatim, whitespace preserved", () => {
    render(<PlanView text={"two\n\nlines of prose"} />);
    expect(screen.getByTestId("plan-view-plain")).toBeTruthy();
    expect(screen.getByTestId("plan-plain-text").textContent).toBe("two\n\nlines of prose");
    expect(screen.queryByTestId("plan-plain-show-all")).toBeNull();
  });

  it("clamps a long text and puts the rest behind show all", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    render(<PlanView text={long} />);
    expect(screen.getByTestId("plan-plain-text").textContent).not.toContain("line 13");
    fireEvent.click(screen.getByTestId("plan-plain-show-all"));
    expect(screen.getByTestId("plan-plain-text").textContent).toContain("line 20");
  });

  it("leaves a JSON array as text rather than pretending to read it", () => {
    render(<PlanView text='["a","b"]' />);
    expect(screen.getByTestId("plan-plain-text").textContent).toBe('["a","b"]');
  });
});

describe("splitPlanText — a title glued to the document", () => {
  it("splits at the first brace when the remainder is a JSON object", () => {
    const { title, body } = splitPlanText(`Plan for hello.py\n${PLAN}\n`);
    expect(title).toBe("Plan for hello.py");
    expect(body.startsWith('{"acceptance_criteria"')).toBe(true);
  });

  it("leaves prose that merely mentions a brace alone", () => {
    const prose = "Plan for “add()”: four files, one migration {see plan.md}.";
    const { title, body } = splitPlanText(prose);
    expect(title).toBeNull();
    expect(body).toBe(prose);
  });
});
