/**
 * The design-system layer: statuses are never color-only (rule 06) — every
 * state renders its glyph *and* a word, and progress always shows counts.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "./Alert";
import { Field, Input } from "./Field";
import { Mark, Wordmark } from "./Mark";
import { ProgressStrip } from "./ProgressStrip";
import { Row, StatusChip } from "./Row";
import { STATES, TOOL_STATE, TURN_STATE, WORKER_STATE } from "./states";

describe("StatusChip (STATUS-E)", () => {
  it("renders the state's glyph and its word", () => {
    render(<StatusChip state="waiting" label="needs you" />);
    expect(screen.getByText("needs you")).toBeTruthy();
    expect(screen.getByText("!", { selector: "[aria-hidden='true']" })).toBeTruthy();
  });

  it("keeps the test hook on the word only", () => {
    render(
      <StatusChip state="running" label="live" labelProps={{ "data-testid": "stream-status" }} />,
    );
    expect(screen.getByTestId("stream-status").textContent).toBe("live");
  });
});

describe("ProgressStrip (PROGRESS-J/K)", () => {
  const stages = [
    { label: "plan", state: "done" as const },
    {
      label: "implement",
      active: true,
      detail: "implement ×214",
      segments: [
        { kind: "done" as const, count: 150 },
        { kind: "running" as const, count: 38 },
        { kind: "waiting" as const, count: 15 },
      ],
    },
    { label: "draft pr", state: "pending" as const },
  ];

  it("shows glyphs for whole-stage cells and counts for segments", () => {
    render(<ProgressStrip stages={stages} />);
    expect(screen.getByText("plan")).toBeTruthy();
    expect(screen.getByLabelText("150 done, 38 running, 15 waiting")).toBeTruthy();
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("renders per-stage rows with the count line (K)", () => {
    render(<ProgressStrip variant="K" stages={stages} />);
    // Rule 06: bars always come with counts.
    expect(screen.getAllByText("implement ×214").length).toBeGreaterThan(0);
  });
});

describe("Alert (ALERT-K)", () => {
  it("pairs the glyph with the state's bar word", () => {
    render(
      <Alert state="interrupted" testid="notice">
        Turn stopped — outcome unknown
      </Alert>,
    );
    expect(screen.getByTestId("notice").textContent).toContain("⊘ INTERRUPTED");
    expect(screen.getByTestId("notice").textContent).toContain("Turn stopped");
  });
});

describe("Field (INPUT-A)", () => {
  it("wires the error message to the control it describes", () => {
    render(
      <Field id="path" label="Path" error="path not in workspace">
        <Input id="path" invalid data-testid="path-input" defaultValue="backend/.env" />
      </Field>,
    );
    const input = screen.getByTestId("path-input");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("path-error");
    // The red edge alone never carries the error: the message is text.
    expect(screen.getByRole("alert").textContent).toBe("path not in workspace");
    // INPUT-A error state: red edge (`invalid`) + the message above.
    expect(input.className).toContain("border-st-failed-strong");
  });
});

describe("Mark (MARK-E)", () => {
  it("exposes an accessible name and hides the parts", () => {
    render(<Mark size={28} />);
    expect(screen.getByRole("img", { name: "Communication" })).toBeTruthy();
  });

  it("spells the wordmark letters for assistive tech as one label", () => {
    render(<Wordmark size={16} />);
    expect(screen.getAllByRole("img", { name: "Communication" }).length).toBeGreaterThan(0);
  });
});

describe("Row (ROW-I)", () => {
  it("marks selection with the raised ink styling, never color alone", () => {
    render(
      <Row selected data-testid="r">
        hello
      </Row>,
    );
    const el = screen.getByTestId("r");
    expect(el.className).toContain("border-ink");
    expect(el.className).toContain("shadow-(--shadow-raised)");
  });
});

describe("status → state-set table", () => {
  it("maps every UI status kind onto one of the eight sets", () => {
    const tables: Record<string, Record<string, keyof typeof STATES>> = {
      turn: TURN_STATE,
      worker: WORKER_STATE,
      tool: TOOL_STATE,
    };
    for (const [, table] of Object.entries(tables)) {
      for (const state of Object.values(table)) {
        expect(STATES[state]).toBeTruthy();
      }
    }
    expect(TURN_STATE.cancelled).toBe("interrupted");
    expect(WORKER_STATE.online).toBe("running");
    expect(TOOL_STATE.in_progress).toBe("running");
  });

  it("every state has a glyph and a word", () => {
    for (const spec of Object.values(STATES)) {
      expect(spec.glyph.length).toBeGreaterThan(0);
      expect(spec.word.length).toBeGreaterThan(0);
    }
  });
});
