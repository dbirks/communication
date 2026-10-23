/**
 * Test doubles: a fetch mock driven by a small route table, and a fake
 * `EventSource` the tests can push frames into. No network access in tests.
 */
import { vi } from "vitest";
import type {
  AgentProfile,
  Artifact,
  Conversation,
  ConversationSummary,
  EventEnvelope,
  Me,
  PermissionRequest,
  Project,
  Secret,
  SecretMount,
  SystemSandbox,
  TurnSandbox,
  Workspace,
} from "../api/types";

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

/* -------------------------------------------------------------- M2 fixtures */

export const otherUserId = "01987a62-2345-7000-8000-abcdef012345";
export const conversationId = "01987a70-1111-7000-8000-abcdef012345";
export const turnId = "01987a73-4444-7000-8000-abcdef012345";
export const workerId = "01987a74-5555-7000-8000-abcdef012345";
export const workspaceId = "01987a75-6666-7000-8000-abcdef012345";
export const secretId = "01987a76-7777-7000-8000-abcdef012345";
export const mountId = "01987a77-8888-7000-8000-abcdef012345";
export const artifactId = "01987a78-9999-7000-8000-abcdef012345";
export const repositoryId = "01987a79-aaaa-7000-8000-abcdef012345";

export const claudeProfile: AgentProfile = {
  id: "01987a71-2222-7000-8000-abcdef012345",
  name: "Claude Code",
  launcher_id: "claude",
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
};

export const codexProfile: AgentProfile = {
  id: "01987a71-2222-7000-8000-abcdef0123ff",
  name: "Codex",
  launcher_id: "codex",
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
};

/** A conversation the signed-in user (`meFixture`) controls. */
export const conversationFixture: Conversation = {
  id: conversationId,
  project_id: projectFixture.id,
  agent_profile_id: claudeProfile.id,
  agent_profile_name: claudeProfile.name,
  launcher_id: claudeProfile.launcher_id,
  title: "Refactor billing",
  status: "active",
  created_by: meFixture.id,
  created_by_display_name: meFixture.display_name,
  created_at: "2026-10-14T18:00:00Z",
  updated_at: "2026-10-14T18:05:00Z",
  control: {
    kind: "human",
    user_id: meFixture.id,
    display_name: meFixture.display_name,
    previous_user_id: null,
    version: 1,
  },
  origin: "manual",
  run_link: null,
  linked_runs: [],
  pending_permissions: [],
};

/** The same conversation controlled by somebody else. */
export const controlledByOther: Conversation = {
  ...conversationFixture,
  control: {
    kind: "human",
    user_id: otherUserId,
    display_name: "Dana Observer",
    previous_user_id: meFixture.id,
    version: 7,
  },
};

export const conversationSummaryFixture: ConversationSummary = {
  id: conversationId,
  project_id: projectFixture.id,
  agent_profile_id: claudeProfile.id,
  title: "Refactor billing",
  status: "active",
  created_by: meFixture.id,
  created_by_display_name: meFixture.display_name,
  created_at: "2026-10-14T18:00:00Z",
  updated_at: "2026-10-14T18:05:00Z",
  control: conversationFixture.control,
  has_active_turn: false,
  agent_connected: true,
  origin: "manual",
  run_link: null,
};

export const permissionRequestFixture: PermissionRequest = {
  id: "01987a72-3333-7000-8000-abcdef012345",
  conversation_id: conversationId,
  turn_id: turnId,
  status: "pending",
  tool_title: "Write to internal/api/projects.go",
  tool_kind: "edit",
  tool_call_id: "toolu_01",
  options: [
    { option_id: "allow_once", label: "Allow once", kind: "allow_once" },
    { option_id: "reject_once", label: "Reject", kind: "reject_once" },
  ],
  requested_at: "2026-10-14T18:02:00Z",
};

/**
 * A conversation-scoped journal frame, payload left to the caller.
 */
let conversationSeq = 4000;
export function conversationEvent(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  // Unique per frame: `event_id` keys the transcript list, and `global_seq` is
  // the dedupe cursor, so a fixture that reuses either would hide real bugs.
  const seq = typeof overrides.global_seq === "number" ? overrides.global_seq : ++conversationSeq;
  return envelopeFixture({
    event_id: `01987a7e-2f3a-7c1d-9a2e-${String(seq).padStart(12, "0")}`,
    type,
    global_seq: seq,
    conversation_id: conversationId,
    project_id: projectFixture.id,
    payload: { conversation_id: conversationId, turn_id: turnId, ...payload },
    ...overrides,
  });
}

