import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import App from "./App";
import { setCsrfToken } from "./api/client";
import { renderApp } from "./test/render";
import { meFixture, mockFetch, projectFixture, requestsTo } from "./test/fakes";
import type { RouteStub } from "./test/fakes";

const me: RouteStub = { path: "/api/v1/me", body: meFixture, replica: "replica-b" };
const unauthenticated: RouteStub = {
  path: "/api/v1/me",
  status: 401,
  body: {
    type: "https://communication.dev/errors/unauthenticated",
    title: "Unauthenticated",
    status: 401,
    detail: "No valid session cookie.",
  },
};

/**
 * Wait budget for a test that is waiting on a mocked request, not on the
 * machine's clock: `findBy*` waits 1000 ms by default, and that is a race
 * against CPU. Sign-out alone was measured at 150 ms idle and 1075 ms with the
 * runner oversubscribed ~2x (several vitest workers on one box), which is how
 * the sign-out test flakes in CI. Applied where a real boundary exists — a
 * `/api/v1` round trip through the fake fetch, or the navigation it answers —
 * and never as a retry.
 */
const READ_MS = 5_000;

const projectRoutes: RouteStub[] = [
  me,
  { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
  { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
  { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
  { path: `/api/v1/projects/${projectFixture.id}/members`, body: { items: [] } },
];

describe("auth", () => {
  it("sends an unauthenticated visitor to the login page with return_to", async () => {
    renderApp({ path: "/projects/p-1", routes: [unauthenticated] });

    await screen.findByRole("heading", { name: "Sign in" });
    const signIn = screen.getByTestId("sign-in");
    // The legacy path redirects first, so the return target is the canonical one.
    expect(signIn.getAttribute("href")).toBe("/auth/login?return_to=%2Fp%2Fp-1");
    expect(screen.queryByTestId("project-name")).toBeNull();
  });

  it("shows the signed-in user and the replica that answered", async () => {
    renderApp({ path: "/projects", routes: projectRoutes, replica: "replica-b" });

    const badge = await screen.findByTestId("user-badge");
    expect(badge.textContent).toContain("Ada Lovelace");
    // The badge holds the `X-Communication-Replica` header of the last response.
    await waitFor(() =>
      expect(screen.getByTestId("replica-badge").textContent).toBe("replica: replica-b"),
    );
  });

  it("follows the replica header across a navigation between API replicas", async () => {
    // The load balancer round-robins, so a project opened after the index may
    // be answered by a different replica; the badge must show the latest one.
    // The board and the project page read the same conversations endpoint, so
    // this stub answers from replica-a while the board is up and switches to
    // replica-b for the post-navigation reads (the mock resolves `replica` per
    // request).
    const conversationsStub: RouteStub = {
      path: `/api/v1/projects/${projectFixture.id}/conversations`,
      body: { items: [] },
    };
    renderApp({
      path: "/projects",
      replica: "replica-a",
      routes: [
        me,
        { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
        {
          path: `/api/v1/projects/${projectFixture.id}`,
          body: projectFixture,
          replica: "replica-b",
        },
        {
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: { items: [] },
          replica: "replica-b",
        },
        {
          path: `/api/v1/projects/${projectFixture.id}/members`,
          body: { items: [] },
          replica: "replica-b",
        },
        { path: "/api/v1/users", body: { items: [] }, replica: "replica-b" },
        { path: "/api/v1/agent-profiles", body: { items: [] }, replica: "replica-b" },
        conversationsStub,
        // M3 reads the project page also makes, from the same replica.
        {
          path: `/api/v1/projects/${projectFixture.id}/workspaces`,
          body: { workspaces: [] },
          replica: "replica-b",
        },
        {
          path: `/api/v1/projects/${projectFixture.id}/artifacts`,
          body: { artifacts: [] },
          replica: "replica-b",
        },
      ],
    });

    await screen.findByTestId("project-list");
    await waitFor(() =>
      expect(screen.getByTestId("replica-badge").textContent).toBe("replica: replica-a"),
    );

    conversationsStub.replica = "replica-b";
    fireEvent.click(screen.getByTestId("project-link-widgets"));
    await screen.findByTestId("project-name");
    await waitFor(() =>
      expect(screen.getByTestId("replica-badge").textContent).toBe("replica: replica-b"),
    );
  });

  it(
    "signs out through POST /auth/logout and lands on the login page",
    async () => {
      const { requests } = renderApp({
        path: "/",
        routes: [...projectRoutes, { path: "/auth/logout", method: "POST", status: 204 }],
      });

      // The button exists only once `/api/v1/me` has answered.
      const signOut = await screen.findByTestId("sign-out", undefined, { timeout: READ_MS });
      fireEvent.click(signOut);
      // ...and sign out navigates only after `POST /auth/logout` resolves, so the
      // login page is a second round trip away, not a render away.
      await screen.findByRole("heading", { name: "Sign in" }, { timeout: READ_MS });

      const [request] = requestsTo(requests, "/auth/logout", "POST");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
    },
    READ_MS * 3,
  );

  it("renders the login page for a signed-out visitor", async () => {
    renderApp({ path: "/login", routes: [unauthenticated] });

    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.getByTestId("sign-in").getAttribute("href")).toBe("/auth/login?return_to=%2F");
  });
});

describe("/ops", () => {
  it("shows health, readiness and the empty workers table", async () => {
    renderApp({
      path: "/ops",
      routes: [
        me,
        {
          path: "/api/v1/system/health",
          body: { status: "ok", replica: "replica-b", version: "0.1.0-m1" },
        },
        {
          path: "/api/v1/system/readiness",
          body: { status: "ready", schema_version: 1, expected_schema_version: 1 },
        },
        { path: "/api/v1/workers", body: { items: [] } },
      ],
    });

    expect((await screen.findByTestId("health-card")).textContent).toContain("status: ok");
    expect(screen.getByTestId("health-card").textContent).toContain("replica-b");
    expect(screen.getByTestId("readiness-card").textContent).toContain("status: ready");
    expect(screen.getByTestId("readiness-card").textContent).toContain("schema version");
    expect(screen.getByText("No workers registered")).toBeTruthy();
  });

  it("renders registered workers with their status as text", async () => {
    renderApp({
      path: "/ops",
      routes: [
        me,
        {
          path: "/api/v1/system/health",
          body: { status: "ok", replica: "replica-b", version: "0.1.0-m1" },
        },
        {
          path: "/api/v1/system/readiness",
          body: { status: "ready", schema_version: 1, expected_schema_version: 1 },
        },
        {
          path: "/api/v1/workers",
          body: {
            items: [
              {
                id: "01987a70-0000-7000-8000-000000000001",
                name: "worker-a",
                hostname: "lab-1",
                version: "0.1.0-m1",
                status: "online",
                started_at: "2026-10-14T17:00:00Z",
                last_heartbeat_at: "2026-10-14T18:00:00Z",
              },
            ],
          },
        },
      ],
    });

    const row = await screen.findByTestId("worker-row-worker-a");
    expect(row.textContent).toContain("status: online");
  });

  it("shows the readiness problem detail when a replica is not ready", async () => {
    renderApp({
      path: "/ops",
      routes: [
        me,
        {
          path: "/api/v1/system/health",
          body: { status: "ok", replica: "replica-b", version: "0.1.0-m1" },
        },
        {
          path: "/api/v1/system/readiness",
          status: 503,
          body: {
            type: "https://communication.dev/errors/not-ready",
            title: "Not ready",
            status: 503,
            detail: "schema version 0 is older than expected 1.",
          },
        },
        { path: "/api/v1/workers", body: { items: [] } },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("readiness-card").textContent).toContain("not ready");
    });
    expect(screen.getByTestId("readiness-card").textContent).toContain("older than expected");
  });
});

describe("unknown routes", () => {
  it("renders a not found page without requiring a session", async () => {
    renderApp({ path: "/does-not-exist", routes: [unauthenticated] });
    await screen.findByRole("heading", { name: "Not found" });
  });
});

/**
 * Redirect audit (contract C1): every legacy URL still resolves, on its
 * canonical path, with the query string and hash preserved. Each row mounts
 * the whole app in a MemoryRouter and reads the location the user actually
 * ends on — not the route table in isolation. Unstubbed page reads answer 404
 * in the background; the location itself must not move again.
 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="probe-location">{location.pathname + location.search + location.hash}</div>
  );
}

function renderAt(path: string) {
  setCsrfToken(null);
  mockFetch([{ path: "/api/v1/me", body: meFixture }]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByTestId("probe-location");
}

describe("legacy route redirects", () => {
  /** [legacy URL, final pathname + search + hash] */
  const REDIRECTS: [string, string][] = [
    ["/library", "/workflows"],
    ["/library?x=1", "/workflows?x=1"],
    ["/library/pl-1", "/workflows/pl-1"],
    ["/library/pl-1?draft=d-1", "/workflows/pl-1/drafts/d-1"],
    ["/library/pl-1/drafts/d-1", "/workflows/pl-1/drafts/d-1"],
    ["/agents", "/profiles"],
    ["/agents/ap-1", "/profiles/ap-1"],
    ["/projects/p-1", "/p/p-1"],
    ["/projects/p-1/runs", "/p/p-1/runs"],
    ["/projects/p-1/runs/r-1", "/runs/r-1"],
    [
      "/projects/p-1/runs/r-1?view=timeline&node=build&instance=n-1",
      "/runs/r-1?view=timeline&node=build&instance=n-1",
    ],
    ["/projects/p-1/pipelines", "/p/p-1/pipelines"],
    ["/projects/p-1/artifacts", "/p/p-1/artifacts"],
    ["/projects/p-1/conversations", "/p/p-1/conversations"],
    ["/projects/p-1/conversations/c-1", "/threads/c-1"],
    ["/projects/p-1/settings", "/p/p-1/settings"],
    ["/settings", "/settings/layout"],
  ];

  for (const [from, to] of REDIRECTS) {
    it(`resolves ${from} on ${to}`, async () => {
      const probe = renderAt(from);
      await waitFor(() => expect(probe.textContent).toBe(to), { timeout: 5_000 });
    });
  }

  it("keeps a new canonical route in place", async () => {
    const probe = renderAt("/inbox?tab=attention");
    expect(probe.textContent).toBe("/inbox?tab=attention");
  });

  it("sends /p/:projectId/:repo to the project overview in phase 1", async () => {
    const probe = renderAt("/p/p-1/widgets");
    await waitFor(() => expect(probe.textContent).toBe("/p/p-1"), { timeout: 5_000 });
  });
});
