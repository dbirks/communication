/**
 * `/projects/:id/artifacts` and `/artifacts/:id` (M3). The assertions that carry
 * weight: the preview frame is cross-origin and fully sandboxed, and a restricted
 * or secret artifact never gets more than metadata.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  artifactFixture,
  artifactId,
  conversationId,
  meFixture,
  projectFixture,
  requestsTo,
  turnId,
  workerId,
  type RouteStub,
} from "../test/fakes";
import type { Artifact } from "../api/types";

const projectId = projectFixture.id;
const apiProject = `/api/v1/projects/${projectId}`;
const listPath = `${apiProject}/artifacts`;
const detailPath = `/api/v1/artifacts/${artifactId}`;
const tokenPath = `${detailPath}/preview-token`;
// The origin jsdom gave this document. A preview URL on it would carry the
// session cookie, which is the whole thing ADR-0020 exists to prevent.
const APP_ORIGIN = window.location.origin;
const PREVIEW_URL = "http://preview.localhost:18084/preview/{token}";

const restricted: Artifact = {
  ...artifactFixture,
  id: "01987a78-9998-7000-8000-abcdef012345",
  name: "internal-audit.html",
  sensitivity: "restricted",
  preview_url: PREVIEW_URL,
};

const secretArtifact: Artifact = {
  ...artifactFixture,
  id: "01987a78-9997-7000-8000-abcdef012345",
  name: "dump.txt",
  kind: "markdown",
  media_type: "text/plain",
  sensitivity: "secret",
  preview_url: null,
};

const uploadingArtifact: Artifact = {
  ...artifactFixture,
  id: "01987a78-9996-7000-8000-abcdef012345",
  name: "half-written.html",
  state: "uploading",
};

const orphanArtifact: Artifact = {
  ...artifactFixture,
  id: "01987a78-9995-7000-8000-abcdef012345",
  name: "unreferenced.html",
  state: "orphan",
  redaction_count: 3,
  created_by: meFixture.id,
};

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    ...extra,
    { path: apiProject, method: "GET", body: projectFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [meFixture] } },
  ];
}

function previewTokenStub(previewUrl = PREVIEW_URL): RouteStub {
  return {
    path: tokenPath,
    method: "POST",
    status: 201,
    body: {
      artifact_id: artifactId,
      token: "tok.abc",
      preview_url: previewUrl,
      expires_at: "2026-10-14T18:24:00Z",
    },
  };
}

describe("/projects/:projectId/artifacts", () => {
  it("indexes artifacts by name, kind, bytes and sensitivity — never by host path", async () => {
    renderApp({
      path: `/projects/${projectId}/artifacts`,
      routes: routes([
        {
          path: listPath,
          method: "GET",
          body: { artifacts: [artifactFixture, restricted, secretArtifact] },
        },
      ]),
    });

    const row = await screen.findByTestId(`artifact-row-${artifactFixture.name}`);
    expect(row.textContent).toContain("html");
    expect(row.textContent).toContain("84 KB");
    expect(row.textContent).not.toContain("/workspaces/");
    expect(screen.getByTestId(`artifact-sensitivity-${artifactFixture.id}`).textContent).toContain(
      "internal",
    );
    expect(screen.getByTestId(`artifact-sensitivity-${secretArtifact.id}`).textContent).toContain(
      "secret",
    );
    // Rows are links into the detail screen.
    expect(row.getAttribute("href")).toBe(`/artifacts/${artifactId}`);
  });

  it("explains that an index nobody has produced is empty, not hidden", async () => {
    renderApp({
      path: `/projects/${projectId}/artifacts`,
      routes: routes([{ path: listPath, method: "GET", body: { artifacts: [] } }]),
    });
    expect((await screen.findByTestId("artifact-list-empty")).textContent).toMatch(
      /no artifacts yet/i,
    );
  });

  it("surfaces a refused artifact index instead of an empty list", async () => {
    renderApp({
      path: `/projects/${projectId}/artifacts`,
      routes: routes([
        {
          path: listPath,
          method: "GET",
          status: 403,
          body: { type: "about:blank", title: "Forbidden", status: 403, detail: "not a member" },
        },
      ]),
    });
    // A refused index is a stated permission fact, never an empty list.
    expect((await screen.findByTestId("artifacts-error")).textContent).toContain(
      "not readable with your role",
    );
  });

  it("navigates from a row to the artifact screen", async () => {
    renderApp({
      path: `/projects/${projectId}/artifacts`,
      routes: routes([
        { path: listPath, method: "GET", body: { artifacts: [artifactFixture] } },
        { path: detailPath, method: "GET", body: artifactFixture },
      ]),
    });
    fireEvent.click(await screen.findByTestId(`artifact-row-${artifactFixture.name}`));
    expect((await screen.findByTestId("artifact-title")).textContent).toBe(artifactFixture.name);
  });
});

describe("/artifacts/:artifactId", () => {
  it("shows the content-addressed metadata an audit needs", async () => {
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([{ path: detailPath, method: "GET", body: artifactFixture }]),
    });

    // Pass-2 review (`artifact-plan-md`): the full 64-char digest is not a
    // fact a reader can compare at a glance — the row prints the 12-char
    // prefix with an ellipsis, the whole value rides the `title`, and the
    // copy button is the paste path. And `kind markdown` beside `media
    // Markdown` said it twice: the media row is the one that stays.
    const sha = await screen.findByTestId("artifact-sha256");
    expect(sha.querySelector("span[title]")?.getAttribute("title")).toBe(artifactFixture.sha256);
    expect(sha.textContent).toContain("7c1f7c1f7c1f");
    expect(sha.textContent).not.toContain(artifactFixture.sha256);
    expect(screen.getByTestId("artifact-sha256-copy").textContent).toBe("copy");
    const mediaRow = screen.getByTestId("artifact-media-type").parentElement as HTMLElement;
    expect(mediaRow.querySelector("dt")?.textContent).toBe("media");
    expect(sha.parentElement?.querySelector("dt")?.textContent).toBe("sha256");
    expect(screen.queryByText("kind")).toBeNull();
    expect(screen.getByTestId("artifact-size").textContent).toContain("KB");
    expect(screen.getByTestId("artifact-sensitivity").textContent).toContain("may download");
    expect(screen.getByTestId("artifact-redaction").textContent).toContain("changed nothing");
    // The byline (pass-1 review of this brief): the old "scanner" key beside
    // the "scanner changed nothing" copy printed the word twice — the key is
    // "redaction" now, and "scanner" is in the sentence exactly once.
    const redactionRow = screen.getByTestId("artifact-redaction").parentElement as HTMLElement;
    expect(redactionRow.querySelector("dt")?.textContent).toBe("redaction");
    expect(redactionRow.textContent?.match(/scanner/g)).toHaveLength(1);
    // Provenance is a link to the conversation, because the ids are not readable.
    const provenance = screen.getByTestId("artifact-conversation-link");
    expect(provenance.getAttribute("href")).toBe(`/threads/${conversationId}`);
    expect(provenance.textContent).toContain(conversationId.slice(-8));
    expect(screen.getByTestId("artifact-turn").textContent).toBe(turnId.slice(-8));
  });

  it("names a worker-created artifact as a worker, not as a uuid", async () => {
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([{ path: detailPath, method: "GET", body: artifactFixture }]),
    });
    expect((await screen.findByTestId("artifact-created-by")).textContent).toBe("a worker");
  });

  it("names a human uploader from the actor directory", async () => {
    renderApp({
      path: `/artifacts/${orphanArtifact.id}`,
      routes: routes([
        {
          path: `/api/v1/artifacts/${orphanArtifact.id}`,
          method: "GET",
          body: { ...orphanArtifact, created_by: meFixture.id },
        },
      ]),
    });
    expect((await screen.findByTestId("artifact-created-by")).textContent).toContain(
      meFixture.display_name,
    );
    // A non-zero redaction count is the warning; zero is the normal case.
    expect(screen.getByTestId("artifact-redaction").textContent).toContain("3 spans");
  });

  it("offers a download as a plain navigation to …/content", async () => {
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([{ path: detailPath, method: "GET", body: artifactFixture }]),
    });
    const link = await screen.findByTestId("artifact-download");
    expect(link.getAttribute("href")).toBe(`${detailPath}/content`);
  });

  it("renders the HTML preview in a frame that is cross-origin and grants nothing", async () => {
    const { requests } = renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([
        { path: detailPath, method: "GET", body: artifactFixture },
        previewTokenStub(),
      ]),
    });

    fireEvent.click(await screen.findByTestId("artifact-preview-open"));
    const frame = (await screen.findByTestId("artifact-preview-frame")) as HTMLIFrameElement;
    // The mint is a POST, and the URL is the server's, never assembled here.
    expect(requestsTo(requests, tokenPath, "POST").length).toBe(1);
    expect(frame.getAttribute("src")).toBe("http://preview.localhost:18084/preview/tok.abc");
    expect(new URL(frame.src).origin).not.toBe(APP_ORIGIN);
    // Empty `sandbox` = no scripts, no same-origin, no forms, no top navigation.
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerPolicy")).toBe("no-referrer");
    expect(screen.getByTestId("artifact-preview-warning").textContent).toContain("another origin");

    // Closing the frame forgets the credential rather than leaving it in the DOM.
    fireEvent.click(screen.getByTestId("artifact-preview-close"));
    await waitFor(() => expect(screen.queryByTestId("artifact-preview-frame")).toBeNull());
    expect(document.body.textContent).not.toContain("tok.abc");
  });

  it("refuses to embed a preview URL that shares this origin", async () => {
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([
        { path: detailPath, method: "GET", body: artifactFixture },
        previewTokenStub(`${APP_ORIGIN}/preview/tok.abc`),
      ]),
    });
    fireEvent.click(await screen.findByTestId("artifact-preview-open"));
    const refusal = await screen.findByTestId("artifact-preview-origin-refused");
    expect(refusal.textContent).toContain("another hostname");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("never previews a restricted artifact, and says a download needs a maintainer", async () => {
    renderApp({
      path: `/artifacts/${restricted.id}`,
      routes: routes([
        { path: `/api/v1/artifacts/${restricted.id}`, method: "GET", body: restricted },
      ]),
    });
    expect((await screen.findByTestId("artifact-preview-blocked")).textContent).toContain(
      "can't be previewed",
    );
    expect(screen.getByTestId("artifact-download-unavailable").textContent).toContain("maintainer");
    expect(screen.queryByTestId("artifact-download")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("offers no download and no preview for a `secret` artifact", async () => {
    renderApp({
      path: `/artifacts/${secretArtifact.id}`,
      routes: routes([
        { path: `/api/v1/artifacts/${secretArtifact.id}`, method: "GET", body: secretArtifact },
      ]),
    });
    await screen.findByTestId("artifact-title");
    expect(screen.queryByTestId("artifact-download")).toBeNull();
    expect(screen.queryByTestId("artifact-preview-open")).toBeNull();
    expect(screen.getByTestId("artifact-preview-blocked").textContent).toContain(
      "no download path",
    );
  });

  it("does not offer bytes that are not ready", async () => {
    renderApp({
      path: `/artifacts/${uploadingArtifact.id}`,
      routes: routes([
        {
          path: `/api/v1/artifacts/${uploadingArtifact.id}`,
          method: "GET",
          body: uploadingArtifact,
        },
      ]),
    });
    expect((await screen.findByTestId("artifact-preview-blocked")).textContent).toContain(
      "uploading",
    );
    expect(screen.getAllByTestId(`artifact-state-${uploadingArtifact.id}`).length).toBeGreaterThan(
      0,
    );
  });

  it("says a hidden row and a missing row look identical, because the API cannot tell them apart", async () => {
    renderApp({
      path: "/artifacts/01987a78-0000-7000-8000-abcdef012345",
      routes: routes([
        {
          path: "/api/v1/artifacts/01987a78-0000-7000-8000-abcdef012345",
          method: "GET",
          status: 404,
          body: { type: "about:blank", title: "Not Found", status: 404, detail: "gone" },
        },
      ]),
    });
    expect((await screen.findByTestId("artifact-not-found")).textContent).toContain("identically");
  });

  it("says why a preview token could not be minted instead of showing a blank frame", async () => {
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([
        { path: detailPath, method: "GET", body: artifactFixture },
        {
          path: tokenPath,
          method: "POST",
          status: 403,
          body: { type: "about:blank", title: "Forbidden", status: 403, detail: "no access" },
        },
      ]),
    });
    fireEvent.click(await screen.findByTestId("artifact-preview-open"));
    expect((await screen.findByTestId("artifact-preview-error")).textContent).toContain(
      "no access",
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("offers no preview affordance for bytes that are not HTML or Markdown", async () => {
    const logArtifact: Artifact = {
      ...artifactFixture,
      media_type: "text/plain",
      kind: "markdown",
      preview_url: null,
    };
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([{ path: detailPath, method: "GET", body: logArtifact }]),
    });
    const line = await screen.findByTestId("artifact-preview-unavailable");
    expect(line.textContent).toContain("Only HTML previews");
    expect(screen.queryByTestId("artifact-preview-open")).toBeNull();
    // Round-2 review item 4: the raw wire media type is not user copy. `kind`
    // says how the row was filed; the sentence says what the bytes are, in the
    // words a person uses.
    expect(line.textContent).toContain("Text");
    expect(line.textContent).not.toContain("text/plain");
    expect(screen.getByTestId("artifact-media-type").textContent).toBe("Text");
    expect(screen.getByTestId("artifact-media-type").getAttribute("title")).toBe("text/plain");
  });

  // Round-2 review item 4: `plan.md` — the artifact the gate's whole decision
  // rests on — told the reader to go download it while the app already owns a
  // markdown reader. A small text/markdown artifact is now READ on the page,
  // through `lib/markdown.tsx`, which emits React text nodes: no HTML, no
  // script, nothing executing in this origin (ADR-0020 stays intact — the
  // isolated preview frame remains the only way bytes are rendered).
  it("reads a small markdown artifact on the page instead of sending the reader away", async () => {
    const planArtifact: Artifact = {
      ...artifactFixture,
      name: "plan.md",
      kind: "markdown",
      media_type: "text/markdown",
      sensitivity: "standard",
      preview_url: null,
      size_bytes: 4096,
    };
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([
        { path: detailPath, method: "GET", body: planArtifact },
        {
          path: `${detailPath}/content`,
          method: "GET",
          body: "## Implementation Plan\n\n1. **Confirm the binding**\n",
        },
      ]),
    });

    const preview = await screen.findByTestId("artifact-preview-markdown");
    expect(preview.textContent).toContain("Implementation Plan");
    // The markers became structure rather than text the reader decodes.
    expect(screen.getByTestId("markdown-heading").textContent).toBe("Implementation Plan");
    expect(preview.textContent).not.toContain("##");
    expect(screen.queryByTestId("artifact-preview-unavailable")).toBeNull();
    // …and the media line says what it is in the reader's own words.
    expect(screen.getByTestId("artifact-media-type").textContent).toBe("Markdown");
  });

  // Pass-1 design review item 4 (`artifact-plan-md-1280.png`, `-390.png`): the
  // bytes behind `plan.md` were `artifact.publish`'s wrapper around a
  // `model.chat` answer — a title, a developer byline, and the envelope
  // `{endpoint, model, text}` in a fenced JSON block. The page printed the
  // packaging (escaped markdown, API fields) and at 390 that block pushed the
  // page sideways. The reader gets the document; the payload stays one click away.
  const RUN_ID = "01987b24-7a1e-7000-8000-abcdef012345";
  const modelAnswer =
    "\n\n# Plan: emu gate journey pass-1-20261101051222 — prove the gate and the plan artifact\n\n" +
    "1. **Confirm fixture integrity (read-only mount check)**\n" +
    "   - Files: `README.md`, `pytest.ini`, `hello.py`\n\n" +
    "1. **Execute the gate: run `pytest` on the clean checkout (expected FAIL)**\n" +
    "   - Files: `tests/test_hello.py`, `hello.py`\n";
  const envelopeJson = JSON.stringify(
    {
      endpoint: "llm-collective.e-gineering.com",
      model: "david-birks/qwen3-8-flash-next",
      text: modelAnswer,
    },
    null,
    2,
  );
  /** What `worker/artifactpublish.go`'s `renderMarkdownDoc` writes for a
   * `kind=markdown` payload whose value is a model answer. */
  const publishedPlan =
    "# plan\n\nPublished by pipeline node `publish_plan` (instance `/publish_plan`, " +
    "attempt 1) via `artifact.publish`.\n\n```json\n" +
    envelopeJson +
    "\n```\n";
  const planMd: Artifact = {
    ...artifactFixture,
    name: "plan.md",
    kind: "markdown",
    media_type: "text/markdown",
    sensitivity: "standard",
    preview_url: null,
    size_bytes: publishedPlan.length,
    conversation_id: null,
    turn_id: null,
    run_id: RUN_ID,
  };

  async function renderPublishedPlan(body: string, artifact: Artifact = planMd) {
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([
        { path: detailPath, method: "GET", body: artifact },
        { path: `${detailPath}/content`, method: "GET", body },
      ]),
    });
    return screen.findByTestId("artifact-preview-markdown");
  }

  it("reads a published model answer as the plan it holds, not as its envelope", async () => {
    await renderPublishedPlan(publishedPlan);
    const prose = screen.getByTestId("artifact-preview-prose");
    // The author's own heading leads, not the wrapper's `# plan`.
    const headings = Array.from(prose.querySelectorAll('[data-testid="markdown-heading"]'));
    expect(headings[0]?.textContent).toBe(
      "Plan: emu gate journey pass-1-20261101051222 — prove the gate and the plan artifact",
    );
    const steps = prose.querySelectorAll('[data-testid="markdown-list-ordered"] > li');
    expect(steps.length).toBe(2);
    // No packaging leaks into the read: no API field, no escaped newline, and
    // every list marker became a number.
    expect(prose.textContent).not.toContain("endpoint");
    expect(prose.textContent).not.toContain("\\n");
    expect(prose.textContent).not.toContain("# Plan:");
    expect(prose.textContent).not.toContain("```json");
    expect(
      Array.from(
        prose.querySelectorAll('[data-testid="markdown-list-ordered"] > li > span[aria-hidden]'),
      ).map((node) => node.textContent),
    ).toEqual(["1.", "2."]);
  });

  it("says who published it in the reader's words, and links the run", async () => {
    const preview = await renderPublishedPlan(publishedPlan);
    const byline = screen.getByTestId("artifact-published-by");
    expect(byline.textContent).toContain("Published by the");
    expect(byline.textContent).toContain("publish_plan");
    expect(byline.textContent).toContain("step of run");
    expect(byline.textContent).not.toContain("artifact.publish");
    expect(byline.textContent).not.toContain("instance");
    const link = screen.getByTestId("artifact-published-run-link");
    expect(link.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    // The sentence is part of the preview card, not the metadata grid.
    expect(preview.contains(byline)).toBe(true);
  });

  it("keeps the stored payload reachable under a raw toggle that wraps in its box", async () => {
    await renderPublishedPlan(publishedPlan);
    const raw = screen.getByTestId("artifact-preview-raw");
    // Closed by default: the reader saw the envelope for the first time because
    // nothing asked them to, and the words “show raw” say who is asking.
    expect(raw.hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("artifact-preview-prose").textContent).not.toContain("endpoint");
    fireEvent.click(screen.getByTestId("artifact-raw-toggle"));
    expect(raw.hasAttribute("hidden")).toBe(false);
    expect(raw.textContent).toContain('"endpoint": "llm-collective.e-gineering.com"');
    // The JSON's lines are long and unbroken; `width:0` + `min-width:100%` is what
    // keeps them inside the box at 390 instead of widening the page.
    expect(raw.getAttribute("style")).toContain("min-width: 100%");
    expect(raw.className).toContain("overflow-auto");
    expect(raw.className).toContain("max-h-64");
    // The stored "text" value is one line thousands of characters long, which was
    // being cut mid-word at the right edge with no visible sideways scroll (design
    // review on 4cbcb80), so the payload wraps inside the box instead.
    expect(raw.className).toContain("whitespace-pre-wrap");
    expect(raw.className).toContain("[overflow-wrap:anywhere]");
    fireEvent.click(screen.getByTestId("artifact-raw-toggle"));
    expect(raw.hasAttribute("hidden")).toBe(true);
  });

  it("reads an envelope that is the whole body, with no wrapper around it", async () => {
    await renderPublishedPlan(envelopeJson);
    const prose = screen.getByTestId("artifact-preview-prose");
    expect(prose.textContent).toContain("Confirm fixture integrity");
    expect(prose.textContent).not.toContain("qwen3-8-flash-next");
    expect(screen.getByTestId("artifact-preview-raw").textContent).toContain("qwen3-8-flash-next");
    // No byline to rewrite, so the screen invents none.
    expect(screen.queryByTestId("artifact-published-by")).toBeNull();
  });

  it("leaves a markdown document that is not packaging alone", async () => {
    const body =
      '## Findings\n\n1. **Read the log**\n   - Files: `run.log`\n\n```json\n{"exit": 1}\n```\n';
    const preview = await renderPublishedPlan(body, { ...planMd, name: "findings.md" });
    expect(preview.textContent).toContain("Findings");
    // A fence that is not an envelope is the author's own code block: it stays
    // inline, and there is no raw payload to hide behind a toggle.
    expect(screen.queryByTestId("artifact-raw-block")).toBeNull();
    expect(screen.getByTestId("markdown-code").textContent).toBe('{"exit": 1}');
  });

  it("leaves a markdown file too large to read on the page as a download", async () => {
    const bigArtifact: Artifact = {
      ...artifactFixture,
      name: "plan.md",
      kind: "markdown",
      media_type: "text/markdown",
      sensitivity: "standard",
      preview_url: null,
      size_bytes: 4 * 1024 * 1024,
    };
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([{ path: detailPath, method: "GET", body: bigArtifact }]),
    });

    expect((await screen.findByTestId("artifact-preview-unavailable")).textContent).toContain(
      "Markdown",
    );
    expect(screen.queryByTestId("artifact-preview-markdown")).toBeNull();
  });

  it("names a file the common types do not cover by its own extension", async () => {
    const logArtifact: Artifact = {
      ...artifactFixture,
      name: "run.log",
      media_type: "application/octet-stream",
      preview_url: null,
    };
    renderApp({
      path: `/artifacts/${artifactId}`,
      routes: routes([{ path: detailPath, method: "GET", body: logArtifact }]),
    });
    expect((await screen.findByTestId("artifact-media-type")).textContent).toBe("LOG");
  });
});

