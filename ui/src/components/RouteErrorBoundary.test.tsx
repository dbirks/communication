/**
 * The boundary is the reason a thrown render is a banner rather than a white
 * screen (the live case: a new draft's `undefined.map` blanked /library/:id).
 * Two facts to pin: children that render fine are untouched, and a child that
 * throws is replaced by a readable problem with a way out.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

function Breaks({ message }: { message: string }): ReactNode {
  throw new Error(message);
}

afterEach(cleanup);

describe("RouteErrorBoundary", () => {
  it("leaves a healthy route alone", () => {
    render(
      <RouteErrorBoundary>
        <p>the pipeline library</p>
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("the pipeline library")).toBeDefined();
    expect(screen.queryByTestId("route-error-boundary")).toBeNull();
  });

  it("turns a render error into a problem banner instead of a blank page", () => {
    // React logs every caught error while rendering; this test trips one on
    // purpose, so silence just that noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Breaks message="Cannot read properties of undefined (reading 'map')" />
      </RouteErrorBoundary>,
    );
    const banner = screen.getByTestId("route-error-boundary");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("This page failed to render");
    expect(banner.textContent).toContain("reading 'map'");
    spy.mockRestore();
  });

  it("offers a reload as the way out", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReload = vi.fn();
    render(
      <RouteErrorBoundary onReload={onReload}>
        <Breaks message="boom" />
      </RouteErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId("route-error-reload"));
    expect(onReload).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
