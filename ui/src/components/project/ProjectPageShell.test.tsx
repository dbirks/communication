/**
 * The page column the project page's unusable states draw (see the component's
 * own comment). jsdom knows nothing of layout pixels, so this asserts the
 * classes that produce them: the paper full-height page, and the header band's
 * inset (`22px` sides / `20px` top, `28px` from `md` up) on the padded column.
 *
 * The pair to read together: `ProjectHeader` and the members page's band both
 * spread `PROJECT_PAGE_PAD`, so a branch that renders no band is inset exactly
 * like a branch that does.
 */
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProjectPageShell, PROJECT_PAGE_PAD } from "./ProjectPageShell";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

describe("ProjectPageShell", () => {
  it("gives its content the header band's padding on a paper page", () => {
    render(
      <ProjectPageShell testid="shell">
        <p>Project not found or you do not have access</p>
      </ProjectPageShell>,
    );
    const shell = screen.getByTestId("shell");
    expect(shell.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "min-h-full", "flex-col", "bg-paper"]),
    );
    const column = shell.firstElementChild as HTMLElement;
    for (const pad of PROJECT_PAGE_PAD.split(/\s+/)) {
      expect(column.className.split(/\s+/), `the padded column carries ${pad}`).toContain(pad);
    }
  });

  it("shares one padding constant with the header band", () => {
    // The band and these branches must not drift apart: they read one value.
    expect(PROJECT_PAGE_PAD).toBe("px-[22px] pt-[20px] md:px-[28px]");
  });
});
