/**
 * The 1k dialog chrome (round-19 review): the dim backdrop must cover the
 * WHOLE viewport however tall the page behind it is — that is `position:
 * fixed; inset: 0` on the overlay itself, never `absolute` measured against
 * a shorter container (which is how rcn-1k-run-form-390 showed the strip
 * around ASSISTANT NOTICED undimmed below the backdrop's edge). jsdom has no
 * layout, so the assertion is on the classes that produce the geometry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RunFormDialog } from "./RunFormDialog";
import { bodyScrollLockDepth } from "../../../lib/scrollLock";

function mountDialog(): void {
  render(
    <RunFormDialog
      title="Run Issue to PR"
      subtitle="storefront · pinned r4"
      helper="Required fields are marked *."
      onCancel={() => {}}
      submit={<button type="button">Start run</button>}
    >
      <p>the form</p>
    </RunFormDialog>,
  );
}

afterEach(cleanup);

describe("RunFormDialog — the open form owns the page's scroll", () => {
  it("locks the document while it is up and gives the scroll back on close", () => {
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");

    const dialog = render(
      <RunFormDialog
        title="Run Issue to PR"
        subtitle="storefront · pinned r4"
        helper="helper"
        onCancel={() => {}}
        submit={<button type="button">Start run</button>}
      >
        <p>the form</p>
      </RunFormDialog>,
    );
    // Both scrolling elements: the app scrolls on the document element, and a
    // page that scrolls on the body has to be locked too.
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");

    dialog.unmount();
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
    expect(bodyScrollLockDepth()).toBe(0);
  });

  it("stacked dialogs release together: the inner close leaves the outer locked", () => {
    const outer = render(
      <RunFormDialog
        title="Run Issue to PR"
        subtitle="storefront · pinned r4"
        helper="helper"
        onCancel={() => {}}
        submit={<button type="button">Start run</button>}
      >
        <p data-testid="outer">outer</p>
      </RunFormDialog>,
    );
    const inner = render(
      <RunFormDialog
        title="Discard this draft?"
        subtitle="confirm"
        helper="helper"
        onCancel={() => {}}
        submit={<button type="button">Start run</button>}
      >
        <p data-testid="inner">inner</p>
      </RunFormDialog>,
    );
    expect(bodyScrollLockDepth()).toBe(2);

    // Closing the top dialog must not hand the wheel back to a page that is
    // still behind a dialog.
    act(() => inner.unmount());
    expect(bodyScrollLockDepth()).toBe(1);
    expect(document.documentElement.style.overflow).toBe("hidden");

    act(() => outer.unmount());
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
  });
});

describe("RunFormDialog — the backdrop covers the viewport, not the container", () => {
  it("dims with `fixed inset-0`, never `absolute`", () => {
    mountDialog();
    const backdrop = screen.getByTestId("run-form-dialog");
    const classes = backdrop.className.split(/\s+/);
    // `fixed` is anchored to the viewport regardless of page height; `absolute`
    // would only span the (possibly shorter) container it sits in.
    expect(classes).toContain("fixed");
    expect(classes).not.toContain("absolute");
    expect(classes).toContain("inset-0");
    // It is the dim layer and it outranks the page.
    expect(classes.some((c) => /^bg-ink\/\d+$/.test(c))).toBe(true);
    expect(classes).toContain("z-50");
    // A taller-than-viewport form scrolls INSIDE the fixed layer, so the dim
    // never has to grow with the content to stay under the fold.
    expect(classes).toContain("overflow-y-auto");
  });

  it("esc asks the owner to cancel; backdrop mousedown does too, box clicks never", () => {
    const onCancel = vi.fn();
    render(
      <RunFormDialog
        title="Run Issue to PR"
        subtitle="storefront · pinned r4"
        helper="helper"
        onCancel={onCancel}
        submit={<button type="button">Start run</button>}
      >
        <p data-testid="inside">the form</p>
      </RunFormDialog>,
    );
    // The dialog listens on `window` — esc asks the owner to cancel.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    const backdrop = screen.getByTestId("run-form-dialog");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);

    screen.getByTestId("inside").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
