/**
 * "GitHub access" on a repository (ADR-0061) against the fake fetch: the two
 * honest states of the line under the git URL, the maintainer-only `change`
 * dialog, the choice list the server would accept (only an un-revoked
 * `integration_broker` secret — an `env`/`env_file` one is a `422`), the single
 * PATCH in both directions, and the dead end that points at the project's
 * Secrets settings instead of building secret creation here.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubAccess } from "./GitHubAccess";
import type { Project, Repository, Secret } from "../../api/types";
import {
  mockFetch,
  projectFixture,
  requestsTo,
  secretFixture,
  type RouteStub,
} from "../../test/fakes";

const repository: Repository = {
  id: "01987b22-0002-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  name: "storefront",
  git_url: "https://github.com/northwind/storefront.git",
  default_branch: "main",
  created_at: "2026-07-30T09:00:00Z",
  credential: "none",
  credential_secret_id: null,
};

const brokerSecret: Secret = {
  ...secretFixture,
  id: "01987a77-0001-7000-8000-abcdef012345",
  slug: "github-repo-token",
  purpose: "github repo read",
  delivery_mode: "integration_broker",
  allowed_agent_profile_ids: [],
  revoked_at: null,
};

const routes = (overrides: RouteStub[] = []): RouteStub[] => [
  ...overrides,
  {
    path: `/api/v1/projects/${projectFixture.id}/secrets`,
    method: "GET",
    body: { secrets: [secretFixture, brokerSecret] },
  },
];

function mount(
  project: Project = projectFixture,
  repo: Repository = repository,
  overrides: RouteStub[] = [],
) {
  const { requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GitHubAccess project={project} repository={repo} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

afterEach(cleanup);

describe("GitHubAccess — the line under the git URL", () => {
  it("says public · no credential when nothing is attached", async () => {
    mount();
    expect((await screen.findByTestId("repo-github-access-state")).textContent).toBe(
      "public · no credential",
    );
  });

  it("names the attached credential by its slug, read from the secret list", async () => {
    mount(projectFixture, {
      ...repository,
      credential: "configured",
      credential_secret_id: brokerSecret.id,
    });
    // The name arrives with the secret list, so the line waits for that read.
    await waitFor(() =>
      expect(screen.getByTestId("repo-github-access-state").textContent).toBe(
        "credential · github-repo-token",
      ),
    );
  });

  it("says unavailable when the attached id is not a secret this project lists", async () => {
    mount(projectFixture, {
      ...repository,
      credential: "configured",
      credential_secret_id: "01987a77-9999-7000-8000-abcdef012345",
    });
    await waitFor(() =>
      expect(screen.getByTestId("repo-github-access-state").textContent).toBe(
        "credential · secret unavailable",
      ),
    );
  });

  it("keeps `change` from a viewer", async () => {
    mount({ ...projectFixture, my_role: "viewer" });
    await screen.findByTestId("repo-github-access-state");
    expect(screen.queryByTestId("repo-github-access-change")).toBeNull();
  });
});

describe("GitHubAccess — the change dialog", () => {
  it("offers None (public repo) and every un-revoked broker secret, and nothing else", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("repo-github-access-change"));
    const select = (await screen.findByTestId("github-access-select")) as HTMLSelectElement;
    const options = [...select.options].map((option) => option.textContent);
    expect(options).toContain("None (public repo)");
    expect(options).toContain("github-repo-token");
    // An env_file secret is a `422 invalid_credential_secret`, so it is not a
    // choice here; neither is a revoked broker secret.
    expect(options).not.toContain(secretFixture.slug);
    expect(select.value).toBe("");
  });

  it("preselects the credential the repository already carries", async () => {
    mount(projectFixture, {
      ...repository,
      credential: "configured",
      credential_secret_id: brokerSecret.id,
    });
    fireEvent.click(await screen.findByTestId("repo-github-access-change"));
    const select = (await screen.findByTestId("github-access-select")) as HTMLSelectElement;
    expect(select.value).toBe(brokerSecret.id);
    // Nothing picked, nothing patched.
    expect((screen.getByTestId("github-access-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("patches the picked broker secret as the credential", async () => {
    const { requests } = mount(projectFixture, repository, [
      {
        path: `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
        method: "PATCH",
        body: {
          ...repository,
          credential: "configured",
          credential_secret_id: brokerSecret.id,
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("repo-github-access-change"));
    const select = (await screen.findByTestId("github-access-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: brokerSecret.id } });
    fireEvent.click(screen.getByTestId("github-access-save"));

    await waitFor(() =>
      expect(
        requestsTo(
          requests,
          `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
          "PATCH",
        ),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(
          requests,
          `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
          "PATCH",
        )[0].body!,
      ),
    ).toEqual({ credential_secret_id: brokerSecret.id });
    await waitFor(() => expect(screen.queryByTestId("github-access-dialog")).toBeNull());
  });

  it("clears back to anonymous with None (public repo)", async () => {
    const { requests } = mount(
      projectFixture,
      { ...repository, credential: "configured", credential_secret_id: brokerSecret.id },
      [
        {
          path: `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
          method: "PATCH",
          body: { ...repository, credential: "none", credential_secret_id: null },
        },
      ],
    );

    fireEvent.click(await screen.findByTestId("repo-github-access-change"));
    const select = (await screen.findByTestId("github-access-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("github-access-save"));

    await waitFor(() =>
      expect(
        requestsTo(
          requests,
          `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
          "PATCH",
        ),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(
          requests,
          `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
          "PATCH",
        )[0].body!,
      ),
    ).toEqual({ credential_secret_id: null });
  });

  it("keeps the server's 422 invalid_credential_secret on screen", async () => {
    mount(projectFixture, repository, [
      {
        path: `/api/v1/projects/${projectFixture.id}/repos/${repository.id}`,
        method: "PATCH",
        status: 422,
        body: {
          type: "https://communication.dev/errors/invalid_credential_secret",
          title: "Invalid credential secret",
          status: 422,
          detail:
            "invalid_credential_secret: that secret is not an integration_broker of this project",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("repo-github-access-change"));
    const select = (await screen.findByTestId("github-access-select")) as HTMLSelectElement;
    // A secret this project lists can still be refused server-side (it went
    // revoked, or its scope is not the project's) — the `422` is the answer.
    fireEvent.change(select, { target: { value: brokerSecret.id } });
    fireEvent.click(screen.getByTestId("github-access-save"));

    const error = await screen.findByTestId("github-access-error");
    expect(error.textContent).toContain("invalid_credential_secret");
    expect(screen.getByTestId("github-access-dialog")).toBeTruthy();
  });

  it("says there is nothing to attach and points at the project's Secrets settings", async () => {
    mount(projectFixture, repository, [
      {
        path: `/api/v1/projects/${projectFixture.id}/secrets`,
        method: "GET",
        body: { secrets: [secretFixture] },
      },
    ]);

    fireEvent.click(await screen.findByTestId("repo-github-access-change"));
    expect(await screen.findByTestId("github-access-no-secrets")).toBeTruthy();
    expect(screen.queryByTestId("github-access-select")).toBeNull();
    const link = screen.getByTestId("github-access-settings-link");
    expect(link.getAttribute("href")).toBe(`/p/${projectFixture.id}/settings`);
    // Nothing to pick and nothing to clear: Save has no honest action.
    expect((screen.getByTestId("github-access-save") as HTMLButtonElement).disabled).toBe(true);
  });
});
