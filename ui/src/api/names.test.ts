/**
 * `humanIdsIn` decides which ids a surface will ask the directory about, so it
 * is worth pinning: miss one and a person is read as "someone (abc12345)";
 * over-collect and a policy pseudo-id or an agent id becomes a lookup the page
 * can never satisfy.
 */
import { describe, expect, it } from "vitest";
import { humanIdsIn, shortId } from "./names";

const frame = (kind: string, id: string | null, payload: Record<string, unknown> = {}) => ({
  actor: { kind, id },
  payload,
});

describe("humanIdsIn", () => {
  it("collects the humans a journal names, in the order a reader meets them", () => {
    const ids = humanIdsIn([
      frame("human", "u-ada", { turn_id: "t1", submitted_by: "u-bob" }),
      frame("agent", "01987a71-2222-7000-8000-abcdef012345", { decided_by: "u-carol" }),
      frame("human", "u-dana", { to_user_id: "u-erin", from_user_id: "u-ada" }),
    ]);
    expect(ids).toEqual(["u-ada", "u-bob", "u-carol", "u-dana", "u-erin"]);
  });

  it("asks about each person once, however many frames mention them", () => {
    const ids = humanIdsIn([
      frame("human", "u-ada", { submitted_by: "u-ada", requested_by: "u-ada" }),
      frame("human", "u-ada", { decided_by: "u-ada" }),
    ]);
    expect(ids).toEqual(["u-ada"]);
  });

  it("leaves out actors that are not people and ids that are not ids", () => {
    const ids = humanIdsIn(
      [
        frame("system", "system", { decided_by: "profile_policy:deny" }),
        frame("worker", "worker_a", { decided_by: "node_policy:preapproved_within_sandbox" }),
        frame("integration", "github", { edited_by: null, cleaned_by: "  " }),
        frame("agent", "01987a71-2222-7000-8000-abcdef012345", {}),
        { actor: undefined, payload: undefined },
      ],
      [null, undefined, "", "workspace_policy:deny"],
    );
    expect(ids).toEqual([]);
  });

  it("includes the ids a row carries that the journal never repeats", () => {
    expect(humanIdsIn([], ["u-controller", "u-creator"])).toEqual(["u-controller", "u-creator"]);
  });

  it("shortens an id by its random tail, which is what the fallback prints", () => {
    // Same 8 characters the transcript fell back to in the lab: the tail of the
    // uuid, not the millisecond prefix every nearby-created id shares.
    expect(shortId("01a18ae0-8d98-710c-b223-f2842f12d936")).toBe("2f12d936");
  });
});
