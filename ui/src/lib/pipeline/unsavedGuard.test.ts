/**
 * The guard's click rule. The hook that uses it is exercised through
 * `components/m4/DraftEditor.test.tsx` (a nav `<Link>` clicked with the
 * textarea dirty); what is worth pinning here is the boundary between "an
 * in-app navigation the user should be asked about" and "a click that is none of
 * the guard's business".
 */
import { describe, expect, it } from "vitest";
import { exitTargetOf } from "./unsavedGuard";

const here = { pathname: "/library/0198", search: "?draft=7" };

/**
 * A click aimed at `target`. Built rather than dispatched: an anchor's
 * activation behavior is a document navigation, which jsdom refuses loudly, and
 * `exitTargetOf` only reads `target` and the modifier state anyway.
 */
function clickOn(html: string, init: MouseEventInit = {}): MouseEvent {
  const host = document.createElement("div");
  host.innerHTML = html;
  const target = host.querySelector<HTMLElement>("[data-click]") ?? host.firstElementChild;
  if (!target) throw new Error("no target");
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

const link = (href: string, extra = "") =>
  `<a href="${href}"${extra} data-click>leave</a><span>text</span>`;

describe("exitTargetOf", () => {
  it("names an in-app link that would lose the edit", () => {
    const event = clickOn(link("/library"));
    expect(exitTargetOf(event, here)).toBe("/library");
  });

  it("keeps the search and hash of the target, so a confirmed leave lands where the click pointed", () => {
    expect(exitTargetOf(clickOn(link("/projects/1/runs?a=2#top")), here)).toBe(
      "/projects/1/runs?a=2#top",
    );
  });

  it("ignores a click that is not a plain left click on an app page", () => {
    const modified = { metaKey: true };
    expect(exitTargetOf(clickOn(link("/library"), modified), here)).toBeNull();
    expect(exitTargetOf(clickOn(link("/library"), { button: 1 }), here)).toBeNull();
    expect(exitTargetOf(clickOn(link("/library", 'download="x.yml"')), here)).toBeNull();
    expect(exitTargetOf(clickOn(link("/library", 'target="_blank"')), here)).toBeNull();
  });

  it("ignores a link that goes where the page already is", () => {
    expect(exitTargetOf(clickOn(link("/library/0198?draft=7")), here)).toBeNull();
    // A hash-only change is not a page change; the draft editor stays mounted.
    expect(exitTargetOf(clickOn(link("/library/0198?draft=7#notes")), here)).toBeNull();
  });

  it("leaves a cross-origin link alone — that is a real navigation, and beforeunload owns it", () => {
    expect(exitTargetOf(clickOn(link("https://example.com/docs")), here)).toBeNull();
  });

  it("ignores a click something else already handled", () => {
    const event = clickOn(link("/library"));
    event.preventDefault();
    expect(exitTargetOf(event, here)).toBeNull();
  });

  it("says nothing about a click that is not on a link at all", () => {
    const event = clickOn(`<button data-click>Save</button>`);
    expect(exitTargetOf(event, here)).toBeNull();
  });
});
