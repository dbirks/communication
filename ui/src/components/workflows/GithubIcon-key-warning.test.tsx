/**
 * The positive control for GithubIcon.test.tsx: an icon-node array WITHOUT the
 * `key` attributes must make the spy see a React unique-key warning.
 *
 * It has to be its own file. React warns once per owner component name per
 * react-dom instance (`ownerHasKeyUseWarning` in react-dom-client.development.js
 * is never reset), so in a shared module registry the clean render and the
 * deliberately-keyed-broken render would silence each other and the clean
 * assertion would pass vacuously. Vitest gives every test file a fresh module
 * registry, so the control gets its own.
 */
import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("the unique-key detector", () => {
  it("sees the warning for keyless icon nodes (the shape the bug had)", () => {
    // Exactly lucide's `Icon` machinery with the keys stripped out.
    const iconNode: [tag: string, attrs: Record<string, string>][] = [
      ["path", { d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5" }],
      ["path", { d: "M9 18c-4.51 2-5-2-7-2" }],
    ];
    const { container } = render(
      createElement(
        "svg",
        null,
        iconNode.map(([tag, attrs]) => createElement(tag, attrs)),
      ),
    );

    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(consoleErrors.filter((line) => /unique ["']key["'] prop/i.test(line))).not.toEqual([]);
  });
});
