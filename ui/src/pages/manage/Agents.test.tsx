/**
 * Manage → Agents & models: the chrome around the existing pieces.
 * - the header sentence and the admin-only New agent button,
 * - the tabs (default Profiles; `?tab=models` renders ModelsPanel),
 * - the profile sheet (opens on `itemId`; × and Esc navigate back keeping
 *   the tab; an unknown id gets the honest sentence),
 * - the loading/error states of the profiles read.
 * Hooks are mocked; nothing hits a network.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../../api/types";
import Agents from "./Agents";

const mocks = vi.hoisted(() => ({
  me: {
    data: { is_org_admin: true } as { is_org_admin: boolean } | undefined,
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  profiles: {
    data: undefined as { items: AgentProfile[] } | undefined,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  launchers: { data: { launchers: [] as unknown[] }, isPending: false, isError: false },
  sandbox: { data: null as unknown, isPending: false, isError: false, error: null },
  overview: {
    data: null as unknown,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
  strip: { renders: 0 },
}));

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useMe: () => mocks.me,
  useAgentProfiles: () => mocks.profiles,
  useSystemSandbox: () => mocks.sandbox,
}));
vi.mock("../../api/launchers", () => ({
  useLaunchers: () => mocks.launchers,
}));
vi.mock("../../api/overview", () => ({
  useSystemOverview: () => mocks.overview,
}));
vi.mock("./agents/AccountsStrip", () => ({
  default: () => {
    mocks.strip.renders += 1;
    return <div data-testid="agent-accounts" />;
  },
}));
vi.mock("./agents/ProfileSheet", async (importOriginal) => {
  // Keep the real sheet: it owns the Esc/×/unknown-id behaviour under test.
  return await importOriginal();
});
vi.mock("../../components/profiles/ProfileDetail", () => ({
  default: ({ profile }: { profile: { name: string } }) => (
    <div data-testid="profile-detail">{profile.name}</div>
  ),
}));
vi.mock("../../components/profiles/NewProfileDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-profile-dialog" /> : null,
}));
vi.mock("../../components/ops/ModelsPanel", () => ({
  ModelsPanel: () => <div data-testid="models-panel" />,
}));
vi.mock("../Collections", () => ({ default: () => <div data-testid="skills-tab" /> }));
vi.mock("../Steps", () => ({ default: () => <div data-testid="steps-tab" /> }));
vi.mock("../settings/Assistant", () => ({ default: () => <div data-testid="assistant-tab" /> }));

const profileFixture: AgentProfile = {
  id: "p-1",
  name: "Pinned Profile",
  launcher_id: "claude",
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  model: null,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/manage/agents" element={<Agents />} />
        <Route path="/manage/agents/:itemId" element={<Agents />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.me = { data: { is_org_admin: true }, isPending: false, isError: false, error: null };
  mocks.profiles = {
    data: { items: [profileFixture] },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  mocks.launchers = { data: { launchers: [] }, isPending: false, isError: false };
  mocks.sandbox = { data: null, isPending: false, isError: false, error: null };
  mocks.overview = { data: null, isPending: false, isError: false, error: null, refetch: vi.fn() };
  mocks.strip = { renders: 0 };
});

afterEach(cleanup);

describe("Manage → Agents & models", () => {
  it("renders the header, the accounts strip and the profiles table by default", () => {
    renderAt("/manage/agents");
    expect(screen.getByText("Agents & models")).toBeTruthy();
    expect(screen.getByTestId("agent-accounts")).toBeTruthy();
    expect(screen.getByTestId("agents-tab-profiles").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("profiles-table")).toBeTruthy();
  });

  it("keeps the tables' tab query string when the sheet closes", () => {
    renderAt("/manage/agents/p-1?tab=profiles");
    expect(screen.getByTestId("profile-sheet")).toBeTruthy();
    fireEvent.click(screen.getByTestId("profile-sheet-close"));
    expect(screen.queryByTestId("profile-sheet")).toBeNull();
    expect(screen.getByTestId("profiles-table")).toBeTruthy();
  });

  it("closes the sheet with Esc", () => {
    renderAt("/manage/agents/p-1?tab=profiles");
    expect(screen.getByTestId("profile-sheet")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("profile-sheet")).toBeNull();
  });

  it("renders an honest sentence for an unknown id in the sheet", () => {
    renderAt("/manage/agents/unknown-id");
    expect(screen.getByTestId("profile-sheet-missing").textContent).toBe(
      "That agent profile doesn't exist.",
    );
  });

  it("hides the New agent button and opens the dialog for an admin", () => {
    mocks.me = { data: { is_org_admin: false }, isPending: false, isError: false, error: null };
    renderAt("/manage/agents");
    expect(screen.queryByTestId("agents-new-open")).toBeNull();

    cleanup();
    mocks.me = { data: { is_org_admin: true }, isPending: false, isError: false, error: null };
    renderAt("/manage/agents");
    fireEvent.click(screen.getByTestId("agents-new-open"));
    expect(screen.getByTestId("new-profile-dialog")).toBeTruthy();
  });

  it("renders ModelsPanel for ?tab=models and the Assistant body for ?tab=assistant", () => {
    renderAt("/manage/agents?tab=models");
    expect(screen.getByTestId("agents-tab-models").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("models-panel")).toBeTruthy();
    cleanup();
    renderAt("/manage/agents?tab=assistant");
    expect(screen.getByTestId("assistant-tab")).toBeTruthy();
  });

  it("renders the Skills and Steps bodies inside their tabs", () => {
    renderAt("/manage/agents?tab=skills");
    expect(screen.getByTestId("skills-tab")).toBeTruthy();
    cleanup();
    renderAt("/manage/agents?tab=steps");
    expect(screen.getByTestId("steps-tab")).toBeTruthy();
  });

  it("shows the load error banner for a failed profiles read with the agents-load-error id", () => {
    mocks.profiles = {
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("bad read"),
      refetch: vi.fn(),
    };
    renderAt("/manage/agents");
    expect(screen.getByTestId("agents-load-error")).toBeTruthy();
  });

  it("shows the Spinner while the profiles read is in flight", () => {
    mocks.profiles = {
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    renderAt("/manage/agents");
    expect(screen.getByText(/Loading agent profiles/)).toBeTruthy();
  });
});
