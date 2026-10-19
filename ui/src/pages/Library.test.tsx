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
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryPage, PipelinePage } from "./Library";
import type { Draft, DraftSummary, Me, ValidateResponse } from "../api/types";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  withMetadataName,
} from "../lib/pipeline/templates";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_ASSIGNMENT_ID,
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wireDraftSummaries,
  wirePipeline,
  wirePipelineList,
  wireRevision,
  wireUserId,
  wireProjectId,
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
          {/* The Studio route itself is tested in pages/Studio.test.tsx; the
              library only has to land the navigation there. */}
          <Route path="/library/:pipelineId/drafts/:draftId" element={<StudioRouteStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

/** Names where a draft navigation landed, in place of the real Studio page. */
function StudioRouteStub() {
  const { pipelineId = "", draftId = "" } = useParams();
  return <div data-testid="studio-route">{`${pipelineId} / ${draftId}`}</div>;
}

afterEach(cleanup);

/** The `name:` line inside the document's own `metadata:` block. */
function metadataName(document: string): string | undefined {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.trim() === "metadata:");
  if (start < 0) return undefined;
  return lines
    .slice(start + 1)
    .find((line) => /^[ \t]+name:/.test(line))
    ?.trim();
}

/** "Start from" is two chained mutations plus the page they land on, and the
 * pipeline-list invalidation refetches the whole row fan in between; that is
 * more than testing-library's 1 s default once the suite is 48 jsdom files
 * deep (kept under vitest's 5 s per-test timeout). Only the waits that cross
 * those writes are widened. */
