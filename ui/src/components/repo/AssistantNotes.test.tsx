/**
 * The repo page's ASSISTANT NOTICED panel (design 3a, ADR-0071). Two rules
 * hold it in shape: it draws ONLY what the caller hands it — with no notes it
 * says so in one muted line under its own heading (rcn-review13 item 3: a
 * hidden panel made the section's existence unreadable; a placeholder note
 * would be a fake one) — and it draws at most three notes, the cap the store
 * enforces on the write. With notes, the bar is the accent wash with the
 * accent edge down the panel, which is what makes it read as the assistant
 * speaking rather than another section of the page.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantNotes, type AssistantNote } from "./AssistantNotes";

afterEach(cleanup);

function note(id: string, withAction = true): AssistantNote {
  return {
    id,
    text: `Two runs failed at review since lunch (${id}).`,
    action: withAction ? { label: "Open the run", onSelect: () => undefined } : undefined,
  };
}

describe("AssistantNotes", () => {
  it("with no notes, keeps the section's heading with one honest empty line — never a placeholder note", () => {
    // rcn-review13 item 3: the panel used to vanish with no notes, so a
    // reviewer could not tell whether the section was built at all. The
    // heading stands (in the muted skin — the accent wash is reserved for
    // "the assistant spoke"), with one muted line saying what lands here.
    render(<AssistantNotes notes={[]} />);
    const panel = screen.getByTestId("repo-assistant-notes");
    expect(panel).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ASSISTANT NOTICED" })).toBeTruthy();
    expect(panel.textContent).toContain("ASSISTANT NOTICED");
    const empty = screen.getByTestId("repo-assistant-notes-empty");
    expect(empty.textContent).toContain("Nothing noticed yet");
    expect(empty.className).toContain("text-muted");
    // The honest line is a SENTENCE, not a note row: no count, no dismiss,
    // no action — nothing that reads as the assistant having spoken.
    expect(screen.queryByTestId("repo-assistant-notes-count")).toBeNull();
    expect(panel.querySelector("[data-testid^='repo-assistant-note-'")).toBeNull();
    expect(panel.className).not.toContain("accent");
  });

  it("draws the accent bar, one sentence per note, and the count it was handed", () => {
    render(<AssistantNotes notes={[note("n-1"), note("n-2")]} />);
    const panel = screen.getByTestId("repo-assistant-notes");
    expect(panel.textContent).toContain("ASSISTANT NOTICED");
    expect(screen.getByTestId("repo-assistant-note-n-1").textContent).toContain(
      "Two runs failed at review since lunch (n-1).",
    );
    expect(screen.getByTestId("repo-assistant-notes-count").textContent).toBe("2");
    // The note's own sentence is text, never markup: an <em> in the model's
    // words is not a node in this tree.
    expect(screen.getByTestId("repo-assistant-note-n-1").querySelector("em")).toBeNull();
  });

  it("shows three notes and drops the fourth", () => {
    render(<AssistantNotes notes={[note("a"), note("b"), note("c"), note("d")]} />);
    expect(screen.getByTestId("repo-assistant-notes-count").textContent).toBe("3");
    expect(screen.queryByTestId("repo-assistant-note-d")).toBeNull();
  });

  it("a note with no action offers nothing but the dismiss", () => {
    render(<AssistantNotes notes={[note("quiet", false)]} onDismiss={() => undefined} />);
    const row = screen.getByTestId("repo-assistant-note-quiet");
    expect(row.querySelector('[data-testid="repo-assistant-note-quiet-action"]')).toBeNull();
    expect(row.textContent).toContain("dismiss");
  });

  it("the action performs its own kind, and dismiss is the note's own", () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AssistantNotes
        notes={[{ id: "n-1", text: "Say something.", action: { label: "Hand it off", onSelect } }]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId("repo-assistant-note-n-1-action"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("repo-assistant-note-n-1-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "n-1" }));
  });

  it("offers no dismiss when dismissal is impossible", () => {
    render(<AssistantNotes notes={[note("n-1")]} />);
    expect(screen.queryByTestId("repo-assistant-note-n-1-dismiss")).toBeNull();
  });

  it("is a labelled landmark the reader can find", () => {
    render(<AssistantNotes notes={[note("n-1")]} />);
    const panel = screen.getByRole("region", { name: /assistant noticed/i });
    expect(panel).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the run" })).toBeTruthy();
  });
});
