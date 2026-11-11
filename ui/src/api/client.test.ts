/**
 * `api/client.ts` — the typed error boundary: the `ApiError` carries the
 * problem body's `degraded` cause, and the assistant retry line is derived
 * from it (never from the bare status).
 */
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ASSISTANT_FAILURE_DEFAULT_LINE,
  ASSISTANT_FAILURE_LINES,
  assistantFailureLine,
  assistantTransientErrorLine,
  isRawAssistantErrorText,
  isUpstreamModelUnavailable,
  problemCauseOf,
} from "./client";
import { assistantNotConfigured } from "./assistant";

function assistantError(degraded: string | null, status = 503, detail = ""): ApiError {
  const body = {
    type: "https://communication.dev/errors/assistant-degraded",
    title: "Assistant unavailable",
    status,
    detail,
    ...(degraded ? { degraded } : {}),
  };
  return new ApiError(body, body);
}

describe("ApiError.degraded", () => {
  it("reads the degraded cause off the problem body", () => {
    const error = assistantError("assistant_not_configured", 503, "no assistant endpoint");
    expect(error.degraded).toBe("assistant_not_configured");
    expect(error.status).toBe(503);
    expect(error.detail).toBe("no assistant endpoint");
  });

  it("is null when the problem body names no cause", () => {
    expect(assistantError(null, 500, "boom").degraded).toBeNull();
  });
});

describe("assistantTransientErrorLine", () => {
  /**
   * Deployed finding (TODO § 5, rerun 18): a Collective 503 reached the thread as
   * `The assistant's model is unavailable right now — try again. llm-collective…
   * returned http 503 Your question was not sent — send it again.` — the endpoint's
   * own status line inside a sentence, and a second instruction after it. The
   * upstream 5xx now answers with the model-unavailable sentence and NOTHING is
   * appended: the endpoint's words are an operator's, not a person's.
   */
  it("answers an upstream 5xx with the model-unavailable sentence and no raw detail", () => {
    const line = assistantTransientErrorLine(
      assistantError("model_unreachable", 503, "the model endpoint returned 503"),
    );
    expect(line).toBe("The assistant's model isn't available right now. Try again in a moment.");
  });

  it.each(["model_unavailable", "upstream_status", "upstream_unavailable"])(
    "names the model unavailable for the cause %s whatever the endpoint said",
    (cause) => {
      const line = assistantTransientErrorLine(
        assistantError(
          cause,
          503,
          "llm-collective.e-gineering.com returned http 503 Your question was not sent — send it again.",
        ),
      );
      expect(line).toBe("The assistant's model isn't available right now. Try again in a moment.");
      // The endpoint's host, its status code and its own instruction are gone.
      expect(line).not.toMatch(/llm-collective|http 503|send it again/i);
    },
  );

  it("reads the cause from the body's code member when no degraded is named", () => {
    // A gateway in front of the endpoint answers the problem shape with `code`;
    // the failure is the same fact and must read the same.
    const body = {
      type: "https://communication.dev/errors/assistant-degraded",
      title: "Assistant unavailable",
      status: 503,
      detail:
        "llm-collective.e-gineering.com returned http 503 Your question was not sent — send it again.",
      code: "model_unavailable",
    };
    const error = new ApiError(body, body);
    expect(error.degraded).toBeNull();
    expect(problemCauseOf(error)).toBe("model_unavailable");
    expect(isUpstreamModelUnavailable(error)).toBe(true);
    expect(assistantTransientErrorLine(error)).toBe(
      "The assistant's model isn't available right now. Try again in a moment.",
    );
  });

  it("reads an upstream 5xx off the detail when the body names no cause at all", () => {
    const body = {
      type: "about:blank",
      title: "Bad Gateway",
      status: 502,
      detail: "llm-collective.e-gineering.com returned http 503",
    };
    expect(isUpstreamModelUnavailable(new ApiError(body, body))).toBe(true);
  });

  it("leaves a failure that is not an outage alone", () => {
    // A 500 with no cause is the replica's own breakdown, not the model's: the
    // caller keeps its honest problem line rather than blaming the endpoint.
    const body = {
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "boom",
    };
    expect(isUpstreamModelUnavailable(new ApiError(body, body))).toBe(false);
    expect(assistantTransientErrorLine(new ApiError(body, body))).toBeNull();
  });

  it("answers with the retry line for a model timeout", () => {
    const line = assistantTransientErrorLine(
      assistantError("model_timeout", 504, "no completion within 30s"),
    );
    expect(line).toBe(
      "The assistant's model is unavailable right now — try again. no completion within 30s",
    );
  });

  it("returns null when the cause is not transient", () => {
    expect(assistantTransientErrorLine(assistantError("assistant_not_configured"))).toBeNull();
    expect(assistantTransientErrorLine(assistantError(null))).toBeNull();
  });
});

