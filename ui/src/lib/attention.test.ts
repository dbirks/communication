/**
 * The row-level rules attention lists share: a gate's title drops the plan JSON
 * a template interpolation glued onto it (`live-board.png`), and what is left
 * is clamped rather than allowed to stretch a card down the page.
 */
import { describe, expect, it } from "vitest";
import { ATTENTION_TITLE_CLAMP, attentionTitle } from "./attention";

/** The live board's second card, verbatim: a lead-in and the whole plan. */
const PLAN_GATE = `Plan for Document and fix add() in hello.py
{"acceptance":["pytest passes in app/ with both tests green","add.__doc__ is a non-empty, accurate docstring"],"findings":["app/hello.py:1: add(a, b) returns a + b, which is already the correct sum."],"goal":"Document and fix add() in app/hello.py","risks":["If the checkout is read-only, steps 1-2 need a writable copy of the repo."],"steps":[{"action":"Add a docstring to add() that says it returns the sum of a and b.","file":"app/hello.py","id":1}]}`;

describe("attentionTitle", () => {
  it("keeps the lead-in and drops the plan JSON", () => {
    expect(attentionTitle(PLAN_GATE)).toBe("Plan for Document and fix add() in hello.py");
  });

  it("leaves a prose summary untouched", () => {
    expect(attentionTitle("Approve spec: claims export v2")).toBe("Approve spec: claims export v2");
  });

  it("leaves prose that merely mentions a brace alone", () => {
    expect(attentionTitle("Check the {config} section")).toBe("Check the {config} section");
  });

  it("shows a summary that is only the object rather than going blank", () => {
    const only = '{"goal":"Ship","steps":[]}';
    expect(attentionTitle(only)).toBe(only);
  });

  it("trims the whitespace around the prefix", () => {
    expect(attentionTitle('  Plan ready  \n  {"goal":"Ship"}  ')).toBe("Plan ready");
  });

  it("drops an unparseable object with key-shaped text after the brace", () => {
    expect(attentionTitle('Plan for X\n{"goal":"Ship"\n]')).toBe("Plan for X");
  });

  it("clamps a title to two lines", () => {
    expect(ATTENTION_TITLE_CLAMP).toBe("line-clamp-2");
  });
});
