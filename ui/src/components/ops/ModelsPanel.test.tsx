/**
 * The models panel against the overview read: configuration in words, the
 * `Test` verb only for the roles that can use it, and the probe's answer as the
 * server said it — `ok · 812 ms` or `failed · <the upstream's own sentence>`.
 * The wire call is the assertion, not a spy on a wrapper, so the panel is proven
 * to post the kind it was asked about.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setCsrfToken } from "../../api/client";
import type { SystemOverview } from "../../api/overview";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import { ModelsPanel } from "./ModelsPanel";

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

const HOST = "llm-collective.e-gineering.com";

function overview(overrides: Partial<SystemOverview> = {}): SystemOverview {
  return {
    server: {
      version: "0.0.0-SNAPSHOT-f918881",
      commit: "f918881",
      replica: "communication-5b9d97499f-fccb7",
      schema_version: 30,
      started_at: "2026-11-11T00:00:00Z",
    },
    identity: { provider: "oidc", issuer_host: "idp.beluga-wyvern.ts.net", dev_login: false },
    storage: { artifact_backend: "local", preview_host: "communication-preview.example" },
    models: [
      {
        kind: "assistant",
        label: "Assistant chat",
        model: "david-birks/qwen3-8-flash-next",
        endpoint_host: HOST,
        key_set: true,
        configured: true,
      },
      {
        kind: "speech",
        label: "Speech",
        model: "voice",
        endpoint_host: HOST,
        key_set: true,
        configured: true,
      },
      {
        kind: "decision",
        label: "Decision",
        model: "thinker",
        endpoint_host: HOST,
        key_set: true,
        configured: true,
      },
      {
        kind: "worker_chat",
        label: "Workflow model steps",
        model: "",
        endpoint_host: HOST,
        key_set: null,
        configured: false,
      },
    ],
    secrets: { projects: 3, secrets: 7, mounts: 4 },
    workers: { online: 1, offline: 35, stale_after_seconds: 3600 },
    ...overrides,
  };
}

function panel(data: SystemOverview | null, isAdmin: boolean, routes: RouteStub[] = []) {
  const { requests } = mockFetch(routes);
  setCsrfToken(meFixture.csrf_token);
  render(<ModelsPanel overview={data} pending={false} error={null} isAdmin={isAdmin} />);
  return requests;
}

describe("ModelsPanel", () => {
  it("names every model row with its id, its key answer and its state", () => {
    panel(overview(), false);
    const row = screen.getByTestId("model-row-assistant");
    expect(row.textContent).toContain("Assistant chat");
    expect(row.textContent).toContain("david-birks/qwen3-8-flash-next");
    expect(row.textContent).toContain("key set");
    expect(row.textContent).toContain("configured");
    expect(screen.getByTestId("model-key-decision").textContent).toBe("key set");
    expect(screen.getByTestId("model-status-speech").textContent).toContain("configured");
  });

  it("says `no key` and `not set up` for a model that is only half wired", () => {
    const data = overview();
    data.models = data.models.map((model) =>
      model.kind === "speech" ? { ...model, key_set: false, configured: false } : model,
    );
    panel(data, false);
    expect(screen.getByTestId("model-key-speech").textContent).toBe("no key");
    expect(screen.getByTestId("model-status-speech").textContent).toContain("not set up");
  });

  it("says the worker model's own answer instead of offering a probe", () => {
    panel(overview(), true);
    const row = screen.getByTestId("model-row-worker_chat");
    expect(row.textContent).toContain("set on the worker");
    expect(row.textContent).toContain("key unknown here");
    expect(screen.queryByTestId("model-test-worker_chat")).toBeNull();
  });

  it("hides the Test button from a reader without the library role", () => {
    panel(overview(), false);
    expect(screen.queryByTestId("model-test-assistant")).toBeNull();
    expect(screen.queryAllByTestId(/^model-test-/)).toHaveLength(0);
  });

  it("probes the assistant over the wire and shows ok with the measured latency", async () => {
    const requests = panel(overview(), true, [
      {
        path: "/api/v1/system/models/assistant/probe",
        method: "POST",
        body: { ok: true, latency_ms: 812, detail: "" },
      },
    ]);

    fireEvent.click(screen.getByTestId("model-test-assistant"));
    expect(screen.getByTestId("model-test-assistant").textContent).toBe("testing…");

    const answer = await screen.findByTestId("model-probe-assistant");
    expect(answer.textContent).toContain("ok · 812 ms");
    expect(answer.querySelector("[data-status]")?.getAttribute("data-status")).toBe("ok");
    // The button is proven to ask for the kind it sat next to — and to carry the
    // CSRF header every mutation needs.
    const posts = requestsTo(requests, "/api/v1/system/models/assistant/probe", "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
  });

  it("shows the upstream's own sentence when the probe fails", async () => {
    const detail = 'model "voice" is not currently available';
    panel(overview(), true, [
      {
        path: "/api/v1/system/models/speech/probe",
        method: "POST",
        body: { ok: false, latency_ms: 15000, detail },
      },
    ]);

    fireEvent.click(screen.getByTestId("model-test-speech"));
    const answer = await screen.findByTestId("model-probe-speech");
    expect(answer.textContent).toContain(`failed · ${detail}`);
    expect(answer.querySelector("[data-status]")?.getAttribute("data-status")).toBe("bad");
    expect(answer.querySelector("span[title]")?.getAttribute("title")).toBe(detail);
  });

  it("truncates a detail the upstream made too long and keeps the whole of it in the title", async () => {
    const detail = "x".repeat(200);
    panel(overview(), true, [
      {
        path: "/api/v1/system/models/decision/probe",
        method: "POST",
        body: { ok: false, latency_ms: 100, detail },
      },
    ]);
    fireEvent.click(screen.getByTestId("model-test-decision"));
    const answer = await screen.findByTestId("model-probe-decision");
    const shown = answer.querySelector("span[title]")?.textContent ?? "";
    // `failed · ` + the first 80 characters + the ellipsis: one line, not a wall.
    expect(shown).toBe(`failed · ${"x".repeat(80)}…`);
    expect(answer.querySelector("span[title]")?.getAttribute("title")).toBe(detail);
  });

  it("names the one endpoint the models share in the head", () => {
    panel(overview(), false);
    expect(screen.getByTestId("ops-models").textContent).toContain(`via ${HOST}`);
  });

  it("says so when this server does not report its models", () => {
    panel(null, true);
    expect(screen.getByTestId("models-not-served").textContent).toContain(
      "does not report its model configuration",
    );
    expect(screen.queryAllByTestId(/^model-test-/)).toHaveLength(0);
  });

  it("shows the skeleton while the read is in flight", () => {
    render(<ModelsPanel overview={null} pending error={null} isAdmin={false} />);
    expect(screen.getByTestId("models-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("models-not-served")).toBeNull();
  });

  it("offers a retry when the read failed", async () => {
    let retried = 0;
    render(
      <ModelsPanel
        overview={null}
        pending={false}
        error={new Error("upstream exploded")}
        onRetry={() => (retried += 1)}
        isAdmin={false}
      />,
    );
    expect(screen.getByTestId("models-error").textContent).toContain(
      "Couldn't load the model configuration.",
    );
    fireEvent.click(screen.getByTestId("models-error-retry"));
    await waitFor(() => expect(retried).toBe(1));
  });
});