describe("assistant error honesty", () => {
  it("treats the not-configured cause as a deployment fact, not a transient failure", () => {
    expect(assistantNotConfigured(assistantError("assistant_not_configured"))).toBe(true);
    expect(assistantNotConfigured(assistantError("model_unreachable"))).toBe(false);
  });
});

/**
 * Deployed finding F-5 (docs/testing/assistant-exercise-2026-11-11.md): a
 * mid-turn refusal reached the thread as the server's own Go error string —
 * `assistant: request body carries secret-shaped material` — with a trailing
 * "Your question was not sent" that was untrue of a turn whose earlier tools had
 * already run. Each stable cause now owns one plain sentence, and a raw
 * `assistant: …` string is recognised as the internal artefact it is.
 */
describe("assistantFailureLine (F-5: one plain sentence per stable cause)", () => {
  it("says the secret-in-request refusal in words the person can act on", () => {
    expect(
      assistantFailureLine(
        assistantError(
          "secret_in_request",
          400,
          "assistant: request body carries secret-shaped material",
        ),
      ),
    ).toBe(
      "That request carried something that looks like a secret, so it wasn't sent. " +
        "Rephrase without credentials and try again.",
    );
  });

  it("says a withheld answer was withheld", () => {
    expect(assistantFailureLine(assistantError("secret_in_response", 500))).toBe(
      "The answer looked like it contained a secret, so it was withheld.",
    );
  });

  it.each(["malformed_completion", "bad_model_response"])(
    "names %s as an answer that was not shown",
    (cause) => {
      expect(
        assistantFailureLine(assistantError(cause, 502, "assistant: malformed_completion")),
      ).toBe("The model's answer didn't make sense, so it wasn't shown. Try again.");
    },
  );

  it.each(["model_timeout", "timeout", "upstream_timeout"])("says %s took too long", (cause) => {
    expect(assistantFailureLine(assistantError(cause, 504, "no completion within 1m0s"))).toBe(
      "The model took too long to answer. Try again.",
    );
  });

  it("falls back to one plain sentence for a cause the map does not name", () => {
    expect(assistantFailureLine(assistantError("some_new_cause", 500, "assistant: …"))).toBe(
      ASSISTANT_FAILURE_DEFAULT_LINE,
    );
    expect(ASSISTANT_FAILURE_DEFAULT_LINE).toBe("The assistant could not answer. Try again.");
  });

  it("keeps the causes another surface says better in its own words", () => {
    // not-configured and model-unavailable name the admin's screen; the step
    // caps say nothing was saved; model_unreachable is the transient retry
    // line; question_invalid names the rule the person's words broke.
    for (const cause of [
      "assistant_not_configured",
      "model_unavailable",
      "model_call_cap_exceeded",
      "tool_cap_exceeded",
      "model_unreachable",
      "question_invalid",
    ]) {
      expect(assistantFailureLine(assistantError(cause))).toBeNull();
    }
  });

  it("says nothing for a failure that named no cause (a 409 on an approval card)", () => {
    expect(
      assistantFailureLine(assistantError(null, 409, "approval request is no longer pending")),
    ).toBeNull();
    expect(assistantFailureLine(new Error("boom"))).toBeNull();
  });

  it("maps every cause to a whole sentence that is not the server's own string", () => {
    for (const [cause, line] of Object.entries(ASSISTANT_FAILURE_LINES)) {
      expect(line, cause).toMatch(/[.!]$/);
      expect(line, cause).not.toMatch(/^assistant:/);
      expect(assistantError(cause, 500, "assistant: some detail").detail, cause).not.toBe(line);
    }
  });
});

describe("isRawAssistantErrorText", () => {
  it("recognises the server's own error string as not a sentence for a person", () => {
    expect(isRawAssistantErrorText("assistant: request body carries secret-shaped material")).toBe(
      true,
    );
    expect(isRawAssistantErrorText(" assistant: not configured")).toBe(true);
    expect(isRawAssistantErrorText("assistant: secret_in_request: the detail")).toBe(true);
  });

  it("leaves the prose the server writes for a person alone", () => {
    expect(isRawAssistantErrorText("the model endpoint returned 503")).toBe(false);
    expect(isRawAssistantErrorText("approval request is no longer pending")).toBe(false);
    expect(isRawAssistantErrorText("")).toBe(false);
    // A sentence that merely names the assistant is not the prefix form.
    expect(isRawAssistantErrorText("The assistant could not answer.")).toBe(false);
  });
});

/**
 * F-5 on the transient line too: only a timeout quotes the server's prose, and
 * never the raw `assistant: …` string. An unavailable model quotes nothing at all
 * (deployed finding rerun 18).
 */
describe("assistantTransientErrorLine with a raw detail", () => {
  it("withholds a raw assistant: detail from the retry line", () => {
    expect(
      assistantTransientErrorLine(
        assistantError("model_timeout", 504, "assistant: no completion within 30s"),
      ),
    ).toBe("The assistant's model is unavailable right now — try again.");
  });
});
