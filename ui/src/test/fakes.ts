/**
 * Test doubles: a fetch mock driven by a small route table, and a fake
 * `EventSource` the tests can push frames into. No network access in tests.
 */
import { vi } from "vitest";
import type { EventEnvelope, Me, Project } from "../api/types";

export type FetchMock = ReturnType<typeof vi.fn>;

export interface RouteStub {
  /** HTTP method to match (default: any method). */
  method?: string;
  /** URL to match, ignoring any query string. */
  path: string;
  status?: number;
  /** JSON body; omit for an empty 204 response. */
  body?: unknown;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Shorthand for the `X-Communication-Replica` response header. */
  replica?: string;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

const REPLICA_HEADER = "x-communication-replica";

function pathOf(input: unknown): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
  return raw.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
}

export interface MockFetchOptions {
  /** Default `X-Communication-Replica` value for stubs that do not set one. */
  replica?: string;
}

/** Install a `fetch` mock answering from `routes` and return the recorded requests. */
export function mockFetch(
  routes: RouteStub[],
  options: MockFetchOptions = {},
): { fetchMock: FetchMock; requests: RecordedRequest[] } {
  const defaultReplica = options.replica ?? "replica-a";
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, headers, body });

    const stub = routes.find(
      (candidate) => candidate.path === url && (!candidate.method || candidate.method === method),
    );
    if (!stub) {
      return new Response(
        JSON.stringify({
          type: "https://communication.dev/errors/not-found",
          title: "Not found",
          status: 404,
          detail: `no test stub for ${method} ${url}`,
        }),
        {
          status: 404,
          headers: { "content-type": "application/problem+json", [REPLICA_HEADER]: defaultReplica },
        },
      );
    }

    const status = stub.status ?? 200;
    const problem = status >= 400;
    const headersOut: Record<string, string> = {
      "content-type": problem ? "application/problem+json" : "application/json",
      [REPLICA_HEADER]: stub.replica ?? defaultReplica,
      ...stub.headers,
    };
    return new Response(stub.body === undefined ? null : JSON.stringify(stub.body), {
      status,
      headers: headersOut,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

export function requestsTo(
  requests: RecordedRequest[],
  url: string,
  method = "GET",
): RecordedRequest[] {
  return requests.filter((request) => request.url === url && request.method === method);
}

/** Minimal EventSource: tests call `open()` and `emit()` by hand. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static last(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error("no EventSource has been constructed");
    return source;
  }

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  withCredentials = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    return !event.defaultPrevented;
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({ type: "open" } as Event);
  }

  fail(): void {
    this.onerror?.({ type: "error" } as Event);
  }

  /** Deliver an SSE frame: `event: <type>` + `data: <envelope JSON>`. */
  emit(envelope: EventEnvelope): void {
    const event = new MessageEvent<string>(envelope.type, {
      data: JSON.stringify(envelope),
      lastEventId: String(envelope.global_seq),
    });
    for (const listener of this.listeners.get(envelope.type) ?? []) listener(event);
  }
}

/** Fixtures using the generated OpenAPI types. */
export const meFixture: Me = {
  id: "01987a61-2345-7000-8000-abcdef012345",
  display_name: "Ada Lovelace",
  email: "ada@example.com",
  is_org_admin: false,
  organization: {
    id: "01987a6b-9c1d-7e5f-8a0b-1c2d3e4f5a60",
    slug: "default",
    name: "Default organization",
  },
  csrf_token: "csrf-token-value",
};

export const projectFixture: Project = {
  id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80",
  slug: "widgets",
  name: "Widgets",
  description: "Widget incubator",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "maintainer",
};

export function envelopeFixture(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "01987a6e-2f3a-7c1d-9a2e-4f6b8c0d1e2f",
    global_seq: 152003,
    type: "repository.added",
    schema_version: 1,
    occurred_at: "2026-10-14T18:00:00Z",
    organization_id: "01987a6b-9c1d-7e5f-8a0b-1c2d3e4f5a60",
    project_id: projectFixture.id,
    conversation_id: null,
    actor: { kind: "human", id: "01987a61-2345-7000-8000-abcdef012345" },
    payload: {
      repository_id: "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0",
      name: "communication",
      git_url: "https://github.com/example/communication.git",
      default_branch: "main",
    },
    ...overrides,
  };
}