const settled = { timeout: 4000 };

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

  it("starts from a template: the pipeline first, then a draft of the sample under the new slug", async () => {
    const plan = PIPELINE_TEMPLATES.find((template) => template.id === "plan-with-approval");
    // The draft the server would answer with, so the page we land on can open it.
    const seededDraft: Draft = { ...wireDraft("draft"), document_yaml: plan?.documentYaml ?? "" };
    const { requests } = mount("/library", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
      { path: draftsPath, method: "POST", status: 201, body: seededDraft },
      { path: draftPath, body: seededDraft },
    ]);
    await screen.findByTestId("library-new-pipeline", undefined, settled);
    fireEvent.change(screen.getByTestId("library-new-slug-input"), {
      target: { value: "nightly-sweep" },
    });
    fireEvent.change(screen.getByTestId("library-new-template-select"), {
      target: { value: "plan-with-approval" },
    });
    // The picker says what the template does before you commit to it.
    expect(screen.getByTestId("library-new-template-hint").textContent).toContain(
      "maintainer approval",
    );
    fireEvent.click(screen.getByTestId("library-new-submit"));

    await waitFor(
      () => expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1),
      settled,
    );
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1), settled);
    // Definition first, document second — a draft has nowhere to live until the
    // pipeline exists, and the server accepts exactly one of document/clone.
    const pipelinePost = requests.findIndex(
      (request) => request.method === "POST" && request.url === "/api/v1/pipelines",
    );
    const draftPost = requests.findIndex(
      (request) => request.method === "POST" && request.url === draftsPath,
    );
    expect(pipelinePost).toBeLessThan(draftPost);

    const body = JSON.parse(requests[draftPost].body ?? "{}") as { document_yaml?: string };
    const document = body.document_yaml ?? "";
    // The compiled sample itself, nodes and bindings intact…
    expect(document).toContain("- id: survey");
    expect(document).toContain("kind: model.chat");
    expect(document).toContain("kind: human.approval");
    expect(document).toContain("kind: artifact.publish");
    // …with only `metadata.name` rewritten to the new pipeline's slug.
    expect(metadataName(document)).toBe("name: nightly-sweep");
    expect(document).not.toContain("name: plan-with-approval");

    // And the library lands on the Studio route with that draft, not an
    // empty revision view.
    expect((await screen.findByTestId("studio-route", undefined, settled)).textContent).toContain(
      WIRE_DRAFT_ID,
    );
  });

  it("keeps a pipeline that exists when only the template draft fails, and retries the draft", async () => {
    const { requests } = mount("/library", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
      {
        path: draftsPath,
        method: "POST",
        status: 503,
        body: { title: "Worker offline", status: 503, detail: "no replica could take the write" },
      },
    ]);
    await screen.findByTestId("library-new-pipeline", undefined, settled);
    fireEvent.change(screen.getByTestId("library-new-slug-input"), {
      target: { value: "nightly-sweep" },
    });
    fireEvent.change(screen.getByTestId("library-new-template-select"), {
      target: { value: "security-review" },
    });
    fireEvent.click(screen.getByTestId("library-new-submit"));
    const banner = await screen.findByTestId("library-new-template-failure", undefined, settled);
    // The pipeline was created, so the retry must not repeat that POST — the
    // second click would be a 409 on a slug the server already accepted.
    expect(banner.textContent).toContain("no replica could take the write");
    expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1);
    expect(screen.queryByTestId("pipeline-page")).toBeNull();
    fireEvent.click(screen.getByTestId("library-new-template-retry"));
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(2), settled);
    expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1);
  });

  it("starts Blank from the skeleton: the pipeline, then a skeleton draft under the new slug", async () => {
    // The draft the server would answer with, so the page we land on can open it.
    const seededDraft: Draft = {
      ...wireDraft("draft"),
      document_yaml: withMetadataName(BLANK_SKELETON_YAML, "hand-written"),
    };
    const { requests } = mount("/library", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
      { path: draftsPath, method: "POST", status: 201, body: seededDraft },
    ]);
    await screen.findByTestId("library-new-pipeline", undefined, settled);
    fireEvent.change(screen.getByTestId("library-new-slug-input"), {
      target: { value: "hand-written" },
    });
    // Blank is the picker's default and posts the skeleton, not "no document".
    fireEvent.click(screen.getByTestId("library-new-submit"));

    await waitFor(
      () => expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1),
      settled,
    );
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1), settled);
    const draftPost = requests.find(
      (request) => request.method === "POST" && request.url === draftsPath,
    );
    const body = JSON.parse(draftPost?.body ?? "{}") as { document_yaml?: string };
    const document = body.document_yaml ?? "";
    // The skeleton itself: the top-level shape and one node…
    expect(document).toContain("- id: first");
    expect(document).toContain("kind: process.exec");
    // …with `metadata.name` rewritten to the new pipeline's slug.
    expect(metadataName(document)).toBe("name: hand-written");

    // And the library lands on the Studio route with that draft, not an
    // empty page the draft never reached.
    expect((await screen.findByTestId("studio-route", undefined, settled)).textContent).toContain(
      WIRE_DRAFT_ID,
    );
  });

  // M5 QA (`lib | polish`): the only place a template was ever mentioned was
  // the "start from" select inside `NewPipelineForm`, which is rendered for the
  // library role alone — so an org member could not learn the samples exist,
  // let alone where they come from. The list is now its own panel, and the one
  // authoring predicate decides whether it reads as an invitation or a refusal.
  describe("template discoverability", () => {
    const member: Me = { ...meFixture, is_org_admin: false };

    it("lists the vetted starting points read-only for a member who cannot create", async () => {
      const { requests } = mount("/library", [{ path: "/api/v1/me", body: member }]);

      const list = await screen.findByTestId("library-templates");
      expect(within(list).getByText("Plan with approval")).toBeTruthy();
      expect(within(list).getByText("Security review")).toBeTruthy();
      expect(within(list).getByText("Blank")).toBeTruthy();
      // Named where they live, not just what they are called.
      expect(within(list).getByTestId("library-template-plan-with-approval").textContent).toContain(
        "docs/samples/home",
      );
      // The reason the picker is missing, in the page's own vocabulary — and
      // only once `me` has been read: loading is not authoring.
      await waitFor(
        () =>
          expect(screen.getByTestId("library-templates-note").textContent).toContain(
            "needs the library role",
          ),
        settled,
      );
      // Each row says which verb is missing, not just the panel.
      expect(
        within(list).getByTestId("library-template-plan-with-approval-needs-role").textContent,
      ).toContain("needs the library role to create");
      // Reading the list is not authoring: no form, and no write attempted.
      expect(screen.queryByTestId("library-new-pipeline")).toBeNull();
      expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(0);
    });

    it("points an admin at the picker rather than repeating a refusal they do not need", async () => {
      mount("/library");

      const list = await screen.findByTestId("library-templates");
      await waitFor(
        () =>
          expect(screen.getByTestId("library-templates-note").textContent).toContain(
            "New pipeline above",
          ),
        settled,
      );
      // An admin is never handed the refusal they do not need.
      expect(screen.queryAllByTestId(/-needs-role$/)).toHaveLength(0);
      // The same list the picker offers — one source, not a second copy that can drift.
      expect(within(list).getAllByTestId(/^library-template-/)).toHaveLength(
        PIPELINE_TEMPLATES.length,
      );
      // Blank names its own source: the inlined skeleton, not a sample.
      expect(within(list).getByTestId("library-template-blank").textContent).toContain("skeleton");
    });
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

  it("selecting a draft leaves for the Studio route instead of an inline editor", async () => {
    mount(detail);
    const row = await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    fireEvent.click(within(row).getByRole("button"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
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
    // A created draft lands on the Studio route.
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
  });

  it("seeds a zero-revision pipeline's new draft from the blank skeleton, named for the slug", async () => {
    const { requests } = mount(detail, [
      { path: draftsPath, method: "POST", status: 201, body: wireDraft("draft") },
      { path: revisionsPath, body: { revisions: [] } },
      { path: draftsPath, body: { drafts: [] } },
    ]);
    // With nothing to clone the control is still the click — the skeleton is.
    const newDraft = await screen.findByTestId("pipeline-new-draft");
    expect((newDraft as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(newDraft);
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, draftsPath, "POST")[0].body ?? "{}") as {
      document_yaml?: string;
    };
    const document = body.document_yaml ?? "";
    expect(document).toContain("- id: first");
    expect(document).toContain("kind: process.exec");
    // Named for this pipeline's own slug, like the Blank template's post.
    expect(metadataName(document)).toBe("name: feature-development");
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
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

  // The validate POST and the rendered findings are the Studio route's job
  // now (pages/Studio.test.tsx). What the library still does: carry the
  // server's verdict on the draft row and hand the draft to Studio.
  it("carries the server's verdict on the draft row, and hands the draft to Studio", async () => {
    mount(detail, [
      { path: draftPath, body: wireDraft("invalid", w8Validation as ValidateResponse) },
    ]);
    const row = await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    // The verdict the server attached to the draft read is on the rail.
    expect((await screen.findByTestId(`draft-status-${WIRE_DRAFT_ID}`)).textContent).toContain(
      "draft v12",
    );
    expect(within(row).getByText("invalid")).toBeTruthy();
    // The row itself is the navigation — Studio renders the findings.
    fireEvent.click(within(row).getByRole("button"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
  });

  // The left column reads `GET /pipelines/{id}/drafts`. The write that
  // used to invalidate it happens on the Studio route now (Studio.test.tsx
  // asserts the versioned PUT); what the library still does is show the list
  // and hand the draft over.
  it("keeps the drafts list live and leaves the save to the Studio route", async () => {
    const { requests } = mount(detail, [
      { path: draftPath, method: "PUT", body: wireDraft("draft") },
    ]);
    const row = await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    // The list reads once on mount…
    await waitFor(() => expect(requestsTo(requests, draftsPath, "GET")).toHaveLength(1));
    // … and a row click leaves for the Studio route, where the editor lives.
    fireEvent.click(within(row).getByRole("button"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
    // No draft write ever leaves the library page itself.
    expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(0);
  });

  it("shows the verdict the server attached to a valid draft, and leaves validation to Studio", async () => {
    const { requests } = mount(detail, [
      { path: draftPath, body: wireDraft("valid", validValidation as ValidateResponse) },
      {
        path: draftsPath,
        body: { drafts: [{ ...wireDraftSummaries.drafts[0], status: "valid" }] },
      },
    ]);
    const row = await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    expect(within(row).getByText("valid")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
    // The validate POST is a Studio action; the library never fires it.
    expect(requestsTo(requests, validatePath, "POST")).toHaveLength(0);
  });

  // "Assign to a project" — after a revision is PUBLISHED the org library
  // surfaces the one-click path that makes the pipeline runnable: a select of
  // the caller's maintainer projects that don't already pin it, and a Confirm
  // that posts the **newest published revision id** (resolved digest → uuid via
  // route 13, exactly as ProjectRunsPipelines.tsx's assign form does).
  const secondProjectPath = "/api/v1/projects/01987a6c-9999-7f1a-9b2c-3d4e5f6a7b80/assignments";
  const maintainerProject2 = {
    ...projectFixture,
    id: "01987a6c-9999-7f1a-9b2c-3d4e5f6a7b80",
    name: "Gadgets",
    slug: "gadgets",
    my_role: "maintainer" as const,
  };
  const viewerProject = {
    ...projectFixture,
    id: "01987a6c-aaaa-7f1a-9b2c-3d4e5f6a7b80",
    name: "Old",
    my_role: "viewer" as const,
  };
  const emptyAssignments = { assignments: [] };

  describe("/library/:pipelineId — Assign to a project", () => {
    it("shows the assign control for a pipeline with a published revision", async () => {
      mount(detail, [
        {
          path: "/api/v1/projects",
          body: { items: [projectFixture, maintainerProject2, viewerProject] },
        },
        { path: `/api/v1/projects/${wireProjectId}/assignments`, body: emptyAssignments },
        { path: secondProjectPath, body: emptyAssignments },
      ]);
      const btn = await screen.findByTestId("assign-open");
      expect(btn.textContent).toBe("Assign to a project");
    });

    it("offers only maintainer projects that do NOT already have this pipeline assigned", async () => {
      mount(detail, [
        {
          path: "/api/v1/projects",
          body: { items: [projectFixture, maintainerProject2, viewerProject] },
        },
        // projectFixture already has it — the wire's pinned pipeline_id matches.
        { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
        // maintainerProject2 does not — it's offered.
        { path: secondProjectPath, body: emptyAssignments },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      const select = (await screen.findByTestId("assign-project-select")) as HTMLSelectElement;
      // projectFixture (Widgets) already has the assignment; Gadgets does not.
      const options = [...select.options].filter((o) => o.value !== "").map((o) => o.textContent);
      expect(options).toContain("Gadgets");
      expect(options).not.toContain("Widgets"); // already assigned
      expect(options).not.toContain("Old"); // viewer, not maintainer
    });

    it("confirming posts the assignment with the resolved revision uuid", async () => {
      const createPath = `/api/v1/projects/${maintainerProject2.id}/assignments`;
      const { requests } = mount(detail, [
        {
          path: "/api/v1/projects",
          body: { items: [projectFixture, maintainerProject2, viewerProject] },
        },
        { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
        { path: secondProjectPath, body: emptyAssignments },
        {
          path: createPath,
          method: "POST",
          status: 201,
          body: {
            ...wireAssignmentList.assignments[0],
            project_id: maintainerProject2.id,
            id: WIRE_ASSIGNMENT_ID,
          },
        },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      await screen.findByTestId("assign-project-select");
      fireEvent.change(screen.getByTestId("assign-project-select"), {
        target: { value: maintainerProject2.id },
      });
      fireEvent.change(screen.getByTestId("assign-ceiling"), {
        target: { value: "3" },
      });
      await waitFor(
        () =>
          expect((screen.getByTestId("assign-confirm") as HTMLButtonElement).disabled).toBe(false),
        settled,
      );
      fireEvent.click(screen.getByTestId("assign-confirm"));
      await waitFor(
        () => expect(requestsTo(requests, createPath, "POST")).toHaveLength(1),
        settled,
      );
      const body = JSON.parse(requestsTo(requests, createPath, "POST")[0].body ?? "{}") as Record<
        string,
        unknown
      >;
      // pinned_revision_id must be the real uuid WIRE_REVISION_ID, not the digest string.
      expect(body.pinned_revision_id).toBe(WIRE_REVISION_ID);
      expect(body.pipeline_id).toBe(WIRE_PIPELINE_ID);
      expect(body.max_concurrent_runs).toBe(3);
    });

    it("links the success panel to the project's run list", async () => {
      const createPath = `/api/v1/projects/${maintainerProject2.id}/assignments`;
      mount(detail, [
        {
          path: "/api/v1/projects",
          body: { items: [maintainerProject2] },
        },
        { path: secondProjectPath, body: emptyAssignments },
        {
          path: createPath,
          method: "POST",
          status: 201,
          body: { ...wireAssignmentList.assignments[0], project_id: maintainerProject2.id },
        },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      await screen.findByTestId("assign-project-select");
      fireEvent.change(screen.getByTestId("assign-project-select"), {
        target: { value: maintainerProject2.id },
      });
      await waitFor(
        () =>
          expect((screen.getByTestId("assign-confirm") as HTMLButtonElement).disabled).toBe(false),
        settled,
      );
      fireEvent.click(screen.getByTestId("assign-confirm"));
      const link = await screen.findByTestId("assign-start-run-link", undefined, settled);
      expect(link.getAttribute("href")).toBe(`/projects/${maintainerProject2.id}/runs`);
      expect(screen.getByTestId("assign-success-label").textContent).toContain("Gadgets");
    });

    it("shows no assign control when no published revisions exist", async () => {
      // Override revisions list to be empty.
      mount(detail, [
        { path: revisionsPath, body: { revisions: [] } },
        {
          path: "/api/v1/projects",
          body: { items: [projectFixture] },
        },
        { path: `/api/v1/projects/${wireProjectId}/assignments`, body: emptyAssignments },
      ]);
      await screen.findByTestId("pipeline-page");
      expect(screen.queryByTestId("assign-open")).toBeNull();
    });

    // The two dead ends render a line rather than nothing: a button that leads
    // to an empty select, or a form with no candidates, tells the reader the
    // pipeline is unassignable without saying so.
    it("says so when you maintain no project, and points at the projects list", async () => {
      mount(detail, [{ path: "/api/v1/projects", body: { items: [viewerProject] } }]);
      const line = await screen.findByTestId("assign-no-maintainer", undefined, settled);
      expect(line.textContent).toContain("You maintain no project");
      expect(line.textContent).toContain("a project maintainer can assign this pipeline");
      // No button is offered for a path the reader cannot walk.
      expect(screen.queryByTestId("assign-open")).toBeNull();
      expect(screen.getByTestId("assign-projects-link").getAttribute("href")).toBe("/");
    });

    it("says already-assigned when every maintained project pins it", async () => {
      mount(detail, [
        { path: "/api/v1/projects", body: { items: [maintainerProject2] } },
        // The one project Gadgets maintains already pins this pipeline.
        { path: secondProjectPath, body: wireAssignmentList },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      const line = await screen.findByTestId("assign-every-project", undefined, settled);
      expect(line.textContent).toContain("Already assigned to every project you maintain");
      // Not the form with a candidate-less select behind it.
      expect(screen.queryByTestId("assign-project-select")).toBeNull();
      expect(screen.getByTestId("assign-projects-link").getAttribute("href")).toBe("/");
      // …but the sentence is not the whole answer: the project that pins it, and
      // what it pins, are stated (`lib | polish`: an existing assignment was
      // invisible).
      expect(
        screen.getByTestId(`assign-project-pin-${maintainerProject2.id}`).textContent,
      ).toContain("assigned");
      expect(
        screen.getByTestId(`assign-project-pin-${maintainerProject2.id}`).textContent,
      ).toContain("7.0.0");
    });

    it("states each maintained project's assignment state, not just the assignable ones", async () => {
      mount(detail, [
        {
          path: "/api/v1/projects",
          body: { items: [projectFixture, maintainerProject2, viewerProject] },
        },
        { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
        { path: secondProjectPath, body: emptyAssignments },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      await screen.findByTestId("assign-project-states");

      // Widgets is not hidden for having the pin — it says what it runs.
      const assigned = screen.getByTestId(`assign-project-pin-${wireProjectId}`);
      expect(assigned.textContent).toContain("assigned");
      expect(assigned.textContent).toContain("7.0.0");
      expect(assigned.textContent).toContain("newest published");
      expect(screen.queryByTestId(`assign-pick-${wireProjectId}`)).toBeNull();
      // Gadgets is offered, with the action that assigns it.
      expect(
        screen.getByTestId(`assign-project-pin-${maintainerProject2.id}`).textContent,
      ).toContain("not assigned");
      expect(screen.getByTestId(`assign-pick-${maintainerProject2.id}`).textContent).toContain(
        "Assign here",
      );
      // A project the caller only views is not hers to assign, and is not listed.
      expect(screen.queryByTestId(`assign-project-states-${viewerProject.id}`)).toBeNull();
      expect(
        within(screen.getByTestId("assign-project-states")).getAllByTestId(/assign-project-state-/),
      ).toHaveLength(2);
    });

    it("picking a project from its state row arms the existing assign action", async () => {
      const createPath = `/api/v1/projects/${maintainerProject2.id}/assignments`;
      const { requests } = mount(detail, [
        {
          path: "/api/v1/projects",
          body: { items: [projectFixture, maintainerProject2, viewerProject] },
        },
        { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
        { path: secondProjectPath, body: emptyAssignments },
        {
          path: createPath,
          method: "POST",
          status: 201,
          body: { ...wireAssignmentList.assignments[0], project_id: maintainerProject2.id },
        },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      fireEvent.click(await screen.findByTestId(`assign-pick-${maintainerProject2.id}`));

      // The row chooses the project the form posts for — one action, one write.
      expect((screen.getByTestId("assign-project-select") as HTMLSelectElement).value).toBe(
        maintainerProject2.id,
      );
      await waitFor(
        () =>
          expect((screen.getByTestId("assign-confirm") as HTMLButtonElement).disabled).toBe(false),
        settled,
      );
      fireEvent.click(screen.getByTestId("assign-confirm"));
      await waitFor(
        () => expect(requestsTo(requests, createPath, "POST")).toHaveLength(1),
        settled,
      );
      const body = JSON.parse(requestsTo(requests, createPath, "POST")[0].body ?? "{}") as Record<
        string,
        unknown
      >;
      expect(body.pipeline_id).toBe(WIRE_PIPELINE_ID);
    });

    it("does not claim a project whose assignments could not be read", async () => {
      mount(detail, [
        { path: "/api/v1/projects", body: { items: [maintainerProject2] } },
        {
          path: secondProjectPath,
          status: 500,
          body: { title: "Internal Server Error", status: 500 },
        },
      ]);
      fireEvent.click(await screen.findByTestId("assign-open"));
      // Neither "assigned" nor "not assigned" — the read failed, so the row says
      // it is checking rather than guessing the project's state.
      expect(
        (await screen.findByTestId(`assign-project-pin-${maintainerProject2.id}`)).textContent,
      ).toContain("checking");
      expect(screen.queryByTestId(`assign-pick-${maintainerProject2.id}`)).toBeNull();
    });
  });
});

/**
 * The permission rule the rail states is the rule the pane enforces. Both read
 * `lib/pipeline/authoring.hasLibraryRole`, which mirrors the server's
 * `requireLibraryRole` (`internal/api/pipelines.go`: `IsOrgAdmin` and nothing
 * else) — a page that says "authoring needs the library role" while handing out
 * an enabled Save is the bug, whichever way the rule falls.
 */
describe("/library/:pipelineId without the library role", () => {
  const detail = `/library/${WIRE_PIPELINE_ID}`;
  const member: Me = { ...meFixture, is_org_admin: false };

  it("states the reason in the rail, and still hands a draft to the Studio route", async () => {
    const { requests } = mount(detail, [{ path: "/api/v1/me", body: member }]);
    // The rail: no New draft button, and the reason in its place.
    expect(await screen.findByTestId("draft-list")).toBeTruthy();
    expect(screen.queryByTestId("pipeline-new-draft")).toBeNull();
    expect(screen.getByText("authoring needs the library role")).toBeTruthy();
    // The rail stays a read surface: a row still leaves for Studio…
    const row = await screen.findByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    fireEvent.click(within(row).getByRole("button"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
    // … and no draft write left the library page itself.
    expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(0);
  });

  it("keeps reading the draft, its verdict and its revisions for a member", async () => {
    mount(detail, [{ path: "/api/v1/me", body: member }]);
    // Revisions and drafts stay readable: the header, the revision list, and
    // the verdict the server attached to the draft row.
    expect(await screen.findByTestId("revision-list")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-header-meta").textContent).toContain("7 revisions"),
    );
    expect((await screen.findByTestId(`draft-status-${WIRE_DRAFT_ID}`)).textContent).toContain(
      "draft v12",
    );
    // The row's navigation is the Studio route, where the draft opens.
    const row = screen.getByTestId(`draft-row-${WIRE_DRAFT_ID}`);
    fireEvent.click(within(row).getByRole("button"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
  });
});
