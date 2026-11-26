/**
 * Manage → Secrets (`/manage/secrets?project=<id>`): the secret-metadata,
 * create/rotate/revoke, `.env` mount and materialization-audit behaviours the
 * old per-project Settings page (`pages/ProjectSettings.tsx`) used to own.
 *
 * The redesign moved the three panels — `SecretsPanel`, `SecretMountsPanel`,
 * `MaterializationsPanel` — out of `/p/:p/settings` and into this section
 * unchanged (`pages/manage/Secrets.tsx`), so every assertion below is the one
 * the old page carried; only the address and the way the project is chosen
 * (the `?project=` filter) are new. Nothing was weakened on the way: the value
 * still never comes back, a refusal still reads as a refusal, and the mount
 * form still refuses a path that escapes the checkout.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import SecretsSection from "./Secrets";
import {
  claudeProfile,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  secretFixture,
  secretId,
  secretMountFixture,
  mountId,
  repositoryId,
  workspaceFixture,
  revokedSecretFixture,
  type RouteStub,
} from "../../test/fakes";
import type { Member, Project, Repository, SecretMaterialization } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const secretsPath = `${projectPath}/secrets`;
const mountsPath = `${projectPath}/secret-mounts`;

const repository: Repository = {
  id: repositoryId,
  project_id: projectId,
  name: "backend",
  git_url: "https://github.com/example/backend.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
};

const member: Member = { user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" };

const materialization: SecretMaterialization = {
  // `id` is an int64 row id on this wire (`SecretMaterialization.id`), not a uuid.
  id: 4711,
  secret_id: secretId,
  slug: secretFixture.slug,
  secret_version: 3,
  workspace_id: workspaceFixture.id,
  turn_id: "01987a72-1213-7000-8000-abcdef012345",
  worker_id: "01987a74-5555-7000-8000-abcdef012345",
  delivery_mode: "env_file",
  target: "backend/.env.test.local",
  file_mode: 384,
  materialized_at: "2026-10-14T18:20:00Z",
  cleaned_at: "2026-10-14T18:31:00Z",
  cleaned_by: "startup_sweep",
};

function secretsRoutes(project: Project, extra: RouteStub[] = []): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    ...extra,
    // The section picks the project out of the caller's project list; first
    // match wins in the fetch mock, so the list above any override.
    { path: "/api/v1/projects", method: "GET", body: { items: [project] } },
    { path: secretsPath, method: "GET", body: { secrets: [secretFixture, revokedSecretFixture] } },
    {
      path: mountsPath,
      method: "GET",
      body: { secret_mounts: [{ ...secretMountFixture, key: "DATABASE_URL" }] },
    },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [repository] } },
    { path: `${projectPath}/workspaces`, method: "GET", body: { workspaces: [workspaceFixture] } },
    { path: "/api/v1/agent-profiles", method: "GET", body: { items: [claudeProfile] } },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: `${projectPath}/members`, method: "GET", body: { items: [member] } },
    { path: projectPath, method: "GET", body: project },
  ];
}

function renderSecrets(project: Project = projectFixture, extra: RouteStub[] = []) {
  const { requests } = mockFetch(secretsRoutes(project, extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/manage/secrets?project=${projectId}`]}>
        <Routes>
          <Route path="/manage/secrets" element={<SecretsSection />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("/manage/secrets — secret metadata", () => {
  it("lists SecretRef metadata and says plainly that no value is listed", async () => {
    renderSecrets();

    const row = await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    expect(row.textContent).toContain("project");
    expect(row.textContent).toContain("env_file");
    expect(row.textContent).toContain("v3");
    // Allowlist in words: the profile's own name, resolved from `/agent-profiles`.
    expect(row.textContent).toContain(claudeProfile.name);
    expect(row.textContent).toContain("materialization");

    const revoked = await screen.findByTestId(`secret-row-${revokedSecretFixture.slug}`);
    expect(revoked.textContent).toContain("revoked");

    expect(screen.getByTestId("secret-list").textContent).toContain(
      "metadata only, values are never readable",
    );
    // Nothing on this screen can be a value: the list body carries no secret bytes.
    expect(document.body.textContent).not.toContain("s3cr3t");
  });

  it("reads as an allowlist denial when no profile may receive a secret", async () => {
    renderSecrets();
    const revoked = await screen.findByTestId(`secret-row-${revokedSecretFixture.slug}`);
    // Empty allowlist is "denied to every profile", never a blank cell.
    expect(revoked.textContent).toContain("no profile may receive it");
  });

  it("shows the honest empty state when a project has no references", async () => {
    renderSecrets(projectFixture, [
      { path: secretsPath, method: "GET", body: { secrets: [] } },
      { path: mountsPath, method: "GET", body: { secret_mounts: [] } },
    ]);

    expect((await screen.findByTestId("secret-list-empty")).textContent).toMatch(
      /no secret references yet/i,
    );
    expect(screen.getByTestId("secret-mount-list-empty").textContent).toContain(
      "a secret nothing can use",
    );
  });

  it("reports a forbidden secrets read instead of an empty list", async () => {
    renderSecrets({ ...projectFixture, my_role: "viewer" }, [
      {
        path: secretsPath,
        method: "GET",
        status: 403,
        body: {
          type: "https://communication.dev/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "only project members may read secrets",
        },
      },
    ]);
    const alert = await screen.findByTestId("secret-list-error");
    expect(alert.textContent).toContain("only project members may read secrets");
    // A viewer keeps the metadata it can read and loses every write affordance.
    expect(screen.queryByTestId("secret-create-form")).toBeNull();
  });
});

describe("/manage/secrets — the value never comes back", () => {
  it("posts the typed value once, then holds nothing on screen", async () => {
    const created = { ...secretFixture, id: "01987a76-9999-7000-8000-abcdef012345" };
    const { requests } = renderSecrets(projectFixture, [
      { path: secretsPath, method: "POST", status: 201, body: created },
    ]);

    fireEvent.change(await screen.findByTestId("secret-slug"), {
      target: { value: "new-token" },
    });
    fireEvent.change(screen.getByTestId("secret-purpose"), { target: { value: "ci uploads" } });
    const value = screen.getByTestId("secret-value") as HTMLInputElement;
    fireEvent.change(value, { target: { value: "hunter2-do-not-render" } });

    // Masked, and not auto-filled from anywhere.
    expect(value.type).toBe("password");
    expect(value.getAttribute("autocomplete")).toBe("new-password");

    fireEvent.click(screen.getByTestId("secret-submit"));
    await waitFor(() => expect(requestsTo(requests, secretsPath, "POST").length).toBe(1));
    const body = JSON.parse(requestsTo(requests, secretsPath, "POST")[0].body ?? "{}");
    expect(body).toMatchObject({ slug: "new-token", purpose: "ci uploads" });
    expect(body.value).toBe("hunter2-do-not-render");

    // The one place the value may exist is that request body.
    await waitFor(() => expect(value.value).toBe(""));
    expect(document.body.textContent).not.toContain("hunter2-do-not-render");
    expect((screen.getByTestId("secret-slug") as HTMLInputElement).value).toBe("");
    expect((await screen.findByTestId("secret-created-note")).textContent).toContain(
      "no route can show it",
    );
    // And no GET that follows can be a read-back: there is no such route.
    expect(requests.some((request) => /\/secrets\/[^/]+\/versions$/.test(request.url))).toBe(false);
  });

  it("keeps a malformed slug from being posted at all", async () => {
    const { requests } = renderSecrets(projectFixture, [
      { path: secretsPath, method: "POST", status: 201, body: secretFixture },
    ]);
    fireEvent.change(await screen.findByTestId("secret-slug"), { target: { value: "Bad_Slug" } });
    fireEvent.change(screen.getByTestId("secret-value"), { target: { value: "v" } });
    expect(
      (screen.getByTestId("secret-slug") as HTMLInputElement).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByTestId<HTMLButtonElement>("secret-submit").disabled).toBe(true);
    expect(requestsTo(requests, secretsPath, "POST").length).toBe(0);
  });

  it("says a duplicate slug is a rotation, not a second reference", async () => {
    renderSecrets(projectFixture, [
      {
        path: secretsPath,
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/conflict",
          title: "Conflict",
          status: 409,
          detail: "slug exists",
        },
      },
    ]);
    fireEvent.change(await screen.findByTestId("secret-slug"), {
      target: { value: secretFixture.slug },
    });
    fireEvent.change(screen.getByTestId("secret-value"), { target: { value: "v" } });
    fireEvent.click(screen.getByTestId("secret-submit"));
    const error = await screen.findByTestId("secret-create-error");
    expect(error.textContent).toContain("rotate it instead of creating a second reference");
  });

  it("rotates by adding a version through a masked input that clears", async () => {
    const versionsPath = `${secretsPath}/${secretId}/versions`;
    const { requests } = renderSecrets(projectFixture, [
      { path: versionsPath, method: "POST", status: 200, body: { secret_version: 4 } },
    ]);

    fireEvent.click(await screen.findByTestId(`secret-rotate-${secretFixture.slug}`));
    const rotateInput = screen.getByTestId(`secret-rotate-value-${secretFixture.slug}`);
    expect((rotateInput as HTMLInputElement).type).toBe("password");
    fireEvent.change(rotateInput, { target: { value: "rotated-value" } });
    fireEvent.click(screen.getByTestId(`secret-rotate-submit-${secretFixture.slug}`));

    await waitFor(() => expect(requestsTo(requests, versionsPath, "POST").length).toBe(1));
    expect(JSON.parse(requestsTo(requests, versionsPath, "POST")[0].body ?? "{}")).toEqual({
      value: "rotated-value",
    });
    // The rotate row closes and its input goes with it: the value has nowhere to
    // sit on screen after the version is added.
    await waitFor(() =>
      expect(screen.queryByTestId(`secret-rotate-value-${secretFixture.slug}`)).toBeNull(),
    );
    expect(document.body.textContent).not.toContain("rotated-value");
  });

  it("revokes with the version-0 semantics named on the button's target", async () => {
    const revokePath = `${secretsPath}/${secretId}:revoke`;
    const { requests } = renderSecrets(projectFixture, [
      { path: revokePath, method: "POST", body: revokedSecretFixture },
    ]);
    fireEvent.click(await screen.findByTestId(`secret-revoke-${secretFixture.slug}`));
    await waitFor(() => expect(requestsTo(requests, revokePath, "POST").length).toBe(1));
  });

  it("flips the audit policy explicitly rather than silently", async () => {
    const putPath = `${secretsPath}/${secretId}`;
    const { requests } = renderSecrets(projectFixture, [
      {
        path: putPath,
        method: "PUT",
        body: { ...secretFixture, audit_policy: "materialization_and_access" },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`secret-audit-${secretFixture.slug}`));
    await waitFor(() => expect(requestsTo(requests, putPath, "PUT").length).toBe(1));
    expect(JSON.parse(requestsTo(requests, putPath, "PUT")[0].body ?? "{}")).toMatchObject({
      audit_policy: "materialization_and_access",
      allowed_agent_profile_ids: [claudeProfile.id],
    });
  });

  it("gives a viewer no write affordance at all, and says why", async () => {
    renderSecrets({ ...projectFixture, my_role: "viewer" });
    await screen.findByTestId("secret-list");
    expect(screen.queryByTestId("secret-create-form")).toBeNull();
    expect(screen.queryByTestId(`secret-revoke-${secretFixture.slug}`)).toBeNull();
    expect(screen.queryByTestId("secret-mount-form")).toBeNull();
    expect(document.body.textContent).toContain("Only project maintainers");
  });
});

describe("/manage/secrets — the `.env` mount form", () => {
  it("warns about the four `.env` contract rules before anything is typed", async () => {
    renderSecrets();
    await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    const lines = screen.getAllByTestId("mount-policy-line").map((line) => line.textContent);
    expect(lines.join(" ")).toContain("0600");
    expect(lines.join(" ")).toContain("excluded from git status");
    expect(lines.join(" ")).toContain("Removed when the unit ends");
    expect(screen.getByTestId("mount-trust-warning").textContent).toContain(
      "can copy it: scoping and egress control matter more",
    );
  });

  it("refuses an absolute path locally, with the reason under the field", async () => {
    const { requests } = renderSecrets();
    await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    fireEvent.change(screen.getByTestId("mount-secret"), { target: { value: secretId } });
    fireEvent.change(screen.getByTestId("mount-repo"), { target: { value: repositoryId } });
    fireEvent.change(screen.getByTestId("mount-path"), { target: { value: "/tmp/.env" } });
    expect(
      (screen.getByTestId("mount-path") as HTMLInputElement).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByTestId<HTMLButtonElement>("mount-submit").disabled).toBe(true);
    expect(requestsTo(requests, mountsPath, "POST").length).toBe(0);
  });

  it("refuses traversal with `path not in workspace`", async () => {
    renderSecrets();
    await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    fireEvent.change(screen.getByTestId("mount-secret"), { target: { value: secretId } });
    fireEvent.change(screen.getByTestId("mount-repo"), { target: { value: repositoryId } });
    fireEvent.change(screen.getByTestId("mount-path"), { target: { value: "backend/../.env" } });
    expect(screen.getByTestId("mount-path").closest("div")?.textContent).toContain(
      "path not in workspace",
    );
  });

  it("posts a relative target with the repository it lives under", async () => {
    const { requests } = renderSecrets(projectFixture, [
      { path: mountsPath, method: "POST", status: 201, body: secretMountFixture },
    ]);
    await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    fireEvent.change(screen.getByTestId("mount-secret"), { target: { value: secretId } });
    fireEvent.change(screen.getByTestId("mount-repo"), { target: { value: repositoryId } });
    fireEvent.change(screen.getByTestId("mount-path"), { target: { value: "ops/.env.local" } });
    fireEvent.change(screen.getByTestId("mount-lifecycle"), { target: { value: "workspace" } });
    fireEvent.click(screen.getByTestId("mount-submit"));

    await waitFor(() => expect(requestsTo(requests, mountsPath, "POST").length).toBe(1));
    expect(JSON.parse(requestsTo(requests, mountsPath, "POST")[0].body ?? "{}")).toMatchObject({
      secret_id: secretId,
      delivery_mode: "env_file",
      repository_id: repositoryId,
      relative_path: "ops/.env.local",
      lifecycle: "workspace",
      allow_tracked: false,
    });
    await waitFor(() =>
      expect((screen.getByTestId("mount-path") as HTMLInputElement).value).toBe(""),
    );
  });

  it("validates an env delivery by variable name, not by path", async () => {
    const { requests } = renderSecrets();
    await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    fireEvent.change(screen.getByTestId("mount-secret"), { target: { value: secretId } });
    fireEvent.change(screen.getByTestId("mount-delivery"), { target: { value: "env" } });
    fireEvent.change(screen.getByTestId("mount-env-name"), { target: { value: "DATABASE_URL=x" } });
    expect(screen.getByTestId<HTMLButtonElement>("mount-submit").disabled).toBe(true);

    fireEvent.change(screen.getByTestId("mount-env-name"), { target: { value: "DATABASE_URL" } });
    fireEvent.click(screen.getByTestId("mount-submit"));
    await waitFor(() => expect(requestsTo(requests, mountsPath, "POST").length).toBe(1));
    expect(JSON.parse(requestsTo(requests, mountsPath, "POST")[0].body ?? "{}")).toMatchObject({
      env_name: "DATABASE_URL",
    });
  });

  it("names the lifecycle rule on the row rather than paraphrasing it", async () => {
    renderSecrets();
    await screen.findByTestId(`secret-row-${secretFixture.slug}`);
    const row = await screen.findByTestId(`secret-mount-row-${secretFixture.slug}`);
    expect(row.textContent).toContain(secretMountFixture.relative_path ?? "");
    expect(row.textContent).toContain("removed when the turn ends");
    // `key` is a distinct declaration (one variable out of a multi-line value).
    expect(screen.getByTestId(`secret-mount-key-${secretMountFixture.id}`).textContent).toContain(
      "key DATABASE_URL",
    );
  });

  it("removes a mount", async () => {
    const deletePath = `${mountsPath}/${mountId}`;
    const { requests } = renderSecrets();
    await screen.findByTestId(`secret-mount-row-${secretFixture.slug}`);
    fireEvent.click(screen.getByTestId(`secret-mount-delete-${mountId}`));
    await waitFor(() => expect(requestsTo(requests, deletePath, "DELETE").length).toBe(1));
  });
});

describe("/manage/secrets — materialization audit", () => {
  it("fills the audit panel only once a secret is selected", async () => {
    renderSecrets(projectFixture, [
      {
        path: `${secretsPath}/${secretId}/materializations`,
        method: "GET",
        body: { materializations: [materialization] },
      },
    ]);

    expect((await screen.findByTestId("materialization-empty")).textContent).toContain(
      "Select a secret",
    );
    fireEvent.click(await screen.findByTestId(`secret-select-${secretFixture.slug}`));

    const row = await screen.findByTestId(`materialization-row-${materialization.id}`);
    // The target is a relative path, and the row says whether bytes are still there.
    expect(within(row).getByText("backend/.env.test.local")).toBeTruthy();
    expect(row.textContent).toContain("cleaned");
    expect(row.textContent).toContain("mode 0600");
  });

  it("raises a finding when a materialization reports no cleanup", async () => {
    renderSecrets(projectFixture, [
      {
        path: `${secretsPath}/${secretId}/materializations`,
        method: "GET",
        body: {
          materializations: [{ ...materialization, cleaned_at: null, cleaned_by: null }],
        },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`secret-select-${secretFixture.slug}`));
    const alert = await screen.findByTestId("materialization-uncleared");
    expect(alert.textContent).toContain("still report no cleanup");
  });

  it("says a secret that was never materialized was never materialized", async () => {
    renderSecrets(projectFixture, [
      {
        path: `${secretsPath}/${secretId}/materializations`,
        method: "GET",
        body: { materializations: [] },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`secret-select-${secretFixture.slug}`));
    expect((await screen.findByTestId("materialization-list-empty")).textContent).toContain(
      "Never materialized",
    );
  });
});
