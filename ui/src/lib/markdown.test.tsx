/**
 * The markdown reader: a plan body an agent wrote in markdown must reach the
 * reader as a plan, never as `## Step` and `**Files**`. Structure it can see
 * (headings, lists, fences, quotes, rules) becomes structure; inline markup
 * becomes spans; and a `javascript:` target is reduced to its label, because
 * this text is untrusted agent output.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownBody, parseInline, parseMarkdown, renderInline } from "./markdown";

afterEach(cleanup);

/**
 * The plan the pass-1 emulator's gate actually carried (`run-gate-waiting-1280.png`,
 * the `text` field of the model's answer, trimmed to its shape): four steps, each
 * with indented `- Files:` / `- Action:` / `- Verification:` bullets whose own
 * sentences wrap over indented lines, and a blank line before one step. Read the
 * old way, every step became its own list and printed “1.” — which is the
 * regression this fixture guards.
 */
const REAL_GATE_PLAN = [
  "**Plan for emu gate journey pass-1-20261101051222 — prove the gate and the plan artifact**",
  "",
  "1. **Confirm fixture integrity (read-only mount check)**",
  "   - Files: `README.md`, `pytest.ini`, `hello.py`",
  "     `tests/test_hello.py`",
  "   - Action: Verify all four files exist and `pytest.ini` contains the expected",
  "     `testpaths = tests` directive. Confirm the repo is mounted read-only at",
  "     `/srv/m4/fixtures` (attempt a write, expect `EROFS`).",
  "   - Verification: `ls -la` shows all files; `touch /srv/m4/fixtures/.write_test`",
  '     returns "Read-only file system".',
  "",
  "1. **Execute the gate: run `pytest` on the clean checkout (expected FAIL)**",
  "   - Files: `tests/test_hello.py`, `hello.py`",
  "   - Action: Run `pytest --tb=short -q` from the fixture root. Per",
  "     `docs/m4-contract.md` § 7.0, iteration 1 **must** exit non-zero.",
  "",
  "1. **Produce the plan artifact**",
  "   - Files: `(new)` `artifacts/plan-pass-1-20261101051222.md`",
  "   - Action: Write this very plan to the artifacts directory.",
  "   - Verification: `sha256sum artifacts/plan-pass-1-20261101051222.md` is recorded.",
  "",
  "1. **Cross-link and seal**",
  "   - Files: `artifacts/plan-pass-1-20261101051222.md`, `gate-proof.json`",
].join("\n");

