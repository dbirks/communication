/**
 * The page behind an open dialog must stop scrolling, and must scroll again
 * when the dialog comes down — including when dialogs STACK, where the inner
 * close must not unlock the page under the outer one.
 *
 * The geometry this hook exists for (round-20's `rcn-1k-run-form-390`): the
 * dim layer is `fixed inset-0`, so any page still measuring taller than the
 * viewport paints bright, UNDIMMED content below the dim's bottom edge.
 * jsdom has no layout, so the assertions are on the boxes the lock clamps and
 * the values it hands back.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bodyScrollLockDepth, useBodyScrollLock } from "./scrollLock";

afterEach(cleanup);

describe("useBodyScrollLock — the page behind a dialog stops scrolling", () => {
  it("clamps the scrolling elements and the body's in-flow content while open", () => {
    const content = document.createElement("div");
    content.setAttribute("data-testid", "page-content");
    document.body.append(content);

    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
    expect(content.style.overflow).toBe("");

    const { unmount } = renderHook(() => useBodyScrollLock());
    expect(bodyScrollLockDepth()).toBe(1);
    // Both scrolling elements: the app scrolls on the document element, and a
    // page that scrolls on the body is locked the same way.
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");
    // …and the box that actually makes the document taller than the viewport.
    expect(content.style.overflow).toBe("hidden");
    expect(content.style.height).toBe("100%");

    unmount();
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
    expect(content.style.overflow).toBe("");
    expect(content.style.height).toBe("");

    content.remove();
  });

  it("leaves a fixed-position layer (a portal the dialog rides in) alone", () => {
    const portal = document.createElement("div");
    portal.style.position = "fixed";
    document.body.append(portal);

    const { unmount } = renderHook(() => useBodyScrollLock());
    expect(portal.style.overflow).toBe("");
    expect(portal.style.height).toBe("");

    unmount();
    portal.remove();
  });

  it("gives back the inline styles the page arrived with, not empty strings", () => {
    document.documentElement.style.overflow = "scroll";
    document.documentElement.style.height = "auto";
    const content = document.createElement("div");
    content.style.overflow = "auto";
    content.style.height = "640px";
    document.body.append(content);

    const { unmount } = renderHook(() => useBodyScrollLock());
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(content.style.overflow).toBe("hidden");

    unmount();
    expect(document.documentElement.style.overflow).toBe("scroll");
    expect(document.documentElement.style.height).toBe("auto");
    expect(content.style.overflow).toBe("auto");
    expect(content.style.height).toBe("640px");

    document.documentElement.style.overflow = "";
    document.documentElement.style.height = "";
    content.remove();
  });

  it("stacks: the inner dialog closing leaves the outer one's page locked", () => {
    const outer = renderHook(() => useBodyScrollLock());
    const inner = renderHook(() => useBodyScrollLock());
    expect(bodyScrollLockDepth()).toBe(2);
    expect(document.documentElement.style.overflow).toBe("hidden");

    // A dialog that unmounts while another stays up must not hand the scroll
    // back to a page that is still behind a dialog.
    act(() => inner.unmount());
    expect(bodyScrollLockDepth()).toBe(1);
    expect(document.documentElement.style.overflow).toBe("hidden");

    act(() => outer.unmount());
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("unlocks a surface that stays mounted while its panel toggles", () => {
    const { rerender, unmount } = renderHook(
      ({ open }: { open: boolean }) => useBodyScrollLock(open),
      { initialProps: { open: false } },
    );
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");

    rerender({ open: true });
    expect(document.documentElement.style.overflow).toBe("hidden");

    rerender({ open: false });
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");

    unmount();
    expect(bodyScrollLockDepth()).toBe(0);
  });

  it("counts every lock exactly once (StrictMode's mount/cleanup/remount)", () => {
    const { unmount } = renderHook(() => useBodyScrollLock());
    expect(bodyScrollLockDepth()).toBe(1);
    unmount();
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
  });
});
