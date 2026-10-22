/**
 * `api/client.ts` — the typed error boundary: the `ApiError` carries the
 * problem body's `degraded` cause, and the assistant retry line is derived
 * from it (never from the bare status).
 */
import { describe, expect, it } from "vitest";
import { ApiError, assistantTransientErrorLine } from "./client";
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
  it("answers with the retry line for a transient upstream cause", () => {
    const line = assistantTransientErrorLine(
      assistantError("model_unreachable", 503, "the model endpoint returned 503"),
    );
    expect(line).toBe(
      "The assistant's model is unavailable right now — try again. the model endpoint returned 503",
    );
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
