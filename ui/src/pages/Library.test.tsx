/**
 * The org library and one pipeline's authoring surface, driven against the
 * fake fetch: the list is the project page's `viewPipeline` mapping with rows
 * that link to `/library/:pipelineId`; selecting a draft opens the editor; and
 * the two rules with teeth are that Publish is gated on the **server's** draft
 * status (never a client-side read of the text) and that Validate renders the
 * § 2.2 body the server returned.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryPage, PipelinePage } from "./Library";
import type { Draft, DraftSummary, Me, ValidateResponse } from "../api/types";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireDraftSummaries,
  wirePipeline,
  wirePipelineList,
  wireRevision,
  wireUserId,
} from "../test/fixtures/m4/wire";
import { validValidation, w8DraftYaml, w8Validation } from "../test/fixtures/m4/w8Draft";

const admin: Me = { ...meFixture, is_org_admin: true };
const pipelinePath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;
const revisionsPath = `${pipelinePath}/revisions`;
const draftsPath = `${pipelinePath}/drafts`;
const draftPath = `/api/v1/drafts/${WIRE_DRAFT_ID}`;
const revisionPath = `/api/v1/revisions/${WIRE_REVISION_ID}`;
const digest = wirePipeline.revisions[0].revision_digest;
const validatePath = `${draftPath}/validate`;
const publishPath = `${draftPath}/publish`;

function wireDraft(status: Draft["status"], validation?: ValidateResponse): Draft {
  return {
    id: WIRE_DRAFT_ID,
    pipeline_id: WIRE_PIPELINE_ID,
    status,
    document_yaml: w8DraftYaml,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: {},
    digest_scope: "v1alpha1-canonical-1",
    ...(validation ? { validation } : {}),
    version: 12,
    edited_by: wireUserId,
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:12:00Z",
  };
}

function routes(overrides: RouteStub[] = []): RouteStub[] {
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: admin },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: pipelinePath, body: wirePipeline },
    { path: revisionsPath, body: { revisions: wirePipeline.revisions } },
    { path: draftsPath, body: wireDraftSummaries },
    { path: `/api/v1/revisions/${digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${digest}/document`, body: wireRevision.document_text },
    { path: revisionPath, body: wireRevision },
    { path: `${revisionPath}/document`, body: wireRevision.document_text },
    { path: draftPath, body: wireDraft("invalid", w8Validation as ValidateResponse) },
    { path: validatePath, method: "POST", body: w8Validation },
    { path: publishPath, method: "POST", status: 409, body: { title: "Nope", status: 409 } },
  ];
  return [...overrides, ...base];
}

function mount(path: string, overrides: RouteStub[] = []) {
  const { fetchMock, requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/:pipelineId" element={<PipelinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

afterEach(cleanup);

describe("/library", () => {
  it("lists the org pipelines and opens the one you click", async () => {
    mount("/library");
    const list = await screen.findByTestId("pipeline-library");
    expect(within(list).getByText("Feature development")).toBeTruthy();
    fireEvent.click(within(list).getByTestId("pipeline-name-feature-development"));
    expect(await screen.findByTestId("pipeline-page")).toBeTruthy();
    expect((await screen.findByTestId("pipeline-header-meta")).textContent).toContain(
      "feature-development",
    );
  });

  it("is an org surface: no project channel claims, and the draft line names the editor", async () => {
    mount("/library");
    const list = await screen.findByTestId("pipeline-library");
    // No project owns these rows, so "no channel set for this project" would
    // be a lie — the channel cell is absent entirely.
    expect(within(list).queryAllByTestId(/pipeline-no-channel-/)).toHaveLength(0);
    expect(within(list).queryAllByTestId(/pipeline-channels-/)).toHaveLength(0);
    // The draft line resolves `edited_by` (the signed-in user's id) to a name.
    const draftLine = within(list).getByTestId("pipeline-validation-feature-development");
    expect(draftLine.textContent).toContain("Ada Lovelace");
    expect(draftLine.textContent).not.toContain(wireUserId);
  });

  it("posts a new pipeline slug for an org admin", async () => {
    const { requests } = mount("/library", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
    ]);
    await screen.findByTestId("library-new-pipeline");
    fireEvent.change(screen.getByTestId("library-new-slug-input"), {
      target: { value: "nightly-sweep" },
    });
    fireEvent.click(screen.getByTestId("library-new-submit"));
    await waitFor(() => expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1));
    expect(requestsTo(requests, "/api/v1/pipelines", "POST")[0].body).toContain("nightly-sweep");
  });
});

describe("/library/:pipelineId", () => {
  const detail = `/library/${WIRE_PIPELINE_ID}`;

  it("shows the newest revision's regenerated document and graph by default", async () => {
    mount(detail);
    const yaml = await screen.findByTestId("yaml-view");
    expect(yaml.textContent).toContain("apiVersion: communication.dev/v1alpha1");
    expect((await screen.findByTestId("pipeline-header-meta")).textContent).toContain(
      "7 revisions",
    );
    expect(await screen.findByTestId("definition-graph")).toBeTruthy();
  });

  it("opens the draft editor with the served document when a draft is selected", async () => {
    mount(detail);
    const row = await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    fireEvent.click(within(row).getByRole("button"));
    const box = await screen.findByTestId("draft-editor-input");
    expect((box as HTMLTextAreaElement).value).toContain("apiVersion: communication.dev/v1alpha1");
    // The verdict line is the served validation, not a client-side guess.
    expect((await screen.findByTestId("draft-editor-verdict")).textContent).toContain("findings");
  });

  it("disables Publish while the server says the draft is not valid", async () => {
    mount(detail);
    fireEvent.click(
      within(await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`)).getByRole("button"),
    );
    const publish = await screen.findByTestId("draft-editor-publish");
    expect((publish as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Publish only when the server's draft status is valid", async () => {
    mount(detail, [
      {
        path: draftPath,
        body: wireDraft("valid", validValidation as ValidateResponse),
      },
    ]);
    fireEvent.click(
      within(await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`)).getByRole("button"),
    );
    const publish = await screen.findByTestId("draft-editor-publish");
    await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
    expect((await screen.findByTestId("draft-editor-verdict")).textContent).toContain("valid");
  });

  it("seeds a new draft from the newest revision's document", async () => {
    const { requests } = mount(detail, [
      { path: draftsPath, method: "POST", status: 201, body: wireDraft("draft") },
      { path: draftsPath, body: { drafts: [] } },
    ]);
    fireEvent.click(await screen.findByTestId("pipeline-new-draft"));
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1));
    expect(requestsTo(requests, draftsPath, "POST")[0].body).toContain(
      "apiVersion: communication.dev/v1alpha1",
    );
    expect(await screen.findByTestId("draft-editor-input")).toBeTruthy();
  });

  it("collapses a flooded drafts list to the newest five, with age and editor name", async () => {
    const flood: DraftSummary[] = Array.from({ length: 8 }, (_, i) => ({
      id: `${WIRE_DRAFT_ID.slice(0, 18)}${String(i).padStart(4, "0")}`,
      status: "invalid",
      version: 1,
      updated_at: `2026-07-${String(28 - i).padStart(2, "0")}T08:00:00Z`,
      edited_by: wireUserId,
    }));
    mount(detail, [{ path: draftsPath, body: { drafts: flood } }]);
    // Wait for the served rows — the list scaffold renders while loading.
    await screen.findByTestId(`draft-row-${flood[0].id}`);
    const list = await screen.findByTestId("draft-list");
    // Newest first, newest five only: the row from the newest minute is in,
    // the oldest is behind the toggle.
    expect(within(list).getAllByTestId(/^draft-row-/)).toHaveLength(5);
    expect(within(list).queryByTestId(`draft-row-${flood[0].id}`)).toBeTruthy();
    expect(within(list).queryByTestId(`draft-row-${flood[7].id}`)).toBeNull();
    // Each row carries its age and the editor's name, not the raw id.
    expect(within(list).getByTestId(`draft-edited-by-${flood[0].id}`).textContent).toContain(
      "Ada Lovelace",
    );
    expect(within(list).getByTestId(`draft-age-${flood[0].id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("draft-list-more"));
    expect(within(list).getAllByTestId(/^draft-row-/)).toHaveLength(8);
  });

  it("renders the server's findings when Validate runs", async () => {
    const { requests } = mount(detail, [
      { path: draftPath, body: wireDraft("invalid") },
      { path: validatePath, method: "POST", body: w8Validation },
      {
        path: `/api/v1/drafts/${WIRE_DRAFT_ID}`,
        method: "PUT",
        body: wireDraft("invalid", w8Validation as ValidateResponse),
      },
    ]);
    fireEvent.click(
      within(await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`)).getByRole("button"),
    );
    fireEvent.click(await screen.findByTestId("draft-editor-validate"));
    const problems = await screen.findAllByTestId(/^draft-editor-problem-/);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0].textContent).toContain("duplicate_key");
    await waitFor(() => expect(requestsTo(requests, validatePath, "POST")).toHaveLength(1));
  });
});
