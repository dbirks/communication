/**
 * The W8 validate panel, driven against the fake fetch: pasted YAML becomes a
 * scratch draft, the draft becomes the § 2.2 body, and the body renders in the
 * server's own order with `instance_location`, `source` and `hint` on every
 * row. The two rules with teeth here are that the sources are ordered and not
 * merged, and that a `secret_literal_detected` row never carries a value — the
 * sentinel pasted into the textarea must not reappear in the row.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { ValidatePanel } from "./ValidatePanel";
import type { Draft, ValidateResponse } from "../../api/types";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import { WIRE_DRAFT_ID, WIRE_PIPELINE_ID, wireUserId } from "../../test/fixtures/m4/wire";
import { w8DraftYaml, w8Validation } from "../../test/fixtures/m4/w8Draft";

afterEach(cleanup);

/** A credential-shaped string the tests paste in, to prove the row redacts. */
const SENTINEL = "sk-proj-NotARealCredential-0123456789";

const draftPath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}/drafts`;
const validatePath = `/api/v1/drafts/${WIRE_DRAFT_ID}/validate`;

function wireDraft(documentYaml: string, version: number): Draft {
  return {
    id: WIRE_DRAFT_ID,
    pipeline_id: WIRE_PIPELINE_ID,
    status: "draft",
    document_yaml: documentYaml,
    source_kind: "yaml_import",
    source_sha256: "0".repeat(64),
    ui_layout: {},
    digest_scope: "v1alpha1-canonical-1",
    version,
    edited_by: wireUserId,
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:00:00Z",
  };
}

function harness(text: string, validation: ValidateResponse = w8Validation as ValidateResponse) {
  const routes: RouteStub[] = [
    { path: draftPath, method: "POST", status: 201, body: wireDraft(text, 1) },
    { path: `/api/v1/drafts/${WIRE_DRAFT_ID}`, method: "PUT", body: wireDraft(text, 2) },
    { path: validatePath, method: "POST", body: validation },
  ];
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return {
    fetchMock,
    requests,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

function renderPanel(props: Partial<Parameters<typeof ValidatePanel>[0]> = {}, text = w8DraftYaml) {
  const harnessValue = harness(text);
  const rendered = render(
    <ValidatePanel
      pipelines={[
        { id: WIRE_PIPELINE_ID, slug: "feature-development", displayName: "Feature development" },
      ]}
      canValidate
      initialText={text}
      {...props}
    />,
    { wrapper: harnessValue.wrapper },
  );
  return { ...harnessValue, ...rendered };
}

/** The codes as rendered, in DOM order. */
function renderedCodes(): string[] {
  return screen.getAllByTestId(/^validate-panel-code-/).map((node) => node.textContent ?? "");
}

function indexOfWeek(code: string, source: string): number {
  let ordinal = -1;
  for (const issue of ordered(w8Validation.errors)) {
    ordinal += 1;
    if (issue.code === code && issue.source === source) return ordinal;
  }
  throw new Error(`no ${source}/${code} in the fixture`);
}

/** loader → schema → compiler, server order inside each (what the panel renders). */
function ordered(errors: typeof w8Validation.errors) {
  return ["loader", "schema", "compiler"].flatMap((source) =>
    errors.filter((issue) => issue.source === source),
  );
}

describe("ValidatePanel (W8)", () => {
  it("renders the findings loader → schema → compiler, each with source, location and hint", async () => {
    const { requests } = renderPanel();
    fireEvent.click(screen.getByTestId("validate-panel-submit"));
    await waitFor(() =>
      expect(screen.getAllByTestId(/^validate-panel-row-/)).toHaveLength(
        w8Validation.errors.length,
      ),
    );

    // Pasted text reached the server as a scratch draft, then as a validate call.
    expect(requestsTo(requests, draftPath, "POST")).toHaveLength(1);
    expect(
      JSON.parse(requestsTo(requests, draftPath, "POST")[0].body ?? "{}").document_yaml,
    ).toContain("apiVersion: communication.dev/v1alpha1");
    expect(requestsTo(requests, validatePath, "POST")).toHaveLength(1);

    // Sources are ordered, never merged: every loader row precedes every schema
    // row, which precedes every compiler row; within a source the server's
    // order stands.
    expect(renderedCodes()).toEqual(ordered(w8Validation.errors).map((issue) => issue.code));

    const loader = indexOfWeek("duplicate_key", "loader");
    expect(screen.getByTestId(`validate-panel-source-${loader}`).textContent).toContain("loader");
    expect(screen.getByTestId(`validate-panel-location-${loader}`).textContent).toBe(
      "/spec/nodes/0",
    );
    expect(screen.getByTestId(`validate-panel-code-${loader}`).textContent).toBe("duplicate_key");

    const secret = indexOfWeek("secret_literal_detected", "compiler");
    expect(screen.getByTestId(`validate-panel-location-${secret}`).textContent).toBe(
      "/spec/nodes/2/config/prompt",
    );
    expect(screen.getByTestId(`validate-panel-hint-${secret}`).textContent).toContain(
      "reference it instead",
    );
    // The groups themselves are labelled with their own counts, so a reader
    // sees who refused and how many times.
    for (const source of ["loader", "schema", "compiler"] as const) {
      const expected = w8Validation.errors.filter((issue) => issue.source === source).length;
      expect(
        (screen.getByTestId(`validate-panel-group-${source}`).textContent ?? "").split("\u00b7")[1],
      ).toContain(String(expected));
    }
    expect(screen.getAllByTestId(/^validate-panel-row-/)).toHaveLength(w8Validation.errors.length);
  });

  it("says a kind_not_implemented step cannot run, in plain words, with no milestone", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("validate-panel-submit"));
    await waitFor(() =>
      expect(screen.getAllByTestId(/^validate-panel-row-/).length).toBeGreaterThan(0),
    );
    // One marker per refused kind, and the marker says what is missing rather
    // than when the roadmap intends to fix it.
    const deferredCount = w8Validation.errors.filter(
      (issue) => issue.code === "kind_not_implemented",
    ).length;
    const markers = screen
      .getAllByTestId(/^validate-panel-deferred-/)
      .map((node) => node.textContent ?? "");
    expect(markers).toHaveLength(deferredCount);
    for (const marker of markers) expect(marker).toBe("not available yet");

    // Every refused row shows the plain sentence built from its own kind, and
    // keeps the server's sentence as data rather than as the words a reader sees.
    expect(
      ordered(w8Validation.errors).filter((i) => i.code === "kind_not_implemented").length,
    ).toBe(deferredCount);
    ordered(w8Validation.errors).forEach((issue, ordinal) => {
      if (issue.code !== "kind_not_implemented") return;
      const kind = /^kind (\S+) is not implemented\b/.exec(issue.message)?.[1] ?? "";
      expect(kind).not.toBe("");
      const message = screen.getByTestId(`validate-panel-message-${ordinal}`);
      expect(message.textContent).toBe(`${kind} steps can't run yet.`);
      expect(message.getAttribute("data-server-message")).toBe(issue.message);
      expect(screen.getByTestId(`validate-panel-code-${ordinal}`).textContent).toBe(
        "kind_not_implemented",
      );
    });
    // No milestone name reaches the screen anywhere in the findings.
    expect(screen.getByTestId("validate-panel-findings").textContent).not.toMatch(/\bM\d\b/);
  });

  it("clicking a row marks that location in the YAML view of the submitted text", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("validate-panel-submit"));
    await waitFor(() =>
      expect(screen.getAllByTestId(/^validate-panel-row-/).length).toBeGreaterThan(0),
    );

    const index = ordered(w8Validation.errors).findIndex((issue) =>
      issue.message.includes("kind parallel"),
    );
    const row = screen.getByTestId(`validate-panel-row-${index}`);
    fireEvent.click(row);
    expect(row.getAttribute("aria-pressed")).toBe("true");

    const lit = Array.from(document.querySelectorAll('[data-testid^="yaml-line-"]')).filter(
      (line) => (line as HTMLElement).className.includes("bg-accent-wash"),
    );
    expect(lit.length).toBeGreaterThan(0);
    // The finding is also marked on its own line by the viewer.
    expect(screen.getByTestId("yaml-view").textContent).toContain("kind_not_implemented");
  });

  it("renders a secret-literal finding redacted — the pasted value never returns", async () => {
    const text = `${w8DraftYaml}\n# scratch: ${SENTINEL}\n`;
    renderPanel({}, text);
    fireEvent.click(screen.getByTestId("validate-panel-submit"));
    await waitFor(() =>
      expect(screen.getAllByTestId(/^validate-panel-row-/).length).toBeGreaterThan(0),
    );

    const secret = indexOfWeek("secret_literal_detected", "compiler");
    const row = screen.getByTestId(`validate-panel-row-${secret}`);
    expect(row.textContent).not.toContain(SENTINEL);
    expect(screen.getByTestId("validate-panel-findings").textContent).not.toContain(SENTINEL);
    expect(row.textContent).toContain("value redacted");
    expect(row.textContent).toContain("value never shown");
    expect(screen.getByTestId(`validate-panel-redacted-${secret}`)).toBeTruthy();
  });

  it("arms Validate when the library arrives — pasting YAML needs no touch of the select (W8)", async () => {
    // The project screen's library list comes from a read, so on first paint
    // there is nothing to select; the gap this closes is that the button
    // stayed disabled past that paint until the reader touched the select.
    const { requests, rerender } = renderPanel({ pipelines: [] });
    const paste = w8DraftYaml;
    fireEvent.change(screen.getByTestId("validate-panel-input"), { target: { value: paste } });
    expect(screen.getByTestId("validate-panel-submit").hasAttribute("disabled")).toBe(true);

    rerender(
      <ValidatePanel
        pipelines={[
          { id: WIRE_PIPELINE_ID, slug: "feature-development", displayName: "Feature development" },
        ]}
        canValidate
        initialText={paste}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("validate-panel-submit").hasAttribute("disabled")).toBe(false),
    );
    // The select defaulted to the first selectable pipeline on its own.
    expect((screen.getByTestId("validate-panel-pipeline") as HTMLSelectElement).value).toBe(
      WIRE_PIPELINE_ID,
    );

    fireEvent.click(screen.getByTestId("validate-panel-submit"));
    await waitFor(() => expect(requestsTo(requests, draftPath, "POST")).toHaveLength(1));
    expect(
      JSON.parse(requestsTo(requests, draftPath, "POST")[0].body ?? "{}").document_yaml,
    ).toContain("apiVersion: communication.dev/v1alpha1");
    await waitFor(() => expect(requestsTo(requests, validatePath, "POST")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("validate-panel-verdict").textContent).toContain("findings"),
    );
  });

  it("shows a member without the library role the reason, not a button that would 403", () => {
    renderPanel({ canValidate: false });
    expect(screen.getByTestId("validate-panel-needs-role").textContent).toContain("library role");
    expect(screen.queryByTestId("validate-panel-input")).toBeNull();
    expect(screen.queryByTestId("validate-panel-submit")).toBeNull();
  });
});
