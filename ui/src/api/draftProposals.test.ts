/**
 * `api/draftProposals.ts` — the draft-proposal error mapping (ADR-0044): the
 * Studio box renders the line straight off the problem body's `degraded` code,
 * never the bare status. A 503 `assistant_not_configured` is a deployment fact;
 * a 503 that named a transient upstream cause is the retry line.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import type { components } from "./schema";
import { draftProposalErrorOf } from "./draftProposals";

function assistantProblem(
  status: number,
  degraded: string | null,
  detail = "",
): components["schemas"]["Problem"] {
  const body: components["schemas"]["Problem"] & { degraded?: string } = {
    type: "https://communication.dev/errors/assistant-degraded",
    title: "Assistant unavailable",
    status,
    detail,
  };
  if (degraded) body.degraded = degraded;
  return body;
}

describe("draftProposalErrorOf", () => {
  it("maps the assistant_not_configured degraded code to the not-configured line", () => {
    expect(
      draftProposalErrorOf(
        new ApiError(assistantProblem(503, "assistant_not_configured", "no assistant"), null),
      ),
    ).toBe("The assistant is not configured on this server.");
  });

  it("maps a transient upstream degraded code to the retry line, not the not-configured one", () => {
    expect(
      draftProposalErrorOf(
        new ApiError(
          assistantProblem(503, "model_unreachable", "the model endpoint returned 503"),
          null,
        ),
      ),
    ).toBe(
      "The assistant's model is unavailable right now — try again. the model endpoint returned 503",
    );
  });

  it("maps a model_timeout degraded code to the retry line", () => {
    expect(
      draftProposalErrorOf(
        new ApiError(assistantProblem(504, "model_timeout", "no completion within 30s"), null),
      ),
    ).toBe("The assistant's model is unavailable right now — try again. no completion within 30s");
  });

  it("keeps the stale-draft and invalid-proposal mappings", () => {
    expect(
      draftProposalErrorOf(
        new ApiError(
          {
            type: "https://communication.dev/errors/stale_draft_version",
            title: "Conflict",
            status: 409,
            detail: "draft moved",
          },
          null,
        ),
      ),
    ).toBe("The draft changed — reload before asking.");
    expect(
      draftProposalErrorOf(
        new ApiError(
          {
            type: "https://communication.dev/errors/assistant_proposal_invalid",
            title: "Assistant Proposal Invalid",
            status: 422,
            detail: "node id not in draft",
          },
          null,
        ),
      ),
    ).toBe("node id not in draft");
  });

  it("falls back to the problem detail for an unknown failure", () => {
    expect(
      draftProposalErrorOf(
        new ApiError(
          { type: "about:blank", title: "Internal Server Error", status: 500, detail: "boom" },
          null,
        ),
      ),
    ).toBe("boom");
  });
});
