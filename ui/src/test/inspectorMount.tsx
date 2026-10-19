/**
 * Mounts a single run-page component at its real route
 * (`/projects/:projectId/runs/:runId`) outside the app Shell. The run
 * route now renders the Run Workbench; the pre-overhaul page's tests keep
 * asserting the inspector itself by mounting it on the same route shape,
 * so `useParams`/`useSearchParams` behave exactly as in the app.
 */
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { setCsrfToken } from "../api/client";
import { resetReplicaName } from "../api/replica";
import { mockFetch, type FetchMock, type RecordedRequest, type RouteStub } from "./fakes";

export interface InspectorMountOptions {
  path: string;
  routes?: RouteStub[];
  /** The page to host on the run route; defaults to the inspector. */
  element: ReactElement;
  replica?: string;
}

export interface InspectorMountResult {
  fetchMock: FetchMock;
  requests: RecordedRequest[];
  queryClient: QueryClient;
}

export function mountRunPage({
  path,
  routes = [],
  element,
  replica,
}: InspectorMountOptions): InspectorMountResult {
  setCsrfToken(null);
  resetReplicaName();
  const { fetchMock, requests } = mockFetch(routes, { replica });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:projectId/runs/:runId" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests, queryClient };
}

// render.tsx registers the same for the full-app route; keep the direct
// mount clean between tests as well.
afterEach(cleanup);
