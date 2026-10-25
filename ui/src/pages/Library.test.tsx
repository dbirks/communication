/**
 * The org library index (design 1b/1c), driven against the fake fetch: the
 * list is the project page's `viewPipeline` mapping with rows that link to
 * `/workflows/:pipelineId`; the starter cards and the New workflow dialog run
 * the existing two writes (pipeline, then draft) and land on the Studio; and
 * folder grouping rides the wire's own `folder` member.
 *
 * The workflow PAGE (`/workflows/:pipelineId` — tabs, rail, Used-in, History)
 * is covered by `Workflow.test.tsx`: design 1e moved revisions, drafts and
 * the assign surface off this index file's old detail-page describes.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryPage, PipelinePage } from "./Library";
import type { Draft, Me, Pipeline, ValidateResponse } from "../api/types";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  withMetadataName,
} from "../lib/pipeline/templates";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  WIRE_CHILD_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wireDraftSummaries,
  wirePipeline,
  wirePipelineList,
  wireRevision,
  wireUserId,
  wireProjectId,
} from "../test/fixtures/m4/wire";
import { w8DraftYaml, w8Validation } from "../test/fixtures/m4/w8Draft";

const admin: Me = { ...meFixture, is_org_admin: true };
const pipelinePath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;
const revisionsPath = `${pipelinePath}/revisions`;
const draftsPath = `${pipelinePath}/drafts`;
const draftPath = `/api/v1/drafts/${WIRE_DRAFT_ID}`;
const revisionPath = `/api/v1/revisions/${WIRE_REVISION_ID}`;
const digest = wirePipeline.revisions[0].revision_digest;
const validatePath = `${draftPath}/validate`;
const publishPath = `${draftPath}/publish`;
/** The second org workflow in the wire list, as a DRAFT ONLY definition. */
const childPipeline: Pipeline = {
  id: WIRE_CHILD_PIPELINE_ID,
  slug: "module-check",
  display_name: "Module check",
  description: "A checklist of module checks.",
  created_by: wireUserId,
  created_at: "2026-07-02T10:00:00Z",
  latest_revision_number: 0,
  revision_count: 0,
  archived: false,
  revisions: [],
};

/** `Duplicate` on `feature-development` answers with this fresh definition. */
const COPY_PIPELINE_ID = "01987c01-0000-7000-8000-copy01234567";
const COPY_DRAFT_ID = "01987c02-0000-7000-8000-copy01234567";
const copyPipeline: Pipeline = {
  ...childPipeline,
  id: COPY_PIPELINE_ID,
  slug: "feature-development-copy",
  display_name: "Feature development copy",
  description: wirePipeline.description,
  created_at: "2026-07-31T10:00:00Z",
};

/** `Import YAML` answers with this fresh definition. */
const IMPORT_PIPELINE_ID = "01987c03-0000-7000-8000-import0123456";
const IMPORT_DRAFT_ID = "01987c04-0000-7000-8000-import0123456";
const importedPipeline: Pipeline = {
  ...childPipeline,
  id: IMPORT_PIPELINE_ID,
  slug: "nightly-sweep",
  display_name: "Nightly sweep",
  description: "",
  created_at: "2026-07-31T10:00:00Z",
};

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
    { path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}`, body: childPipeline },
    { path: revisionsPath, body: { revisions: wirePipeline.revisions } },
    { path: draftsPath, body: wireDraftSummaries },
    { path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}/drafts`, body: { drafts: [] } },
    { path: `/api/v1/revisions/${digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${digest}/document`, body: wireRevision.document_text },
    { path: revisionPath, body: wireRevision },
    { path: `${revisionPath}/document`, body: wireRevision.document_text },
    { path: draftPath, body: wireDraft("invalid", w8Validation as ValidateResponse) },
    { path: validatePath, method: "POST", body: w8Validation },
    { path: publishPath, method: "POST", status: 409, body: { title: "Nope", status: 409 } },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
    { path: `/api/v1/projects/${wireProjectId}/schedules`, body: { schedules: [] } },
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
          <Route path="/workflows" element={<LibraryPage />} />
          <Route path="/library/:pipelineId" element={<PipelinePage />} />
          <Route path="/workflows/:pipelineId" element={<PipelinePage />} />
          {/* The Studio route itself is tested in pages/Studio.test.tsx; the
              library only has to land the navigation there. */}
          <Route path="/library/:pipelineId/drafts/:draftId" element={<StudioRouteStub />} />
          <Route path="/workflows/:pipelineId/drafts/:draftId" element={<StudioRouteStub />} />
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

