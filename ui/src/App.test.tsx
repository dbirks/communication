import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { setCsrfToken } from "./api/client";
import { renderApp } from "./test/render";
import { meFixture, mockFetch, projectFixture, requestsTo } from "./test/fakes";
import type { RouteStub } from "./test/fakes";

vi.mock("./pages/Studio", () => ({ default: () => <div data-testid="studio-page" /> }));

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
    // The signed-out gate carries the deep link as return_to before any legacy
    // redirect runs; after sign-in the legacy redirect lands on the canonical page.
    expect(signIn.getAttribute("href")).toBe("/auth/login?return_to=%2Fprojects%2Fp-1");
    expect(screen.queryByTestId("project-name")).toBeNull();
  });

  it("shows the signed-in user and the replica that answered", async () => {
    renderApp({ path: "/manage/runners", routes: projectRoutes, replica: "replica-b" });

    const badge = await screen.findByTestId("user-badge", undefined, { timeout: READ_MS });
    expect(badge.textContent).toContain("Ada Lovelace");
    // The About this server line (the replica moved off the sidebar footer)
    // holds the `X-Communication-Replica` header of the last response.
    await waitFor(
      () => expect(screen.getByTestId("replica-badge").textContent).toBe("replica: replica-b"),
      { timeout: READ_MS },
    );
  });

  it(
    "follows the replica header across a navigation between API replicas",
    async () => {
      // The load balancer round-robins, so a page opened after the index may
      // be answered by a different replica; the About line must show the latest.
      // The Preferences tab's own read answers from replica-a while the page is
      // up, and the post-navigation read (the Operations health line) answers
      // from replica-b — the mock resolves `replica` per request.
      renderApp({
        path: "/manage/projects",
        replica: "replica-a",
        routes: [
          me,
          { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
          {
            path: "/api/v1/me/preferences",
            body: {
              layout: {
                projects_mode: "tree",
                ask_placement: "sidebar",
                show_workflow_folders: true,
                expanded: {},
              },
              assistant: { trust_level: "ask_risky" },
              updated_at: null,
            },
          },
          {
            path: "/api/v1/system/health",
            body: { status: "ok", replica: "replica-a", version: "0.1.0-m1" },
            replica: "replica-b",
          },
          {
            path: "/api/v1/system/readiness",
            body: { status: "ready", schema_version: 1, expected_schema_version: 1 },
            replica: "replica-b",
          },
          { path: "/api/v1/workers", body: { items: [] }, replica: "replica-b" },
          {
            path: "/api/v1/system/scheduler",
            body: {
              workers: [],
              attempts_by_status: { queued: 0, leased: 0 },
              oldest_queued_age_seconds: 0,
              lease_expirations: [],
            },
            replica: "replica-b",
          },
          { path: "/api/v1/system/sandbox", body: { workers: [] }, replica: "replica-b" },
          {
            path: "/api/v1/system/overview",
            body: {
              server: {
                version: "0.1.0-m1",
                commit: "",
                replica: "replica-b",
                schema_version: 1,
                started_at: "2026-11-11T00:00:00Z",
              },
              identity: { provider: "oidc", issuer_host: "idp.example", dev_login: false },
              storage: { artifact_backend: "local", preview_host: "" },
              models: [],
              secrets: { projects: 0, secrets: 0, mounts: 0 },
              workers: { online: 0, offline: 0, stale_after_seconds: 3600 },
            },
            replica: "replica-b",
          },
        ],
      });

      // Manage → Projects is answered by replica-a. Navigate to Runners: its
      // own health read answers from a different replica, and the replica line
      // there shows the latest one.
      fireEvent.click(
        await screen.findByTestId("manage-nav-runners", undefined, { timeout: READ_MS }),
      );
      await waitFor(() => expect(screen.getByTestId("ops-health-line")).toBeTruthy(), {
        timeout: READ_MS,
      });
      await waitFor(
        () => expect(screen.getByTestId("replica-badge").textContent).toBe("replica: replica-b"),
        { timeout: READ_MS },
      );
    },
    READ_MS * 3,
  );

  it(
    "signs out through POST /auth/logout and lands on the login page",
    async () => {
      const { requests } = renderApp({
        path: "/",
        routes: [...projectRoutes, { path: "/auth/logout", method: "POST", status: 204 }],
      });

      // The sign-out lives in the footer's user menu; open the menu first.
      const userMenu = await screen.findByTestId("user-menu", undefined, { timeout: READ_MS });
      fireEvent.click(userMenu);
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
      path: "/manage/runners",
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
    expect(screen.getByText(/No workers have registered\./)).toBeTruthy();
  });

  it("renders registered workers with their status as text", async () => {
    renderApp({
      path: "/manage/runners",
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
      path: "/manage/runners",
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

/**
 * Catch up's two deep routes (design 7b/8b, ADR-0078). The piece page lives
 * inside the shell like every other page; the tour player deliberately does
 * NOT — it owns the viewport, so no sidebar mounts with it, the same placement
 * the sign-in screen has. `/catch-up/tour` is declared before `/catch-up/:workId`
 * so a tour URL is never read as a piece id.
 */
describe("catch-up routes", () => {
  const workId = "01987a90-0000-7000-8000-111111111111";
  const itemRoutes: RouteStub[] = [
    me,
    { path: "/api/v1/catch-up/items", body: { items: [], total_unseen: 0 } },
    {
      path: "/api/v1/catch-up/tour",
      body: { stops: [], total_unseen_stops: 0, more_available: false, minutes_total: 0 },
    },
  ];

  it("mounts one piece of work at /catch-up/:workId inside the shell", async () => {
    renderApp({
      path: `/catch-up/${workId}`,
      routes: [
        ...itemRoutes,
        {
          path: `/api/v1/catch-up/items/${workId}`,
          body: {
            id: workId,
            project: { id: "p1", name: "payments", color: "#6a4bc4" },
            title: "Refund duplicates on checkout",
            refs: {},
            seen_by: [],
            latest: { version: 1, stops: [], created_at: "2026-11-08T10:00:00Z" },
            history: [],
            you_saw_version: 1,
          },
        },
      ],
    });

    await screen.findByTestId("catchup-item", undefined, { timeout: READ_MS });
    await waitFor(
      () =>
        expect(screen.getByTestId("catchup-item").textContent).toContain(
          "Refund duplicates on checkout",
        ),
      { timeout: READ_MS },
    );
    // Inside the shell: the column that carries the projects is on screen.
    expect(screen.getByTestId("project-rail")).toBeTruthy();
    expect(screen.getByTestId("top-bar")).toBeTruthy();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("plays the tour at /catch-up/tour with no sidebar, not as a piece id", async () => {
    renderApp({ path: "/catch-up/tour", routes: itemRoutes });

    const player = await screen.findByTestId("tour-player", undefined, { timeout: READ_MS });
    expect(player.textContent).toContain("Catch-up tour");
    // Full screen: the shell's sidebar does not mount beside it.
    expect(screen.queryByTestId("sidebar")).toBeNull();
    // And the URL was never taken as `/catch-up/:workId` — the piece page's own
    // handle is absent.
    expect(screen.queryByTestId("catchup-item")).toBeNull();
  });

  it("sends a signed-out visitor from the tour to the sign-in screen", async () => {
    renderApp({ path: "/catch-up/tour", routes: [unauthenticated] });
    await screen.findByRole("heading", { name: "Sign in" }, { timeout: READ_MS });
  });
});

describe("unknown routes", () => {
  it("sends a signed-out visitor from any deep link to the sign-in screen", async () => {
    renderApp({ path: "/does-not-exist", routes: [unauthenticated] });
    await screen.findByRole("heading", { name: "Sign in" });
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

describe("redesign routes", () => {
  it.each([
    ["/", "home-all"],
    ["/chats", "chats"],
    ["/chats/c-1", "chats"],
    ["/p/p-1/chats", "chats"],
    ["/p/p-1/chats/c-1", "chats"],
    ["/factory", "factory-index"],
    ["/p/p-1/factory", "factory-index"],
    ["/factory/pl-1", "studio-page"],
    ["/p/p-1/factory/pl-1", "studio-page"],
    ["/manage/projects", "manage"],
  ])("mounts %s in the shell", async (path, page) => {
    renderAt(path);
    expect(await screen.findByTestId(page, undefined, { timeout: READ_MS })).toBeTruthy();
    expect(screen.getByTestId("project-rail")).toBeTruthy();
    expect(screen.getByTestId("top-bar")).toBeTruthy();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });
});

describe("legacy route redirects", () => {
  const REDIRECTS: [string, string][] = [
    ["/catch-up", "/"],
    ["/inbox", "/"],
    ["/board", "/"],
    ["/threads", "/chats"],
    ["/threads/c-1", "/chats/c-1"],
    ["/p/p-1/threads", "/p/p-1/chats"],
    ["/p/p-1/threads/c-1", "/p/p-1/chats/c-1"],
    ["/p/p-1/conversations", "/p/p-1/chats"],
    ["/p/p-1/conversations/c-1", "/p/p-1/chats/c-1"],
    ["/projects/p-1/conversations", "/p/p-1/chats"],
    ["/projects/p-1/conversations/c-1", "/p/p-1/chats/c-1"],
    ["/workflows", "/factory"],
    ["/library", "/factory"],
    ["/workflows/steps", "/manage/agents?tab=steps"],
    ["/steps", "/manage/agents?tab=steps"],
    ["/workflows/steps/s-1", "/manage/agents?tab=steps&item=s-1"],
    ["/steps/s-1", "/manage/agents?tab=steps&item=s-1"],
    ["/workflows/collections", "/manage/agents?tab=skills"],
    ["/workflows/collections/c-1", "/manage/agents?tab=skills&item=c-1"],
    ["/workflows/pl-1", "/factory/pl-1"],
    ["/library/pl-1", "/factory/pl-1"],
    ["/workflows/pl-1/yaml", "/factory/pl-1?panel=yaml"],
    ["/workflows/pl-1/used-in", "/factory/pl-1?panel=used-in"],
    ["/workflows/pl-1/history", "/factory/pl-1?panel=versions"],
    ["/workflows/pl-1/drafts/d-1", "/factory/pl-1?draft=d-1"],
    ["/library/pl-1/drafts/d-1", "/factory/pl-1?draft=d-1"],
    ["/profiles", "/manage/agents"],
    ["/agents", "/manage/agents"],
    ["/profiles/ap-1", "/manage/agents/ap-1"],
    ["/agents/ap-1", "/manage/agents/ap-1"],
    ["/settings", "/manage/agents"],
    ["/settings/assistant", "/manage/agents?tab=assistant"],
    ["/settings/accounts", "/manage/agents"],
    ["/settings/operations", "/manage/runners"],
    ["/ops", "/manage/runners"],
    ["/projects", "/manage/projects"],
    ["/projects/p-1", "/p/p-1"],
    ["/projects/p-1/artifacts", "/p/p-1/artifacts"],
    ["/projects/p-1/runs", "/p/p-1/factory"],
    ["/projects/p-1/pipelines", "/p/p-1/factory"],
    ["/projects/p-1/settings", "/manage/projects/p-1"],
    ["/projects/p-1/runs/r-1", "/runs/r-1"],
    ["/p/p-1/runs", "/p/p-1/factory"],
    ["/p/p-1/workflows", "/p/p-1/factory"],
    ["/p/p-1/pipelines", "/p/p-1/factory"],
    ["/p/p-1/settings", "/manage/projects/p-1"],
    ["/p/p-1/members", "/manage/people?project=p-1"],
  ];

  it.each(REDIRECTS)("redirects %s to %s and preserves query and hash", async (from, to) => {
    const probe = renderAt(`${from}?x=1#section`);
    const separator = to.includes("?") ? "&" : "?";
    await waitFor(() => expect(probe.textContent).toBe(`${to}${separator}x=1#section`), {
      timeout: 5_000,
    });
  });

  it("keeps a new canonical route in place", async () => {
    const probe = renderAt("/factory?x=1");
    expect(probe.textContent).toBe("/factory?x=1");
  });

  it("serves the Steps tab at its new address", async () => {
    const probe = renderAt("/manage/agents?tab=steps&item=01j-tpl-build");
    expect(probe.textContent).toBe("/manage/agents?tab=steps&item=01j-tpl-build");
  });

  it("mounts the repository page at /p/:projectId/:repo instead of redirecting", async () => {
    const probe = renderAt("/p/p-1/widgets");
    await waitFor(() => expect(probe.textContent).toBe("/p/p-1/widgets"), { timeout: 5_000 });
  });
});
