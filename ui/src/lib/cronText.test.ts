import { describe, expect, it } from "vitest";
import { cronInWords } from "./cronText";

describe("cronInWords — the plain-English reading of a schedule's cron", () => {
  it("translates the shapes the triggers presets offer", () => {
    expect(cronInWords("* * * * *")).toBe("every minute");
    expect(cronInWords("0 * * * *")).toBe("hourly");
    expect(cronInWords("0 9 * * *")).toBe("daily 09:00 UTC");
    expect(cronInWords("0 14 * * *")).toBe("daily 14:00 UTC");
    expect(cronInWords("0 9 * * 1-5")).toBe("every weekday at 09:00 UTC");
    expect(cronInWords("0 14 * * 1-5")).toBe("every weekday at 14:00 UTC");
    expect(cronInWords("0 9 * * 1")).toBe("weekly Monday 09:00 UTC");
    expect(cronInWords("0 9 * * 0")).toBe("weekly Sunday 09:00 UTC");
    expect(cronInWords("0 8 * * 6")).toBe("weekly Saturday 08:00 UTC");
  });

  it("normalises stray whitespace before reading it", () => {
    expect(cronInWords("  0   9 * * 1 ")).toBe("weekly Monday 09:00 UTC");
  });

  it("falls back to the raw expression for shapes it does not claim to translate", () => {
    expect(cronInWords("*/15 8-17 * * 2-4")).toBe("*/15 8-17 * * 2-4");
    expect(cronInWords("@daily")).toBe("@daily");
    expect(cronInWords("not a cron")).toBe("not a cron");
  });
});