/** Open the New workflow dialog (1c): the header button is inert until the
 * `me` read says who is authoring, so wait for it to come alive first. */
async function openNewWorkflow() {
  const button = await screen.findByTestId("workflows-new-workflow");
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false), settled);
  fireEvent.click(button);
  return screen.findByTestId("new-workflow-dialog");
}

/** The starter cards are inert until `me` settles too — click when live. */
async function clickEnabledCard(testid: string) {
  const card = await screen.findByTestId(testid);
  await waitFor(() => expect((card as HTMLButtonElement).disabled).toBe(false), settled);
  fireEvent.click(card);
}

describe("/workflows — the index (3a)", () => {
  it("lists the org workflows with the server's own chips and opens the one you click", async () => {
    mount("/workflows");
    const list = await screen.findByTestId("workflows-list");
    expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(2);
    // The H1 carries the list read's own count — nothing invented.
    expect(screen.getByTestId("workflows-count").textContent).toBe("2");
    // The chip is the summary's own r-number; the digest moved to the
    // workflow page, so it is not shown in the index row.
    expect(screen.getByTestId("workflow-revision-feature-development").textContent).toContain(
      `r${wirePipeline.revisions[0].revision_number}`,
    );
    expect(screen.getByTestId("workflow-revision-feature-development").textContent).not.toContain(
      "3f2f3f",
    );
    // A zero-revision workflow reads `draft · not published` — no invented
    // revision.
    expect(screen.getByTestId("workflow-revision-module-check").textContent).toContain(
      "draft · not published",
    );
    fireEvent.click(screen.getByTestId("workflow-open-feature-development"));
    expect(await screen.findByTestId("pipeline-page")).toBeTruthy();
    expect((await screen.findByTestId("pipeline-header-meta")).textContent).toContain(
      "feature-development",
    );
  });

  it("names the assigned project and the trigger, and prints no draft line on the row", async () => {
    mount("/workflows");
    await screen.findByTestId("workflows-list");
    // The assignments fan is the caller's own membership: Widgets pins this
    // pipeline (wireAssignmentList) and has no schedule → `manual`.
    expect(screen.getByTestId("workflow-assignments-feature-development").textContent).toContain(
      projectFixture.name,
    );
    expect(screen.getByTestId("workflow-trigger-feature-development").textContent).toContain(
      "manual",
    );
    // 1b: the row no longer prints a draft line — the workflow page's
    // OPEN DRAFT card carries the editor and status.
    expect(screen.queryByTestId("workflow-draft-feature-development")).toBeNull();
  });

  it("a draft-only row chains from its newest open draft's document", async () => {
    const plan = PIPELINE_TEMPLATES.find((template) => template.id === "plan-with-approval");
    const childDraftId = "01987b23-0000-7000-8000-child0123456";
    const childDraftPath = `/api/v1/drafts/${childDraftId}`;
    const { requests } = mount("/workflows", [
      {
        path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}/drafts`,
        body: {
          drafts: [
            {
              id: childDraftId,
              status: "valid",
              version: 1,
              updated_at: "2026-07-31T09:00:00Z",
              edited_by: wireUserId,
            },
          ],
        },
      },
      {
        path: childDraftPath,
        body: { ...wireDraft("valid"), id: childDraftId, document_yaml: plan?.documentYaml ?? "" },
      },
    ]);
    const list = await screen.findByTestId("workflows-list");
    // module-check has zero revisions: its chain comes from the draft's own
    // document, read exactly once through the draft editor's own endpoint.
    await waitFor(
      () =>
        expect(within(list).getByTestId("workflow-chain-module-check-0").textContent).toContain(
          "survey",
        ),
      settled,
    );
    expect(within(list).getByTestId("workflow-chain-module-check-3").textContent).toContain(
      "publish_plan",
    );
    expect(requestsTo(requests, childDraftPath, "GET")).toHaveLength(1);
  });

  it("filters: the search field, `has open draft`, and `used in <project>` narrow the list", async () => {
    mount("/workflows");
    const list = await screen.findByTestId("workflows-list");
    expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(2);

    // The search field matches the wire's own slug and display name.
    fireEvent.change(screen.getByTestId("workflows-search"), { target: { value: "module" } });
    await waitFor(() => expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(1));
    expect(screen.getByTestId("workflow-row-module-check")).toBeTruthy();
    fireEvent.change(screen.getByTestId("workflows-search"), { target: { value: "" } });
    await waitFor(() => expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId("workflows-filter-draft"));
    await waitFor(() => expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(1));
    // module-check has no open draft; feature-development's draft is not published.
    expect(screen.getByTestId("workflow-row-feature-development")).toBeTruthy();
    expect(screen.queryByTestId("workflow-row-module-check")).toBeNull();

    fireEvent.click(screen.getByTestId("workflows-filter-all"));
    await waitFor(() => expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(2));

    // One `used in <project>` chip per project whose assignments fan pins an
    // indexed workflow — the chip is the filter, not a select.
    fireEvent.click(
      await screen.findByTestId(`workflows-used-in-${wireProjectId}`, undefined, settled),
    );
    await waitFor(() => expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(1));
    expect(screen.getByTestId("workflow-row-feature-development")).toBeTruthy();
  });

  it("Duplicate: a new `<slug>-copy` pipeline with exactly one draft, landing on that draft", async () => {
    const copyDraft: Draft = {
      ...wireDraft("draft"),
      id: COPY_DRAFT_ID,
      pipeline_id: COPY_PIPELINE_ID,
    };
    const { requests } = mount("/workflows", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: copyPipeline },
      {
        path: `/api/v1/pipelines/${COPY_PIPELINE_ID}/drafts`,
        method: "POST",
        status: 201,
        body: copyDraft,
      },
    ]);
    await screen.findByTestId("workflow-menu-feature-development");
    fireEvent.click(screen.getByTestId("workflow-menu-feature-development"));
    fireEvent.click(screen.getByTestId("workflow-duplicate-feature-development"));
    const landed = await screen.findByTestId("studio-route", undefined, settled);
    expect(landed.textContent).toBe(`${COPY_PIPELINE_ID} / ${COPY_DRAFT_ID}`);
    // The three writes: the source document, the new pipeline, the new draft.
    const pipelinePost = requestsTo(requests, "/api/v1/pipelines", "POST")[0];
    expect(pipelinePost.body).toContain(`"slug":"feature-development-copy"`);
    const draftPosts = requestsTo(requests, `/api/v1/pipelines/${COPY_PIPELINE_ID}/drafts`, "POST");
    expect(draftPosts).toHaveLength(1);
    expect(draftPosts[0].body).toContain("apiVersion");
  });

  it("Import YAML: the pipeline first, then the draft holding the pasted document, landing in Studio", async () => {
    const importedDraft: Draft = {
      ...wireDraft("draft"),
      id: IMPORT_DRAFT_ID,
      pipeline_id: IMPORT_PIPELINE_ID,
      document_yaml: w8DraftYaml,
    };
    const { requests } = mount("/workflows", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: importedPipeline },
      {
        path: `/api/v1/pipelines/${IMPORT_PIPELINE_ID}/drafts`,
        method: "POST",
        status: 201,
        body: importedDraft,
      },
    ]);
    fireEvent.click(await screen.findByTestId("workflows-import-yaml"));
    const dialog = await screen.findByTestId("import-yaml-dialog");
    fireEvent.change(within(dialog).getByTestId("import-yaml-doc"), {
      target: { value: w8DraftYaml },
    });
    fireEvent.change(within(dialog).getByTestId("import-yaml-slug"), {
      target: { value: "nightly-sweep" },
    });
    fireEvent.click(within(dialog).getByTestId("import-yaml-submit"));
    const landed = await screen.findByTestId("studio-route", undefined, settled);
    expect(landed.textContent).toBe(`${IMPORT_PIPELINE_ID} / ${IMPORT_DRAFT_ID}`);
    expect(requestsTo(requests, "/api/v1/pipelines", "POST")[0].body).toContain(
      `"slug":"nightly-sweep"`,
    );
    const draftPost = requestsTo(
      requests,
      `/api/v1/pipelines/${IMPORT_PIPELINE_ID}/drafts`,
      "POST",
    )[0];
    expect(draftPost.body).toContain("apiVersion");
  });

  it("Import YAML: Escape closes the dialog without writing anything", async () => {
    const { requests } = mount("/workflows", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: importedPipeline },
    ]);
    fireEvent.click(await screen.findByTestId("workflows-import-yaml"));
    await screen.findByTestId("import-yaml-dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("import-yaml-dialog")).toBeNull();
    expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(0);
  });

  it("posts a new workflow slug for an org admin", async () => {
    const { requests } = mount("/library", [
      { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
      { path: draftsPath, method: "POST", status: 201, body: wireDraft("draft") },
    ]);
    const dialog = await openNewWorkflow();
    // The id is generated from the name — there is no open slug field until
    // the author clicks `change`.
    fireEvent.change(within(dialog).getByTestId("library-new-name-input"), {
      target: { value: "nightly-sweep" },
    });
    expect(within(dialog).getByTestId("new-workflow-id").textContent).toContain(
      "id: nightly-sweep",
    );
    fireEvent.click(within(dialog).getByTestId("library-new-submit"));
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
    const dialog = await openNewWorkflow();
    // The START FROM cards pick the starter; the name stays what the author
    // types, and the id follows it.
    fireEvent.click(within(dialog).getByTestId("new-workflow-template-plan-with-approval"));
    // The picker says what the template does before you commit to it.
    expect(within(dialog).getByTestId("library-new-template-hint").textContent).toContain(
      "maintainer approval",
    );
    fireEvent.change(within(dialog).getByTestId("library-new-name-input"), {
      target: { value: "nightly-sweep" },
    });
    fireEvent.click(within(dialog).getByTestId("library-new-submit"));

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
    const dialog = await openNewWorkflow();
    fireEvent.click(within(dialog).getByTestId("new-workflow-template-security-review"));
    fireEvent.change(within(dialog).getByTestId("library-new-name-input"), {
      target: { value: "nightly-sweep" },
    });
    fireEvent.click(within(dialog).getByTestId("library-new-submit"));
    const banner = await screen.findByTestId("template-use-draft-failure", undefined, settled);
    // The pipeline was created, so the retry must not repeat that POST — the
    // second click would be a 409 on a slug the server already accepted.
    expect(banner.textContent).toContain("no replica could take the write");
    expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1);
    expect(screen.queryByTestId("pipeline-page")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("template-use-draft-retry"));
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
    const dialog = await openNewWorkflow();
    fireEvent.change(within(dialog).getByTestId("library-new-name-input"), {
      target: { value: "hand-written" },
    });
    // Blank is the picker's default and posts the skeleton, not "no document".
    fireEvent.click(within(dialog).getByTestId("library-new-submit"));

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

  // 1b: the starter cards replaced the bottom `STARTER WORKFLOWS` panel and
  // the inline form's template select — the cards are the dialog's own three
  // starting points, so a card click preselects and a create runs the same
  // two writes (pipeline first, draft second). The one authoring predicate
  // decides whether the cards read as an invitation or a refusal.
  describe("starter cards (1b)", () => {
    const member: Me = { ...meFixture, is_org_admin: false };

    it("shows the cards to a member who cannot create, disabled with the one-line reason", async () => {
      const { requests } = mount("/library", [{ path: "/api/v1/me", body: member }]);
      const cards = await screen.findByTestId("workflow-starters");
      expect(within(cards).getByTestId("workflow-starter-blank")).toBeTruthy();
      expect(within(cards).getByTestId("workflow-starter-plan-with-approval")).toBeTruthy();
      expect(within(cards).getByTestId("workflow-starter-security-review")).toBeTruthy();
      // The reason the cards are inert, in the page's own vocabulary — and
      // only once `me` has been read: loading is not authoring.
      await waitFor(
        () =>
          expect(screen.getByTestId("workflow-starters-need-role").textContent).toContain(
            "needs the library role to create",
          ),
        settled,
      );
      // The cards and the header button are all inert for a role that cannot
      // create — and reading the page is not authoring: no write is attempted.
      expect(
        (within(cards).getByTestId("workflow-starter-blank") as HTMLButtonElement).disabled,
      ).toBe(true);
      expect((screen.getByTestId("workflows-new-workflow") as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(0);
    });

    it("reads the vetted starting points: the canvas step count, and the document's own chain", async () => {
      mount("/library");
      const cards = await screen.findByTestId("workflow-starters");
      // An admin is never handed the refusal they do not need — not while
      // `me` is still loading, and not after it settles.
      await waitFor(
        () => expect(screen.queryByTestId("workflow-starters-need-role")).toBeNull(),
        settled,
      );
      // Blank is the dashed card with its own wording.
      const blank = within(cards).getByTestId("workflow-starter-blank");
      expect(blank.textContent).toContain("START BLANK");
      expect(blank.textContent).toContain("Empty canvas");
      expect(blank.textContent).toContain("One agent step to start from.");
      // Each template card advertises the step count the Studio canvas will
      // draw, and the chain is the document's own top-level node ids.
      for (const template of PIPELINE_TEMPLATES.filter((option) => option.id !== "blank")) {
        const card = within(cards).getByTestId(`workflow-starter-${template.id}`);
        expect(card.textContent).toContain(`TEMPLATE · ${template.stepCount} STEPS`);
        expect(card.textContent).toContain(template.label);
      }
      expect(
        within(cards).getByTestId("workflow-starter-plan-with-approval").textContent,
      ).toContain("survey › plan › approve › publish_plan");
      expect(within(cards).getByTestId("workflow-starter-security-review").textContent).toContain(
        "scan › summarize › publish_report",
      );
    });

    it("clicking a card opens the New workflow dialog with the template preselected", async () => {
      mount("/library");
      await clickEnabledCard("workflow-starter-plan-with-approval");
      const dialog = await screen.findByTestId("new-workflow-dialog");
      // The card's name is in the NAME field, the id follows it…
      const nameInput = within(dialog).getByTestId("library-new-name-input") as HTMLInputElement;
      expect(nameInput.value).toBe("Plan with approval");
      expect(within(dialog).getByTestId("new-workflow-id").textContent).toContain(
        "id: plan-with-approval",
      );
      // …and the START FROM cards show its selection.
      const radio = within(dialog)
        .getByTestId("new-workflow-template-plan-with-approval")
        .querySelector("input");
      expect(radio).not.toBeNull();
      expect((radio as HTMLInputElement).checked).toBe(true);
    });

    it("a card create posts the pipeline under the starter's slug, then its draft, and lands on Studio", async () => {
      const plan = PIPELINE_TEMPLATES.find((template) => template.id === "plan-with-approval");
      const seededDraft: Draft = {
        ...wireDraft("draft"),
        document_yaml: plan?.documentYaml ?? "",
      };
      const { requests } = mount("/library", [
        { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
        { path: draftsPath, method: "POST", status: 201, body: seededDraft },
        { path: draftPath, body: seededDraft },
      ]);
      await clickEnabledCard("workflow-starter-plan-with-approval");
      const dialog = await screen.findByTestId("new-workflow-dialog");
      fireEvent.click(within(dialog).getByTestId("library-new-submit"));

      await waitFor(
        () => expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1),
        settled,
      );
      const pipelinePost = requests.find(
        (request) => request.method === "POST" && request.url === "/api/v1/pipelines",
      );
      // The slug is the template id: a clone keeps the starter's name.
      expect(pipelinePost?.body).toContain("plan-with-approval");
      // The template's own document, `name:` rewritten to that slug — and the
      // page that lands is the Studio route with the new draft, not a form.
      await waitFor(
        () => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1),
        settled,
      );
      const draftPost = requests.find(
        (request) => request.method === "POST" && request.url === draftsPath,
      );
      const body = JSON.parse(draftPost?.body ?? "{}") as { document_yaml?: string };
      expect(metadataName(body.document_yaml ?? "")).toBe("name: plan-with-approval");
      expect((await screen.findByTestId("studio-route", undefined, settled)).textContent).toContain(
        WIRE_DRAFT_ID,
      );
    });

    it("a create on a slug the org already has is a 409 named on the id line, and no draft is posted", async () => {
      const { requests } = mount("/library", [
        {
          path: "/api/v1/pipelines",
          method: "POST",
          status: 409,
          body: { title: "conflict", status: 409, detail: "slug already exists" },
        },
      ]);
      await clickEnabledCard("workflow-starter-security-review");
      const dialog = await screen.findByTestId("new-workflow-dialog");
      fireEvent.click(within(dialog).getByTestId("library-new-submit"));
      const line = await screen.findByTestId("template-use-pipeline-failure", undefined, settled);
      expect(line.textContent).toContain("slug already exists");
      expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(0);
      expect(screen.queryByTestId("studio-route")).toBeNull();
    });

    it("a FOLDER pick files the new pipeline with one PATCH between the two writes", async () => {
      const seededDraft: Draft = { ...wireDraft("draft") };
      const { requests } = mount("/library", [
        { path: "/api/v1/pipelines", method: "GET", body: folderedList },
        { path: "/api/v1/pipelines", method: "POST", status: 201, body: wirePipeline },
        { path: pipelinePath, method: "PATCH", body: { ...wirePipeline, folder: "Delivery" } },
        { path: draftsPath, method: "POST", status: 201, body: seededDraft },
        { path: draftPath, body: seededDraft },
      ]);
      await clickEnabledCard("workflows-new-workflow");
      const dialog = await screen.findByTestId("new-workflow-dialog");
      fireEvent.change(within(dialog).getByTestId("library-new-name-input"), {
        target: { value: "nightly-sweep" },
      });
      // The pick is the wire's own existing folder — no free text.
      fireEvent.change(within(dialog).getByTestId("new-workflow-folder"), {
        target: { value: "Delivery" },
      });
      fireEvent.click(within(dialog).getByTestId("library-new-submit"));
      await waitFor(
        () => expect(requestsTo(requests, "/api/v1/pipelines", "POST")).toHaveLength(1),
        settled,
      );
      await waitFor(
        () => expect(requestsTo(requests, pipelinePath, "PATCH")).toHaveLength(1),
        settled,
      );
      const sent = JSON.parse(requestsTo(requests, pipelinePath, "PATCH")[0].body ?? "{}") as {
        folder: string;
      };
      expect(sent).toEqual({ folder: "Delivery" });
      await waitFor(
        () => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1),
        settled,
      );
      expect((await screen.findByTestId("studio-route", undefined, settled)).textContent).toContain(
        WIRE_DRAFT_ID,
      );
    });
  });
});

/** One wire row is filed under `Delivery`; the other carries `null` (Unfiled). */
const folderedList = {
  pipelines: [
    { ...wirePipelineList.pipelines[0], folder: "Delivery" },
    { ...wirePipelineList.pipelines[1], folder: null },
  ],
};

describe("/workflows — folders (ADR-0049 § 8)", () => {
  it("groups rows under collapsible folder headers; unfiled rows go headerless, counts from the API", async () => {
    mount("/workflows", [{ path: "/api/v1/pipelines", body: folderedList }]);
    const list = await screen.findByTestId("workflows-list");
    const headers = within(list).getAllByTestId(/^workflow-folder-header-/);
    // The folder panel gets the header; the unfiled rows do not (design 1b).
    expect(headers.map((header) => header.getAttribute("data-testid"))).toEqual([
      "workflow-folder-header-delivery",
    ]);
    // Each header carries its group's own count — nothing invented.
    expect(headers[0].textContent).toContain("Delivery");
    expect(headers[0].textContent).toContain("1");
    // The unfiled row lives in its own headerless group.
    expect(within(list).getByTestId("workflow-unfiled-group")).toBeTruthy();
    expect(screen.getByTestId("workflow-row-module-check")).toBeTruthy();

    // The collapse is real: the group's rows disappear and the button says so.
    fireEvent.click(headers[0]);
    expect(headers[0].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("workflow-row-feature-development")).toBeNull();
    expect(screen.getByTestId("workflow-row-module-check")).toBeTruthy();
    fireEvent.click(headers[0]);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-row-feature-development")).toBeTruthy();
    });
  });

  it("honours `?folder=` — Delivery and Unfiled — and the chip clears back to all folders", async () => {
    mount("/workflows?folder=Delivery", [{ path: "/api/v1/pipelines", body: folderedList }]);
    const list = await screen.findByTestId("workflows-list");
    expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(1);
    expect(screen.getByTestId("workflow-row-feature-development")).toBeTruthy();
    // The active folder filter is visible as a chip, and clicking it clears.
    fireEvent.click(screen.getByTestId("workflows-filter-folder"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("workflows-list")).getAllByTestId(/^workflow-row-/),
      ).toHaveLength(2),
    );
    cleanup();

    // The Unfiled group is headerless — its rows live in their own group.
    mount("/workflows?folder=Unfiled", [{ path: "/api/v1/pipelines", body: folderedList }]);
    const unfiled = await screen.findByTestId("workflow-unfiled-group");
    expect(within(unfiled).getAllByTestId(/^workflow-row-/)).toHaveLength(1);
    expect(screen.getByTestId("workflow-row-module-check")).toBeTruthy();
  });

  it("Move to folder…: one PATCH of the row's folder, then the dialog closes", async () => {
    const patchPath = `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}`;
    const { requests } = mount("/workflows", [
      { path: "/api/v1/pipelines", body: folderedList },
      { path: patchPath, method: "PATCH", body: { ...childPipeline, folder: "Delivery" } },
    ]);
    await screen.findByTestId("workflows-list");
    fireEvent.click(screen.getByTestId("workflow-menu-module-check"));
    fireEvent.click(screen.getByTestId("workflow-move-folder-module-check"));
    const input = (await screen.findByTestId("move-folder-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Delivery" } });
    fireEvent.click(screen.getByTestId("move-folder-submit"));
    await waitFor(() => {
      expect(requestsTo(requests, patchPath, "PATCH")).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, patchPath, "PATCH")[0].body ?? "{}") as {
      folder: string | null;
    };
    expect(sent).toEqual({ folder: "Delivery" });
    await waitFor(() => expect(screen.queryByTestId("move-folder-dialog")).toBeNull());
  });

  it("Move to folder… unfiles with an empty input (`folder: null`)", async () => {
    const patchPath = `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}`;
    const { requests } = mount("/workflows", [
      { path: "/api/v1/pipelines", body: folderedList },
      { path: patchPath, method: "PATCH", body: { ...childPipeline, folder: null } },
    ]);
    await screen.findByTestId("workflows-list");
    fireEvent.click(screen.getByTestId("workflow-menu-module-check"));
    fireEvent.click(screen.getByTestId("workflow-move-folder-module-check"));
    await screen.findByTestId("move-folder-input");
    fireEvent.click(screen.getByTestId("move-folder-submit"));
    await waitFor(() => {
      expect(requestsTo(requests, patchPath, "PATCH")).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, patchPath, "PATCH")[0].body ?? "{}") as {
      folder: string | null;
    };
    expect(sent).toEqual({ folder: null });
  });

  it("stays one flat list — no folder groups, no folder chip — when show_workflow_folders is off", async () => {
    mount("/workflows", [
      { path: "/api/v1/pipelines", body: folderedList },
      {
        path: "/api/v1/me/preferences",
        body: {
          layout: {
            projects_mode: "tree",
            ask_placement: "sidebar",
            show_workflow_folders: false,
            expanded: {},
          },
          assistant: { trust_level: "ask_risky" },
          updated_at: null,
        },
      },
    ]);
    const list = await screen.findByTestId("workflows-list");
    expect(within(list).queryAllByTestId(/^workflow-folder-header-/)).toHaveLength(0);
    expect(screen.queryByTestId("workflow-unfiled-group")).toBeNull();
    expect(screen.queryByTestId("workflows-filter-folder")).toBeNull();
    expect(within(list).getAllByTestId(/^workflow-row-/)).toHaveLength(2);
  });
});