describe("parseMarkdown", () => {
  it("keeps a step's nested bullets INSIDE the step, in one list", () => {
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
    // One list, and the nested bullet is the STEP's content (`children`) — the
    // old sibling-block shape is what made the next `1.` open a new list and
    // restart its numbering (pass-1 review item 1).
    expect(blocks[1]).toEqual({
      kind: "list",
      ordered: true,
      depth: 0,
      start: 1,
      items: [
        {
          text: "**Confirm repository binding**",
          children: [
            {
              kind: "list",
              ordered: false,
              depth: 1,
              start: 1,
              items: [{ text: "Files: `./README.md`, `./hello.py`", children: [] }],
            },
          ],
        },
      ],
    });
    // …and prose the author left after a blank line is still a paragraph, not a
    // fourth step.
    expect(blocks[2]).toEqual({ kind: "paragraph", text: "Run `pytest` before publishing." });
  });

  it("keeps ONE ordered list across nested bullets, indented lines and blank lines", () => {
    const blocks = parseMarkdown(REAL_GATE_PLAN);
    const lists = blocks.filter((block) => block.kind === "list");
    expect(lists.length).toBe(1);
    const plan = lists[0];
    if (plan.kind !== "list") throw new Error("the plan's steps are a list");
    expect(plan.ordered).toBe(true);
    expect(plan.depth).toBe(0);
    expect(plan.items.length).toBe(4);
    // Every step still carries its own bullets (nothing was flattened away): one
    // nested list per step, and they are bullets one level in, owned by the step.
    expect(plan.items.map((item) => item.children.length)).toEqual([1, 1, 1, 1]);
    const nested = plan.items[0].children[0];
    if (nested.kind !== "list") throw new Error("the step's evidence is its own list");
    expect([nested.ordered, nested.depth, nested.items.length]).toEqual([false, 1, 3]);
    expect(
      plan.items.map((item) => (item.children[0] as { items: unknown[] }).items.length),
    ).toEqual([3, 2, 3, 1]);
    // A wrapped sentence stayed the bullet's own text instead of becoming a
    // paragraph beside it.
    expect(nested.items[1].text).toContain("`testpaths = tests` directive.");
  });

  it("numbers a list from its own first marker", () => {
    expect(parseMarkdown("3. one\n4. two")[0]).toMatchObject({ start: 3, ordered: true });
    // A bullet list has no number to keep.
    expect(parseMarkdown("- one\n- two")[0]).toMatchObject({ start: 1, ordered: false });
  });

  it("splits lists where the author's kind or margin changes", () => {
    const blocks = parseMarkdown("1. step\n- bullet at the margin\n\ntail");
    expect(
      blocks.map((block) => [block.kind, block.kind === "list" ? block.ordered : undefined]),
    ).toEqual([
      ["list", true],
      ["list", false],
      ["paragraph", undefined],
    ]);
    // A dedented nested list closes the deeper level rather than nesting twice.
    const nested = parseMarkdown("1. step\n   - inner\n  - shallower\n2. next");
    const list = nested[0];
    if (list.kind !== "list") throw new Error("two lists expected");
    expect(list.items.length).toBe(2);
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

  it("keeps a table's rows as text instead of dropping them", () => {
    expect(parseMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toEqual([
      { kind: "paragraph", text: "| a | b |\n| - | - |\n| 1 | 2 |" },
    ]);
  });

  it("keeps an empty document empty", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("parseInline", () => {
  /**
   * The step heading the pass-2 review graded DEFECT on (`run-gate-waiting-*`,
   * `artifact-plan-md-1280.png`): a bold step that names a file in code and
   * italicises a word INSIDE the bold. The first parser read the outer `**…**`
   * run and printed what was inside it verbatim, so the phone and the desktop
   * both showed the author's backticks and asterisks.
   */
  const NESTED_STEP = "**Patch `hello.py` so the gate can be *disarmed* (…)**";

  it("nests code and emphasis INSIDE strong", () => {
    const runs = parseInline(NESTED_STEP);
    expect(runs.length).toBe(1);
    const step = runs[0];
    if (step.kind !== "strong") throw new Error("the whole step is one bold span");
    // The span's text is what a reader sees: markers read, not printed.
    expect(step.text).toBe("Patch hello.py so the gate can be disarmed (…)");
    expect(step.children?.map((child) => [child.kind, child.text])).toEqual([
      ["text", "Patch "],
      ["code", "hello.py"],
      ["text", " so the gate can be "],
      ["italic", "disarmed"],
      ["text", " (…)"],
    ]);
    // Nothing in the whole span still carries a marker.
    expect(step.children?.map((child) => child.text).join("")).not.toMatch(/[`*]/);
  });

  it("nests strong and code INSIDE emphasis, and a link inside strong", () => {
    // A `*`-emphasis carrying a strong run: the closer is the LAST `*`, not the
    // first one the inner `**` leaves behind — a shortest-match regex ate the
    // sentence apart here.
    expect(parseInline("*note **this** and `that`*")[0]).toMatchObject({
      kind: "italic",
      text: "note this and that",
      children: [
        { kind: "text", text: "note " },
        { kind: "strong", text: "this" },
        { kind: "text", text: " and " },
        { kind: "code", text: "that" },
      ],
    });
    expect(parseInline("**see [the plan](https://example.com/p) now**")[0]).toMatchObject({
      kind: "strong",
      children: [
        { kind: "text", text: "see " },
        { kind: "link", text: "the plan", href: "https://example.com/p" },
        { kind: "text", text: " now" },
      ],
    });
  });

  it("keeps markup written inside a code span literal, nested or not", () => {
    expect(parseInline("**run `**not bold**` now**")[0]).toMatchObject({
      kind: "strong",
      text: "run **not bold** now",
      children: [
        { kind: "text", text: "run " },
        { kind: "code", text: "**not bold**" },
        { kind: "text", text: " now" },
      ],
    });
  });

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

  it("reads *emphasis* and _emphasis_, including a run that opens on punctuation", () => {
    // The shape the design review caught printing its own asterisks: an
    // italicised parenthetical inside a plan line.
    expect(parseInline("Approved *(read-only — no edits)* by design")).toEqual([
      { kind: "text", text: "Approved " },
      { kind: "italic", text: "(read-only — no edits)" },
      { kind: "text", text: " by design" },
    ]);
    expect(parseInline("note _(see the plan)_ here")).toEqual([
      { kind: "text", text: "note " },
      { kind: "italic", text: "(see the plan)" },
      { kind: "text", text: " here" },
    ]);
    expect(parseInline("_ship it_")).toEqual([{ kind: "italic", text: "ship it" }]);
    // Strong still wins, and a code span still keeps its markers literal.
    expect(parseInline("**bold** and `*not italic*`")).toEqual([
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "code", text: "*not italic*" },
    ]);
  });

  it("keeps emphasis markers that are not emphasis", () => {
    // Multiplication, footnote-ish markers and intra-word underscores stay text.
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("see note* and price* now")).toEqual([
      { kind: "text", text: "see note* and price* now" },
    ]);
    expect(parseInline("run_pytest_now_ and *quoted")).toEqual([
      { kind: "text", text: "run_pytest_now_ and *quoted" },
    ]);
    // A run that DOES close is markup, and its markers go with it — exactly as
    // markdown renders `*(b*` (the second `*` closes the first).
    expect(parseInline("a *(b* c)")).toEqual([
      { kind: "text", text: "a " },
      { kind: "italic", text: "(b" },
      { kind: "text", text: " c)" },
    ]);
    // Every character survives, in order, when the markers never pair up.
    const joined = parseInline("a *(b c **d_) e")
      .map((run) => run.text)
      .join("");
    expect(joined).toBe("a *(b c **d_) e");
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
  /** The number each TOP-LEVEL step prints (nested bullets are not `ol > li`). */
  const printedNumbers = (): string[] =>
    Array.from(
      document.querySelectorAll('[data-testid="markdown-list-ordered"] > li > span[aria-hidden]'),
    ).map((node) => node.textContent ?? "");

  it("numbers a real gate plan 1…N, not 1 for every step", () => {
    render(<MarkdownBody text={REAL_GATE_PLAN} />);
    // The pass-1 screenshot: `run-gate-waiting-1280.png` printed “1.” six times
    // over. The steps are one list, so the reader can say which step is which.
    expect(printedNumbers()).toEqual(["1.", "2.", "3.", "4."]);
    expect(screen.getByTestId("markdown-list-ordered").getAttribute("start")).toBe("1");
    // The nested evidence is still there, under its own step.
    const nestedLists = screen.getAllByTestId("markdown-list");
    expect(nestedLists).toHaveLength(4);
    expect(nestedLists[0].textContent).toContain("README.md");
  });

  it("counts an ordered list from the number the author started it with", () => {
    render(<MarkdownBody text={"3. third\n4. fourth\n   - nested\n5. fifth"} />);
    expect(printedNumbers()).toEqual(["3.", "4.", "5."]);
    expect(screen.getByTestId("markdown-list-ordered").getAttribute("start")).toBe("3");
  });

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

  it("scrolls a long fence inside its own box instead of widening the page", () => {
    // `artifact-plan-md-390.png`: one 400-character JSON string on a line of its
    // own pushed the whole page sideways. A definite width is what takes the
    // fence's max-content size out of the ancestors' arithmetic.
    render(<MarkdownBody text={'```json\n{"summary": "' + "x".repeat(400) + '"}\n```'} />);
    const code = screen.getByTestId("markdown-code");
    expect(code.getAttribute("style")).toContain("min-width: 100%");
    expect(code.className).toContain("overflow-x-auto");
    // The scroll box now lives inside a positioning wrapper (the fade's
    // anchor); the wrapper never outgrows its parent either.
    const box = screen.getByTestId("markdown-code-box");
    expect(box.className).toContain("max-w-full");
  });

  it("gives a list item's content the width the marker leaves over", () => {
    // Pass-2 review of the same 400-character fence, now written as step 3 of a
    // plan: it printed ~210px inside a ~1000px column at 1280 and clipped its
    // lines. The item's content column has to FILL the `<li>`; sizing to its
    // content collapses it, because the fence itself contributes no width
    // (`width:0; min-width:100%`). jsdom lays nothing out, so this checks the
    // classes the layout rests on, not a measured width.
    render(
      <MarkdownBody
        text={
          '3. **Pin the revision**\n   ```json\n   {"summary": "' + "x".repeat(400) + '"}\n   ```'
        }
      />,
    );
    const item = screen.getByTestId("markdown-list-item");
    // The row is a flex box and the marker never stretches or shrinks.
    expect(item.className).toContain("flex");
    expect(item.querySelector(":scope > span[aria-hidden]")?.className).toContain("shrink-0");

    const content = screen.getByTestId("markdown-list-item-content");
    expect(content.className).toContain("flex-1");
    // …and can still shrink below its content, which is what keeps a long line
    // from pushing the page sideways at 390.
    expect(content.className).toContain("min-w-0");

    // The fence is laid out inside that filling column, and still scrolls in
    // its own box rather than measuring its longest line.
    const code = screen.getByTestId("markdown-code");
    expect(content.contains(code)).toBe(true);
    expect(code.getAttribute("style")).toContain("width: 0px");
    expect(code.getAttribute("style")).toContain("min-width: 100%");
    expect(code.className).toContain("overflow-x-auto");
  });

  it("fades the code box's right edge only while content sits off to the right", () => {
    // pass-1 review minor 3: the 2e gate plan's wide fences cut mid-token with
    // no visible hint. The fade appears when the box overflows and clears
    // when the reader has scrolled to the end of the line.
    render(<MarkdownBody text={"```\n" + "const schedul = ".repeat(40) + "\n```"} />);
    const code = screen.getByTestId("markdown-code");
    const fade = screen.getByTestId("markdown-code-fade");
    expect(fade.getAttribute("aria-hidden")).toBe("true");
    // jsdom lays nothing out: nothing overflows, so the fade stands down.
    expect(fade.getAttribute("data-more")).toBe("false");
    const stub = (prop: string, value: number) =>
      Object.defineProperty(code, prop, { configurable: true, value });
    stub("scrollWidth", 640);
    stub("clientWidth", 320);
    stub("scrollLeft", 0);
    fireEvent.scroll(code);
    expect(fade.getAttribute("data-more")).toBe("true");
    expect(fade.className).toContain("opacity-100");
    stub("scrollLeft", 320);
    fireEvent.scroll(code);
    expect(fade.getAttribute("data-more")).toBe("false");
    expect(fade.className).toContain("opacity-0");
  });

  it("renders no anchor for a link whose target is not http(s)", () => {
    render(<MarkdownBody text={"[danger](javascript:alert(1))"} />);
    expect(screen.getByText("danger").tagName).toBe("SPAN");
  });

  it("draws emphasis as italic, not as asterisks", () => {
    render(
      <MarkdownBody
        text={"## Plan *(read-only — no edits)*\n\nShip `_next_` and *(maybe)* both."}
      />,
    );
    expect(screen.getByTestId("markdown-heading").textContent).toBe("Plan (read-only — no edits)");
    expect(Array.from(document.querySelectorAll("em")).map((node) => node.textContent)).toEqual([
      "(read-only — no edits)",
      "(maybe)",
    ]);
    // The underscore run inside the code span stays the author's own text.
    expect(document.querySelector("code")?.textContent).toBe("_next_");
  });

  it("renders nothing for an empty body", () => {
    render(<MarkdownBody text="" />);
    expect(screen.getByTestId("markdown-body").children.length).toBe(0);
  });

  /**
   * The fragment the pass-2 review graded DEFECT on: a gate step that is a bold
   * heading, names the file it patches in code, and italicises a word — all
   * three inside the bold. Nothing here is allowed to reach the reader as
   * markup characters (`artifact-plan-md-1280.png` showed `` `hello.py` `` and
   * `*disarmed*` printed at the reader).
   */
  const NESTED_STEP = "**Patch `hello.py` so the gate can be *disarmed* (…)**";

  /** The ink a reader gets: `<code>` and `<em>` inside the `<strong>`, with no
   * marker characters anywhere in the text. */
  const expectNestedStep = (container: Element): void => {
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.querySelector("code")?.textContent).toBe("hello.py");
    expect(strong?.querySelector("em")?.textContent).toBe("disarmed");
    expect(strong?.textContent).toBe("Patch hello.py so the gate can be disarmed (…)");
    expect(container.textContent).not.toContain("`");
    expect(container.textContent).not.toContain("*");
  };

  it("nests code and emphasis inside a bold step written as a list item", () => {
    render(
      <MarkdownBody
        text={["1. " + NESTED_STEP, "   - Verification: `pytest`", "2. Run the gate"].join("\n")}
      />,
    );
    const item = screen.getAllByTestId("markdown-list-item")[0];
    expectNestedStep(item);
    // …and the plan is still one numbered plan (nesting did not restart it).
    expect(screen.getByTestId("markdown-list-ordered").textContent).toContain("2.");
  });

  it("nests code and emphasis inside a bold step written as a heading", () => {
    render(<MarkdownBody text={"## " + NESTED_STEP} />);
    expectNestedStep(screen.getByTestId("markdown-heading"));
  });

  it("nests code and emphasis inside a bold step written as a paragraph", () => {
    render(<MarkdownBody text={NESTED_STEP} />);
    expectNestedStep(screen.getByTestId("markdown-paragraph"));
  });

  it("reads code inside a heading, and emphasis inside strong inside a list item", () => {
    render(
      <MarkdownBody
        text={[
          "### Gate `disarm` is a *flag* now",
          "",
          "- **Undo the gate *carefully* and run `pytest`**",
        ].join("\n")}
      />,
    );
    const heading = screen.getByTestId("markdown-heading");
    expect(heading.querySelector("code")?.textContent).toBe("disarm");
    expect(heading.querySelector("em")?.textContent).toBe("flag");
    expect(heading.textContent).toBe("Gate disarm is a flag now");
    const item = screen.getAllByTestId("markdown-list-item")[0];
    expect(item.querySelector("strong > em")?.textContent).toBe("carefully");
    expect(item.querySelector("strong > code")?.textContent).toBe("pytest");
    expect(item.querySelector("strong")?.textContent).toBe(
      "Undo the gate carefully and run pytest",
    );
  });

  it("renders a link nested in strong as an anchor inside the strong", () => {
    render(<MarkdownBody text={"**Blocked by [the gate](https://example.com/g)**"} />);
    const link = document.querySelector("strong > a");
    expect(link?.getAttribute("href")).toBe("https://example.com/g");
    expect(link?.textContent).toBe("the gate");
    expect(screen.getByTestId("markdown-paragraph").textContent).toBe("Blocked by the gate");
  });
});

describe("renderInline", () => {
  it("returns one node per span, in order", () => {
    expect(renderInline("a **b** `c`").length).toBe(4);
  });
});