/* -------------------------------------------------------------- M3 fixtures */

export const secretFixture: Secret = {
  id: secretId,
  slug: "test-database-url",
  scope: "project",
  purpose: "integration test database",
  delivery_mode: "env_file",
  current_version: 3,
  allowed_agent_profile_ids: [claudeProfile.id],
  audit_policy: "materialization",
  created_at: "2026-10-14T18:00:00Z",
};

export const revokedSecretFixture: Secret = {
  ...secretFixture,
  id: "01987a76-7778-7000-8000-abcdef012345",
  slug: "legacy-token",
  delivery_mode: "env",
  allowed_agent_profile_ids: [],
  revoked_at: "2026-10-15T09:00:00Z",
};

export const secretMountFixture: SecretMount = {
  id: mountId,
  project_id: projectFixture.id,
  secret_id: secretId,
  secret_slug: secretFixture.slug,
  delivery_mode: "env_file",
  repository_id: repositoryId,
  relative_path: "backend/.env.test.local",
  lifecycle: "turn",
  allow_tracked: false,
  created_at: "2026-10-14T18:10:00Z",
};

export const workspaceFixture: Workspace = {
  id: workspaceId,
  project_id: projectFixture.id,
  scope_kind: "conversation",
  conversation_id: conversationId,
  worker_id: workerId,
  volume_id: `sha256:${"7c1f".repeat(16)}`,
  workspace_mode: "worktree",
  state: "ready",
  created_at: "2026-10-14T18:12:00Z",
  ready_at: "2026-10-14T18:13:00Z",
  repos: [
    {
      repository_id: repositoryId,
      name: "backend",
      run_ref: `${conversationId}/backend`,
      base_commit: "a91f2c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8090",
      head_commit: null,
      workspace_mode: "worktree",
      modified_paths: ["internal/api/secrets.go", "internal/api/secrets_test.go"],
      excluded_paths: ["backend/.env.test.local"],
    },
  ],
};

export const turnSandboxFixture: TurnSandbox = {
  turn_id: turnId,
  workspace_id: workspaceId,
  worker_id: workerId,
  stage: "none",
  reason: null,
  policy_digest: `sha256:${"2b71".repeat(16)}`,
  backend: "nono",
  backend_version: "0.80.0",
  enforcement: "required",
  verified: true,
  af_unix_mediation: "pathname",
  network_enforced: false,
  child_started: true,
  grants: [
    { role: "workspace_repo", access: "rw" },
    { role: "mirror_read", access: "ro" },
  ],
  commit_granted: true,
  denied_what: ["mirror_run_refs:rw denied for another scope"],
};

export const systemSandboxFixture: SystemSandbox = {
  workers: [
    {
      worker_id: workerId,
      backend: "nono",
      backend_version: "0.80.0",
      enforcement: "required",
      verified: true,
      volumes: [{ root_kind: "workspaces", volume_id: `sha256:${"7c1f".repeat(16)}` }],
      notes: [],
    },
    {
      worker_id: "01987a74-5556-7000-8000-abcdef012345",
      backend: "none",
      backend_version: null,
      enforcement: "permissive-dev",
      verified: false,
      volumes: [],
      notes: ["landlock: unavailable on this kernel"],
    },
  ],
  pinned_backend_version: "0.80.0",
  policy_digest: `sha256:${"2b71".repeat(16)}`,
};

export const artifactFixture: Artifact = {
  id: artifactId,
  project_id: projectFixture.id,
  conversation_id: conversationId,
  turn_id: turnId,
  worker_id: workerId,
  name: "report.html",
  kind: "html",
  media_type: "text/html",
  sha256: "7c1f".repeat(16),
  size_bytes: 86016,
  sensitivity: "internal",
  state: "ready",
  redaction_count: 0,
  created_by: "worker",
  created_at: "2026-10-14T18:19:00Z",
  ready_at: "2026-10-14T18:19:00Z",
  preview_url: "http://preview.localhost:18084/preview/{token}",
};

/** The `me`/`users`/`members`/project routes every authenticated screen reads. */
export function baseRoutes(extra: RouteStub[] = []): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", body: { items: [] } },
    { path: `/api/v1/projects/${projectFixture.id}`, method: "GET", body: projectFixture },
    {
      path: `/api/v1/projects/${projectFixture.id}/members`,
      method: "GET",
      body: {
        items: [
          { user_id: meFixture.id, display_name: meFixture.display_name, role: "maintainer" },
        ],
      },
    },
    ...extra,
  ];
}
