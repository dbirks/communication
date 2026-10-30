/**
 * The markdown reader: a plan body an agent wrote in markdown must reach the
 * reader as a plan, never as `## Step` and `**Files**`. Structure it can see
 * (headings, lists, fences, quotes, rules) becomes structure; inline markup
 * becomes spans; and a `javascript:` target is reduced to its label, because
 * this text is untrusted agent output.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownBody, parseInline, parseMarkdown, renderInline } from "./markdown";

afterEach(cleanup);

describe("parseMarkdown", () => {
  it("reads the shape the gate's plan document has", () => {
    const blocks = parseMarkdown(
      [
        "## Implementation Plan — emu gate journey",
        "",
        "1. **Confirm repository binding**",
        "   - Files: `./README.md`, `./hello.py`",
        "",
        "Run `pytest` before publishing.",
      ].join("\n"),
    );
    expect(blocks[0]).toEqual({
      kind: "heading",
      level: 2,
      text: "Implementation Plan — emu gate journey",
    });
    expect(blocks[1]).toMatchObject({
      kind: "list",
      ordered: true,
      items: ["**Confirm repository binding**"],
    });
    expect(blocks[2]).toMatchObject({
      kind: "list",
      ordered: false,
      depth: 1,
      items: ["Files: `./README.md`, `./hello.py`"],
    });
    expect(blocks[3]).toEqual({ kind: "paragraph", text: "Run `pytest` before publishing." });
  });

  it("keeps a fenced block verbatim, with no markup applied inside it", () => {
    const blocks = parseMarkdown("before\n\n```sh\nls -la\n# not a heading\n```\n\nafter");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toEqual({ kind: "code", text: "ls -la\n# not a heading" });
  });

  it("shows an unterminated fence rather than swallowing the tail", () => {
    const blocks = parseMarkdown("```sh\nls -la");
    expect(blocks).toEqual([{ kind: "code", text: "ls -la" }]);
  });

  it("sees a rule, a quote and a bullet list", () => {
    const blocks = parseMarkdown("- one\n- two\n\n> noted\n\n---");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "quote", "rule"]);
  });

  it("leaves a table's rows as text instead of dropping them", () => {
    const blocks = parseMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(blocks).toEqual([{ kind: "paragraph", text: "| a | b |\n| - | - |\n| 1 | 2 |" }]);
  });

  it("keeps an empty document empty", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("marks code spans and strong runs", () => {
    expect(parseInline("write `plan.md` and **prove** it")).toEqual([
      { kind: "text", text: "write " },
      { kind: "code", text: "plan.md" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "prove" },
      { kind: "text", text: " it" },
    ]);
  });

  it("reads an http link and refuses any other target", () => {
    expect(parseInline("[diff](https://example.com/a)")).toEqual([
      { kind: "link", text: "diff", href: "https://example.com/a" },
    ]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { kind: "link", text: "click", href: null },
    ]);
  });

  it("treats a marker that opens nothing as the text it is", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
    expect(parseInline("a ` lone backtick")).toEqual([{ kind: "text", text: "a ` lone backtick" }]);
    expect(parseInline("**unclosed")).toEqual([{ kind: "text", text: "**unclosed" }]);
    // Every character survives, in order — a reader never loses a word to markup.
    const joined = parseInline("a `b** [c](")
      .map((run) => run.text)
      .join("");
    expect(joined).toBe("a `b** [c](");
  });

  it("keeps markup inside a code span literal", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });
});

describe("<MarkdownBody>", () => {
  it("renders the raw gate body of the design review as markup, not markers", () => {
    render(
      <MarkdownBody
        text={
          "## Implementation Plan\n\n1. **Confirm repository binding and file inventory**\n   - Files: `./README.md`, `./hello.py`\n"
        }
      />,
    );
    expect(screen.getByTestId("markdown-heading").textContent).toBe("Implementation Plan");
    expect(screen.getByTestId("markdown-heading").textContent).not.toContain("##");
    const items = screen.getAllByTestId("markdown-list-item");
    expect(items[0].querySelector("strong")?.textContent).toBe(
      "Confirm repository binding and file inventory",
    );
    expect(items[0].textContent).not.toContain("**");
    const files = items[1];
    expect(files.querySelector("code")?.textContent).toBe("./README.md");
    expect(files.textContent).not.toContain("`");
  });

  it("draws a fence as a code block and a safe link as a link", () => {
    render(<MarkdownBody text={"```\npytest -q\n```\n\n[plan](https://example.com/plan.md)"} />);
    expect(screen.getByTestId("markdown-code").textContent).toBe("pytest -q");
    const link = screen.getByText("plan");
    expect(link.getAttribute("href")).toBe("https://example.com/plan.md");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("renders no anchor for a link whose target is not http(s)", () => {
    render(<MarkdownBody text={"[danger](javascript:alert(1))"} />);
    expect(screen.getByText("danger").tagName).toBe("SPAN");
  });

  it("renders nothing for an empty body", () => {
    render(<MarkdownBody text="" />);
    expect(screen.getByTestId("markdown-body").children.length).toBe(0);
  });
});

describe("renderInline", () => {
  it("returns one node per span, in order", () => {
    expect(renderInline("a **b** `c`").length).toBe(4);
  });
});
