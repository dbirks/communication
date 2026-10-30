/**
 * `shortBranch` — the one rule every screen shares for showing a git ref on a
 * quiet single line (design 1e/2e's `run/9c1e04f2/storefront`). The rest of
 * `format.ts` is exercised by the pages that read it; this helper is the one
 * with a machine-name-vs-person-name judgement in it.
 */
import { describe, expect, it } from "vitest";
import { shortBranch } from "./format";
import { shortId } from "../api/names";

describe("shortBranch — a git ref shortened for display", () => {
  it("shortens a uuid segment by shortId's rule (the tail), not the timestamp head", () => {
    // The head of a UUIDv7 is a millisecond timestamp: every run seeded in the
    // same minute shares `01a18abe`, so a prefix is the least useful thing to
    // print. The row's owner line prints `Run #<shortId>`; the ref must print
    // the same eight characters.
    const uuid = "01a18abe-9e08-7206-a76a-ad1da1d71e29";
    expect(shortBranch(`${uuid}/app`)).toBe(`${shortId(uuid)}/app`);
    expect(shortBranch(`${uuid}/app`)).toBe("a1d71e29/app");
    expect(shortBranch(`run/${uuid}/storefront`)).toBe("run/a1d71e29/storefront");
  });

  it("tells two sibling branches with the same uuid head apart", () => {
    // Both were created in the same millisecond bucket: `01a18abe` for both.
    const left = "01a18abe-9e08-7206-a76a-ad1da1d71e29";
    const right = "01a18abe-9db3-7ea5-9d33-51a2e72264a5";
    expect(left.slice(0, 8)).toBe(right.slice(0, 8));
    expect(shortBranch(`${left}/app`)).toBe("a1d71e29/app");
    expect(shortBranch(`${right}/app`)).toBe("e72264a5/app");
    expect(shortBranch(`${left}/app`)).not.toBe(shortBranch(`${right}/app`));
  });

  it("leaves a person's own segment names exactly as written", () => {
    expect(shortBranch("main")).toBe("main");
    expect(shortBranch("run-9c1e04f2/communication")).toBe("run-9c1e04f2/communication");
    expect(shortBranch("feature/login")).toBe("feature/login");
    // Hex-ish but far too short to be machine output: a name, not an id.
    expect(shortBranch("deadbeef")).toBe("deadbeef");
    expect(shortBranch("refs/heads/release-2026-10-14")).toBe("refs/heads/release-2026-10-14");
  });

  it("reads a dashless sha the way git does — from the front", () => {
    expect(shortBranch("9b3d7e1f222222222222222222222222222222222222222222222222222")).toBe(
      "9b3d7e1f",
    );
    expect(shortBranch("run/3acceb6285f24d1e8f7a6b5c4d3e2f109a8b7c6d/app")).toBe(
      "run/3acceb62/app",
    );
  });

  it("shortens every uuid segment in the ref, not just the first", () => {
    expect(
      shortBranch("01a18abe-9e08-7206-a76a-ad1da1d71e29/01a18abe-0000-0000-0000-000000000001/app"),
    ).toBe("a1d71e29/00000001/app");
  });

  it("is empty for what is not there", () => {
    expect(shortBranch("")).toBe("");
    expect(shortBranch(null)).toBe("");
    expect(shortBranch(undefined)).toBe("");
  });
});
