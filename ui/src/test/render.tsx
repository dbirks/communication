import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach } from "vitest";
import App from "../App";
import { setCsrfToken } from "../api/client";
import { resetReplicaName } from "../api/replica";
import { mockFetch, type FetchMock, type RecordedRequest, type RouteStub } from "./fakes";

export interface RenderOptions {
  path?: string;
  routes?: RouteStub[];
  /** Default `X-Communication-Replica` header for stubs without one. */
  replica?: string;
}

export interface RenderResult {
  fetchMock: FetchMock;
  requests: RecordedRequest[];
  queryClient: QueryClient;
}

/** Render the app at `path` with a mocked API and a throwaway query cache. */
export function renderApp({ path = "/", routes = [], replica }: RenderOptions = {}): RenderResult {
  setCsrfToken(null);
  resetReplicaName();
  const { fetchMock, requests } = mockFetch(routes, { replica });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests, queryClient };
}

afterEach(cleanup);
