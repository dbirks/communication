/**
 * The GitHub mark on its own (2c/2e). `GithubIcon` is Tabler's brand glyph, and
 * Tabler renders an icon's nodes through an ARRAY (`createReactComponent` builds
 * `createElement("svg", attrs, ...iconNode.map(([tag, attrs]) => createElement(tag, attrs)))`),
 * so a node without a `key` would be a keyed-array child without a key and React
 * dev would log `Each child in a list should have a unique "key" prop … Check
 * the render method of ForwardRef` on every render of every screen that shows
 * the mark (the pass-1-20261027044149 dev-server defect on 2e repo and 2c
 * schedule-trigger-saved). Tabler's generated nodes carry a `key` in their
 * attrs, and the export keeps the name the trigger surfaces call.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubIcon } from "./TriggerDialog";

/** Everything `console.error` was handed while the case ran (React passes the
 * warning's format arguments as separate console arguments). */
let consoleErrors: string[];

beforeEach(() => {
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The unique-key warning among them, however React phrases it. */
function keyWarnings(lines: string[]): string[] {
  return lines.filter((line) => /unique ["']key["'] prop/i.test(line));
}

describe("GithubIcon — the Tabler brand glyph stays keyed", () => {
  // First, and alone: React warns once per component name per react-dom
  // instance (`ownerHasKeyUseWarning` is never reset), so the render that is
  // supposed to be clean gets its own file-level slot and the proof that the
  // spy would see a key warning at all lives in GithubIcon-key-warning.test.tsx
  // where it gets a fresh react-dom module.
  it("renders every path node with no React unique-key warning", () => {
    const { container } = render(
      <ul>
        {["issue", "row", "start"].map((id) => (
          <li key={id}>
            <GithubIcon size={14} stroke={2} aria-hidden />
          </li>
        ))}
      </ul>,
    );

    // The mark is still the mark: Tabler's brand glyph, ink at 14px.
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(3);
    for (const node of svgs) {
      expect(node.getAttribute("class") ?? "").toContain("tabler-icon-brand-github");
    }
    expect(container.querySelectorAll("svg path")).toHaveLength(3);
    expect(keyWarnings(consoleErrors)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
