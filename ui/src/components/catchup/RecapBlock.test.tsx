/**
 * The recap block's own states (mock 8a): the "ASSISTANT RECAP · WRITTEN
 * {HH:MM}" label, the ask that becomes "Writing…" while the model is thinking,
 * the honest empty with "Write one" instead of "Regenerate", and the refusal
 * line that keeps the stored recap on screen because a refusal stored nothing.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatchUpRecap } from "../../api/catchup";
import { RecapBlock } from "./RecapBlock";

const recap: CatchUpRecap = {
  text: "Start with the refund bug. It was fixed straight on main.",
  written_at: "2026-10-14T14:07:00Z",
  window: "unseen",
  project_ids: [],
};

function mount(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

afterEach(cleanup);

describe("RecapBlock", () => {
  it("names the hour the recap was written and offers to rewrite it", () => {
    mount(
      <RecapBlock
        recap={recap}
        loading={false}
        stops={4}
        minutes={5}
        builtFrom={3}
        onRegenerate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("catchup-recap").textContent).toMatch(
      /ASSISTANT RECAP · WRITTEN \d{2}:\d{2}/,
    );
    const ask = screen.getByTestId("catchup-recap-regenerate");
    expect(ask.textContent).toBe("Regenerate");
    expect(ask.hasAttribute("disabled")).toBe(false);
  });

  it("sets the recap's first sentence in bold, and counts the shared tours honestly", () => {
    mount(
      <RecapBlock
        recap={recap}
        loading={false}
        stops={4}
        minutes={5}
        builtFrom={3}
        onRegenerate={vi.fn()}
      />,
    );
    // Mock 8a: "**9 pieces of work you haven't seen, across 3 projects.** Start…"
    expect(screen.getByTestId("catchup-recap-lead").textContent).toBe("Start with the refund bug.");
    expect(screen.getByTestId("catchup-recap").textContent).toContain(
      "Start with the refund bug. It was fixed straight on main.",
    );
    expect(screen.getByTestId("catchup-recap").textContent).toContain("built from 3 shared tours");
  });

  it("says shared tour (singular) for a tour built from one piece", () => {
    mount(<RecapBlock recap={recap} loading={false} stops={1} minutes={1} builtFrom={1} />);
    expect(screen.getByTestId("catchup-recap").textContent).toContain("built from 1 shared tour");
    expect(screen.getByTestId("catchup-recap").textContent).not.toContain("1 shared tours");
  });

  it("reads the same button as Write one when there is no recap to replace", async () => {
    mount(
      <RecapBlock
        recap={null}
        loading={false}
        stops={0}
        minutes={0}
        builtFrom={0}
        onRegenerate={vi.fn()}
      />,
    );
    const ask = screen.getByTestId("catchup-recap-regenerate");
    expect(screen.getByTestId("catchup-recap").textContent).toContain("No recap yet.");
    expect(ask.textContent).toBe("Write one");
    fireEvent.click(ask);
  });

  it("is Writing… and disabled while the ask is in flight", () => {
    mount(
      <RecapBlock
        recap={recap}
        loading={false}
        stops={1}
        minutes={1}
        builtFrom={1}
        onRegenerate={vi.fn()}
        writing
      />,
    );
    const ask = screen.getByTestId("catchup-recap-regenerate");
    expect(ask.textContent).toBe("Writing…");
    expect(ask.hasAttribute("disabled")).toBe(true);
    fireEvent.click(ask);
  });

  it("shows the refusal under the recap that survived it", () => {
    mount(
      <RecapBlock
        recap={recap}
        loading={false}
        stops={1}
        minutes={1}
        builtFrom={1}
        onRegenerate={vi.fn()}
        error="You've asked for a lot of recaps — try again in 45s."
      />,
    );
    expect(screen.getByTestId("catchup-recap-error").textContent).toBe(
      "You've asked for a lot of recaps — try again in 45s.",
    );
    expect(screen.getByTestId("catchup-recap").textContent).toContain("Start with the refund bug");
  });

  it("draws no ask at all when the caller has none to fire", () => {
    mount(<RecapBlock recap={recap} loading={false} stops={1} minutes={1} builtFrom={1} />);
    expect(screen.queryByTestId("catchup-recap-regenerate")).toBeNull();
  });
});