/**
 * The pass-2 design review's artifact page (`artifact-plan-md-1280.png`): the
 * breadcrumb said the word "Project" where the reader is standing inside one
 * called Widgets, the byline said `someone (4e7f968c)` for the worker that
 * published the file, and `created` was a wall clock while every artifact row
 * above it reads an age.
 */
describe("/artifacts/:id names the project, the publisher and the moment", () => {
  const runId = "01987b24-0007-7000-8000-abcdef012345";
  /** The published row the emulator served: worker provenance, no person. */
  const published: Artifact = {
    ...artifactFixture,
    id: "01987a78-9994-7000-8000-abcdef012345",
    name: "plan.md",
    kind: "markdown",
    media_type: "text/markdown",
    sensitivity: "standard",
    conversation_id: null,
    turn_id: null,
    run_id: runId,
    worker_id: workerId,
    // What the publish path really writes: the worker's own id, not the literal
    // "worker" (`attempt_artifacts.go`), which the page used to call a stranger.
    created_by: workerId,
    created_at: new Date(Date.parse("2026-10-14T18:19:00Z")).toISOString(),
    preview_url: null,
  };
  const publishedPath = `/api/v1/artifacts/${published.id}`;
  const detail = { path: publishedPath, method: "GET" as const, body: published };

  it("puts the project's name in the breadcrumb, not the word Project", async () => {
    renderApp({ path: `/artifacts/${published.id}`, routes: routes([detail]) });
    const crumb = await screen.findByTestId("artifact-breadcrumb-project");
    // The generic word is only the arm the page holds while `GET /projects/{id}`
    // is in flight; the name is what stays on screen.
    await waitFor(() => expect(crumb.textContent).toBe(projectFixture.name));
    expect(crumb.getAttribute("href")).toBe(`/p/${projectId}`);
  });

  it("names a worker-published artifact the run that published it", async () => {
    renderApp({ path: `/artifacts/${published.id}`, routes: routes([detail]) });
    const by = await screen.findByTestId("artifact-created-by");
    // "someone (cdef2345)" was the defect: a worker is not a person the
    // directory can name, and the row says what it was published for.
    expect(by.textContent).toContain("the run");
    expect(by.textContent).not.toContain("someone");
    expect(by.textContent).not.toContain(workerId);
  });

  it("keeps a person's name for a person who uploaded it", async () => {
    renderApp({
      path: `/artifacts/${published.id}`,
      routes: routes([
        { path: publishedPath, method: "GET", body: { ...published, created_by: meFixture.id } },
      ]),
    });
    expect((await screen.findByTestId("artifact-created-by")).textContent).toContain(
      meFixture.display_name,
    );
  });

  it("reads the moment as an age, with the exact stamp one hover away", async () => {
    // A row created 5 minutes ago reads `5m ago`, the way `ArtifactRow` reads.
    const fresh: Artifact = {
      ...published,
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    renderApp({
      path: `/artifacts/${fresh.id}`,
      routes: routes([{ path: publishedPath, method: "GET", body: fresh }]),
    });
    const created = await screen.findByTestId("artifact-created-at");
    expect(created.textContent).toBe("5m ago");
    expect(created.getAttribute("title")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });
});
