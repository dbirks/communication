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

/**
 * A real agent plan, verbatim from the live gate (`live-conversation-4.png`):
 * steps that name themselves with a singular `action` and a `file`, and a top
 * level the fixture pipeline never served — `acceptance` instead of
 * `acceptance_criteria`, plus `findings`. Before this, every one of those steps
 * was a line of raw JSON and an OTHER FIELDS block.
 */
const LIVE_PLAN = JSON.stringify({
  acceptance: [
    "pytest passes in app/ with both tests green",
    "add.__doc__ is a non-empty, accurate docstring",
    "add() still returns a + b",
    "The reviewer approves",
  ],
  findings: [
    "app/hello.py:1: add(a, b) returns a + b, which is already the correct sum. It has no docstring, so test_add_is_documented fails.",
    "app/tests/test_hello.py:11: test_add_sums asserts add(1, 2) == 99. That expected value is wrong.",
    "app/README.md says the fixture is mounted read-only into workers at /srv/m4/fixtures. Edits may need to go to a writable copy.",
  ],
  goal: "Document and fix add() in app/hello.py",
  risks: [
    "If the reviewer or the contract (docs/m4-contract.md § 7.0, which isn't in this checkout) requires the test file to stay unchanged, the only way to pass is to make add() return a wrong result. I won't do that without explicit confirmation.",
    "If the checkout is read-only, steps 1-2 need a writable copy of the repo.",
  ],
  steps: [
    {
      action:
        "Add a docstring to add() that says it returns the sum of a and b, using the + operator, so it works with numbers and any other types that support +. Leave the a + b body unchanged.",
      file: "app/hello.py",
      id: 1,
    },
    {
      action:
        "Change the assertion in test_add_sums from add(1, 2) == 99 to add(1, 2) == 3, and replace the 'intentionally failing' comment with one that matches the corrected assertion. Optionally add edge cases such as add(-1, 1) == 0 and add(0.5, 0.25) == 0.75.",
      file: "app/tests/test_hello.py",
      id: 2,
    },
    {
      action:
        "Run pytest from app/ (pytest.ini sets testpaths = tests) and confirm both tests pass.",
      id: 3,
    },
    {
      action:
        "Send the diff for review, pointing out that the test's expected value was changed instead of add()'s behavior, and why.",
      id: 4,
    },
  ],
});

describe("a plan in the shapes a real agent serves", () => {
  const show = () => render(<PlanView text={LIVE_PLAN} />);

  it("titles a step from its singular action, headline first and full text below", () => {
    show();
    const step = screen.getByTestId("plan-step-1");
    expect(step.textContent).toContain(
      "Add a docstring to add() that says it returns the sum of a and b, using the + operator, so it works with numbers and any other types that support +.",
    );
    // The second sentence is not lost — it rides in the full text under the
    // headline, and none of the step is shown as JSON.
    expect(screen.getByTestId("plan-step-action-1").textContent).toBe(
      "Add a docstring to add() that says it returns the sum of a and b, using the + operator, so it works with numbers and any other types that support +. Leave the a + b body unchanged.",
    );
    expect(step.textContent).not.toContain('"action"');
    expect(step.textContent).not.toContain("{");
  });

  it("prints the file a step touches as its own mono line", () => {
    show();
    expect(screen.getByTestId("plan-step-files-1").textContent).toBe("app/hello.py");
    expect(screen.getByTestId("plan-step-files-2").textContent).toBe("app/tests/test_hello.py");
    expect(screen.queryByTestId("plan-step-files-3")).toBeNull();
  });

  it("leaves a short single-sentence action as the whole headline", () => {
    show();
    expect(screen.getByTestId("plan-step-3").textContent).toContain(
      "Run pytest from app/ (pytest.ini sets testpaths = tests) and confirm both tests pass.",
    );
    expect(screen.queryByTestId("plan-step-action-3")).toBeNull();
  });

  it("knows id, action, file and files, so a live step shows no other-fields block", () => {
    show();
    for (const index of [1, 2, 3, 4]) {
      expect(screen.queryByTestId(`plan-step-other-${index}`)).toBeNull();
    }
    expect(screen.queryByTestId("plan-other")).toBeNull();
  });

  it("bullets findings and reads acceptance as an alias of acceptance_criteria", () => {
    show();
    expect(screen.getByTestId("plan-findings").textContent).toContain(
      "app/hello.py:1: add(a, b) returns a + b",
    );
    expect(screen.getByTestId("plan-criteria").textContent).toContain(
      "add.__doc__ is a non-empty, accurate docstring",
    );
    expect(screen.getByTestId("plan-view").textContent).not.toContain('"acceptance"');
  });

  it("titles from description when there is no title or action", () => {
    render(
      <PlanView text={JSON.stringify({ steps: [{ description: "Read the contract first" }] })} />,
    );
    expect(screen.getByTestId("plan-step-1").textContent).toContain("Read the contract first");
    expect(screen.queryByTestId("plan-step-other-1")).toBeNull();
  });

  it("keeps an action a title superseded reachable in the step block", () => {
    render(
      <PlanView
        text={JSON.stringify({
          steps: [
            {
              action: "cat m4-contract.md",
              description: "opens the contract",
              retry: 2,
              title: "Read the contract first",
            },
          ],
        })}
      />,
    );
    const step = screen.getByTestId("plan-step-1");
    expect(step.textContent).toContain("Read the contract first");
    const block = screen.getByTestId("plan-step-other-1");
    expect(block.textContent).toContain("other fields (3)");
    fireEvent.click(block.querySelector("button") as HTMLButtonElement);
    expect(screen.getByTestId("plan-step-other-1-json").textContent).toContain(
      '"action": "cat m4-contract.md"',
    );
  });

  it("shows both acceptance keys when they disagree", () => {
    render(
      <PlanView
        text={JSON.stringify({
          acceptance: ["Reviewer approves"],
          acceptance_criteria: ["Tests pass"],
        })}
      />,
    );
    expect(screen.getByTestId("plan-criteria").textContent).toContain("Tests pass");
    const block = screen.getByTestId("plan-other");
    expect(block.textContent).toContain("other fields (1)");
    fireEvent.click(block.querySelector("button") as HTMLButtonElement);
    expect(screen.getByTestId("plan-other-json").textContent).toContain("Reviewer approves");
  });
});
