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

  it("names the export button `download`, with the file's name as its title", () => {
    // The 390 design check: the button used to print the whole
    // `<slug>-r<n>.yaml`, which the panel header cut in half.
    render(<YamlView text={FLOW_TEXT} filename="plan-with-approval-r1.yaml" />);
    const button = screen.getByTestId("yaml-view-download");
    expect(button.textContent).toBe("download");
    expect(button.getAttribute("title")).toBe("plan-with-approval-r1.yaml");
    expect(button.getAttribute("aria-label")).toBe("download plan-with-approval-r1.yaml");
    expect(button.className).not.toContain("truncate");
  });

  it("keeps the header's Copy · download inside the bar's line box (390)", () => {
    // Below 560px the shell's phone floor (tokens.css `APP-SHELL-PHONE`) makes
    // every `main button` 44px tall; the bar holds one line by clipping that
    // growth (the Repositories `+ add` treatment) instead of growing to 53px
    // while every other panel's header stays 23px. The clip lives on a wrapper
    // that both buttons share — at 560px and above it stops clipping.
    render(<YamlView text={FLOW_TEXT} filename="plan-with-approval-r1.yaml" />);
    const copy = screen.getByTestId("yaml-view-copy");
    const download = screen.getByTestId("yaml-view-download");
    const wrap = copy.parentElement as HTMLElement;
    expect(wrap).toBe(download.parentElement);
    expect(wrap.className).toContain("h-[14px]");
    expect(wrap.className).toContain("overflow-hidden");
    expect(wrap.className).toContain("min-[560px]:h-auto");
    expect(wrap.className).toContain("min-[560px]:overflow-visible");
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
