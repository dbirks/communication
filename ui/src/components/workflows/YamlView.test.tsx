/**
 * The workflow YAML tab's read-only panel (design 2d): block-style text, line
 * numbers, copy and download.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YamlView } from "./YamlView";

afterEach(cleanup);

const FLOW_TEXT = `spec:
  inputs:
    type: object
    required: [goal, repository]
  nodes:
  - id: survey
    kind: process.exec
`;

describe("YamlView", () => {
  it("renders the block-style text with one line number per line", () => {
    render(<YamlView text={FLOW_TEXT} filename="plan-with-approval-r1.yaml" />);
    expect(screen.getByTestId("yaml-view")).toBeTruthy();
    expect(screen.getByTestId("yaml-view-line-1").textContent).toContain("spec:");
    expect(screen.getByTestId("yaml-view-line-2").textContent).toContain("inputs:");
    expect(screen.getByTestId("yaml-view-line-3").textContent).toContain("type: object");
    expect(screen.getByTestId("yaml-view-line-4").textContent).toContain("required:");
    expect(screen.getByTestId("yaml-view-line-5").textContent).toContain("- goal");
  });

  it("serializes to block style: no flow collections in the output", () => {
    render(<YamlView text={FLOW_TEXT} filename="plan-with-approval-r1.yaml" />);
    const code = screen.getByTestId("yaml-view");
    expect(code.textContent).not.toContain("required: [goal");
    expect(code.textContent).toContain("required:");
    expect(code.textContent).toContain("- goal");
  });

  it("flattens nested flow maps like retry/backoff into blocks", () => {
    const retryText = `spec:
  nodes:
  - id: survey
    kind: process.exec
    retry: {maxAttempts: 2, backoff: {baseSeconds: 5}}
`;
    render(<YamlView text={retryText} filename="plan-with-approval-r1.yaml" />);
    const code = screen.getByTestId("yaml-view");
    expect(code.textContent).not.toContain("backoff: {");
    expect(code.textContent).toContain("backoff:");
    expect(code.textContent).toContain("maxAttempts: 2");
  });

  it("copies the block text to the clipboard and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<YamlView text={FLOW_TEXT} filename="plan-with-approval-r1.yaml" />);
    fireEvent.click(screen.getByTestId("yaml-view-copy"));
    expect(await screen.findByText("Copied")).toBeTruthy();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
  });

  it("downloads the block text as a blob url", () => {
    const createObjectURL = vi.fn(() => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    render(<YamlView text={FLOW_TEXT} filename="plan-with-approval-r1.yaml" />);
    fireEvent.click(screen.getByTestId("yaml-view-download"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalled();
  });
});
