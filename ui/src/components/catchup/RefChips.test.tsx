/**
 * The ref chips (ADR-0078 § Decision 6): a number the assistant claimed is a
 * label; the same number with a server-computed `url` is a link. The chip must
 * never invent a destination — no url, no anchor — and an external link carries
 * the `rel` that keeps the reader's session out of the Referer.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CatchUpRefs } from "../../api/catchup";
import { RefChips } from "./RefChips";

afterEach(cleanup);

describe("RefChips", () => {
  it("links the refs the server gave a url to", () => {
    const refs: CatchUpRefs = {
      issues: [{ number: 215, url: "https://github.com/octo/widgets/issues/215" }],
      pull_requests: [{ number: 417, url: "https://github.com/octo/widgets/pull/417" }],
      commits: [
        { sha: "a1f9c2e0deadbeef", url: "https://github.com/octo/widgets/commit/a1f9c2e0deadbeef" },
      ],
    };
    render(<RefChips refs={refs} />);
    const issue = screen.getByTestId("catchup-ref-issue-215");
    expect(issue.tagName).toBe("A");
    expect(issue.getAttribute("href")).toBe("https://github.com/octo/widgets/issues/215");
    expect(issue.getAttribute("target")).toBe("_blank");
    expect(issue.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByTestId("catchup-ref-pr-417").getAttribute("href")).toBe(
      "https://github.com/octo/widgets/pull/417",
    );
    // The commit chip keeps the 7-char label the design draws.
    const commit = screen.getByTestId("catchup-ref-commit-a1f9c2e0deadbeef");
    expect(commit.textContent).toContain("a1f9c2e");
    expect(commit.getAttribute("href")).toBe(
      "https://github.com/octo/widgets/commit/a1f9c2e0deadbeef",
    );
  });

  it("keeps a ref with no url the plain label it shipped as", () => {
    render(
      <RefChips refs={{ issues: [{ number: 215 }], commits: [{ sha: "a1f9c2e0deadbeef" }] }} />,
    );
    const issue = screen.getByTestId("catchup-ref-issue-215");
    expect(issue.tagName).toBe("SPAN");
    expect(issue.textContent).toBe("#215");
    expect(screen.getByTestId("catchup-ref-commit-a1f9c2e0deadbeef").tagName).toBe("SPAN");
  });

  it("draws nothing when the work touched nothing", () => {
    const { container } = render(<RefChips refs={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
