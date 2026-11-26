import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarchingAnts } from "./MarchingAnts";

afterEach(cleanup);

describe("MarchingAnts", () => {
  it("renders dashed SVG rect with marching-ants animation and reduced-motion rule", () => {
    render(
      <MarchingAnts rect={{ x: 40, y: 80, width: 208, height: 336 }} label="3 steps selected" />,
    );
    const root = screen.getByTestId("marching-ants");
    expect(root.style.left).toBe("40px");
    expect(root.style.top).toBe("80px");
    expect(screen.getByTestId("marching-ants-label").textContent).toBe("3 steps selected");

    const rect = root.querySelector("rect");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("stroke-dasharray")).toBe("6 5");
    expect(rect?.getAttribute("stroke")).toBe("#2f4bd6");
    expect(rect?.getAttribute("rx")).toBe("14");
    expect(rect?.getAttribute("class")).toContain("studio-marching-ants-rect");

    const styleEl = root.querySelector("style");
    expect(styleEl?.textContent).toContain("@keyframes studio-marching-ants");
    expect(styleEl?.textContent).toContain("prefers-reduced-motion: reduce");
    expect(styleEl?.textContent).toContain("animation: none");
  });

  it("omits animation class when animated is false", () => {
    render(<MarchingAnts rect={{ x: 0, y: 0, width: 100, height: 100 }} animated={false} />);
    const rect = screen.getByTestId("marching-ants").querySelector("rect");
    expect(rect?.getAttribute("class")).toBeNull();
    expect(screen.queryByTestId("marching-ants-label")).toBeNull();
  });
});
