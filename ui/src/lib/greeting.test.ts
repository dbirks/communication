/**
 * The greeting rules (`lib/greeting.ts`), the helper Home and Inbox share.
 * The clock is the caller's `Date`, so every case builds a local date and the
 * part-of-day cuts are checked at their exact hour boundaries.
 */
import { describe, expect, it } from "vitest";
import { greeting } from "./greeting";

const atHour = (hour: number): Date => new Date(2026, 9, 14, hour, 0, 0);

describe("greeting", () => {
  it("cuts the day at 12 and 18 (morning before noon, afternoon until 18, evening after)", () => {
    expect(greeting(atHour(0), "Ada Lovelace")).toBe("Good morning, Ada");
    expect(greeting(atHour(11), "Ada Lovelace")).toBe("Good morning, Ada");
    expect(greeting(atHour(12), "Ada Lovelace")).toBe("Good afternoon, Ada");
    expect(greeting(atHour(17), "Ada Lovelace")).toBe("Good afternoon, Ada");
    expect(greeting(atHour(18), "Ada Lovelace")).toBe("Good evening, Ada");
    expect(greeting(atHour(23), "Ada Lovelace")).toBe("Good evening, Ada");
  });

  it("uses only the first name of a multi-word display name", () => {
    expect(greeting(atHour(9), "Ada Lovelace")).toContain("Ada");
    expect(greeting(atHour(9), "Ada  Grace  Lovelace")).toBe("Good morning, Ada");
  });

  it("trims surrounding whitespace before taking the first name", () => {
    expect(greeting(atHour(9), "  Ada Lovelace  ")).toBe("Good morning, Ada");
  });

  it("falls back to 'there' when the wire has no name yet", () => {
    expect(greeting(atHour(9), undefined)).toBe("Good morning, there");
    expect(greeting(atHour(9), null)).toBe("Good morning, there");
    expect(greeting(atHour(9), "")).toBe("Good morning, there");
    expect(greeting(atHour(9), "   ")).toBe("Good morning, there");
  });
});
