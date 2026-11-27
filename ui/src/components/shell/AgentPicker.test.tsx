/**
 * AgentPicker: grouping and order, the label helper, the selected chip's
 * name · model, keyboard navigation, the admin-only sign-in warning, the
 * loading/error/empty rows and the disabled chip's title.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPicker, groupProfiles, harnessLabel } from "./AgentPicker";
import type { AgentProfile } from "../../api/types";

const mocks = vi.hoisted(() => ({
  profiles: { data: { items: [] as AgentProfile[] }, isPending: false, isError: false } as {
    data: { items: AgentProfile[] } | undefined;
    isPending: boolean;
    isError: boolean;
  },
  me: { data: { is_org_admin: false } } as { data: { is_org_admin: boolean } | undefined },
  accounts: vi.fn(),
}));

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useAgentProfiles: () => mocks.profiles,
  useMe: () => mocks.me,
}));
vi.mock("../../api/agentAccounts", () => ({
  useAgentAccounts: mocks.accounts,
}));

const profile = (id: string, name: string, launcher_id: string, model?: string): AgentProfile => ({
  id,
  name,
  launcher_id,
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  model: model ?? null,
});

const claudeA = profile("p-claude-a", "Bravo Claude", "claude", "gpt-5");
const claudeB = profile("p-claude-b", "Alpha Claude", "claude");
const codexA = profile("p-codex-a", "Zeta Codex", "codex");
const codexB = profile("p-codex-b", "Alpha Codex", "codex", "o3");
const antigravity = profile("p-antigravity", "Gamma Antigravity", "antigravity");
const other = profile("p-other", "Delta Other", "zap");

const allProfiles = [claudeA, claudeB, codexA, codexB, antigravity, other];

function renderPicker(props: Partial<Parameters<typeof AgentPicker>[0]> = {}) {
  return render(
    <MemoryRouter>
      <AgentPicker value={null} onChange={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

function openPicker() {
  fireEvent.click(screen.getByTestId("agent-picker"));
  return screen.getByTestId("agent-picker-popover");
}

beforeEach(() => {
  mocks.profiles = { data: { items: allProfiles }, isPending: false, isError: false };
  mocks.me = { data: { is_org_admin: false } };
  mocks.accounts.mockReturnValue({ data: { items: [] } });
  mocks.accounts.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("harnessLabel", () => {
  it("maps the named harnesses and capitalizes anything else", () => {
    expect(harnessLabel("claude")).toBe("Claude");
    expect(harnessLabel("codex")).toBe("Codex");
    expect(harnessLabel("antigravity")).toBe("Antigravity");
    expect(harnessLabel("zap")).toBe("Zap");
  });
});

describe("groupProfiles", () => {
  it("orders claude, codex, antigravity, then others alphabetically; profiles alphabetical within a group", () => {
    const groups = groupProfiles(allProfiles);
    expect(groups.map((g) => g.harness)).toEqual(["claude", "codex", "antigravity", "zap"]);
    expect(groups.map((g) => g.label)).toEqual(["Claude", "Codex", "Antigravity", "Zap"]);
    expect(groups[0].profiles.map((p) => p.name)).toEqual(["Alpha Claude", "Bravo Claude"]);
    expect(groups[1].profiles.map((p) => p.name)).toEqual(["Alpha Codex", "Zeta Codex"]);
  });
});

describe("AgentPicker", () => {
  it("prints the selected profile's name and model, and the ✓ on the selected row", () => {
    renderPicker({ value: claudeA.id });
    fireEvent.click(screen.getByTestId("agent-picker"));
    const chip = screen.getByTestId("agent-picker");
    expect(chip.textContent).toContain("Bravo Claude");
    expect(chip.textContent).toContain("gpt-5");
    expect(screen.getByTestId(`agent-option-${claudeA.id}`).textContent).toContain("✓");
    expect(screen.getByTestId(`agent-option-${claudeA.id}`).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTestId(`agent-option-${claudeB.id}`).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("prints 'Choose agent' and no model when nothing is selected", () => {
    renderPicker({ value: null });
    const chip = screen.getByTestId("agent-picker");
    expect(chip.textContent).toContain("Choose agent");
  });

  it("prints the chip label at 600 ink and a picker chevron (review SH-3)", () => {
    renderPicker({ value: claudeA.id });
    const chip = screen.getByTestId("agent-picker");
    const label = chip.querySelector('[data-testid="agent-picker-label"]');
    expect(label?.textContent).toBe("Bravo Claude");
    expect(label?.className).toContain("text-ink");
    // the robot icon and the chevron
    expect(chip.querySelectorAll("svg")).toHaveLength(2);
  });

  it("keyboard: open, ArrowDown, Enter chooses the profile and closes", () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    fireEvent.click(screen.getByTestId("agent-picker"));
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0], { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("p-claude-b");
    expect(screen.queryByTestId("agent-picker-popover")).toBeNull();
  });

  it("Esc closes and returns focus to the chip", () => {
    renderPicker({ value: claudeA.id });
    const chip = screen.getByTestId("agent-picker");
    fireEvent.click(chip);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("agent-picker-popover")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("admin + signed-out codex shows '! sign-in' on the Codex group; a non-admin never calls useAgentAccounts with true", () => {
    mocks.me = { data: { is_org_admin: true } };
    mocks.accounts.mockReturnValue({
      data: {
        items: [
          {
            worker_id: "w1",
            worker_name: "w1",
            launcher: "codex",
            state: "signed_out",
            account_label: null,
            detail: null,
            checked_at: null,
            login: null,
          },
          {
            worker_id: "w2",
            worker_name: "w2",
            launcher: "codex",
            state: "signed_out",
            account_label: null,
            detail: null,
            checked_at: null,
            login: null,
          },
        ],
      },
    });
    renderPicker({ value: codexA.id });
    openPicker();
    expect(screen.getByTestId("agent-group-link-codex").textContent).toContain("! sign-in");
    expect(mocks.accounts).toHaveBeenCalledWith(true);
  });

  it("non-admin does not read agent accounts", () => {
    renderPicker();
    openPicker();
    expect(mocks.accounts).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId(/agent-group-link-/i)).toBeNull();
  });

  it("shows the loading row", () => {
    mocks.profiles = { data: undefined, isPending: true, isError: false };
    renderPicker();
    openPicker();
    expect(screen.getByText("Loading agents…")).toBeTruthy();
  });

  it("shows the error row", () => {
    mocks.profiles = { data: undefined, isPending: false, isError: true };
    renderPicker();
    openPicker();
    expect(screen.getByText("Couldn't load agents.")).toBeTruthy();
  });

  it("shows the empty row and the manage link", () => {
    mocks.profiles = { data: { items: [] }, isPending: false, isError: false };
    renderPicker();
    openPicker();
    expect(screen.getByText("No agent profiles yet.")).toBeTruthy();
    expect(screen.getByTestId("agent-picker-manage").textContent).toContain("Manage agents…");
  });

  it("disabled chip carries the reason as its title and the popover stays closed", () => {
    renderPicker({ disabled: true, disabledReason: "Only the controller may switch." });
    const chip = screen.getByTestId("agent-picker");
    expect(chip.getAttribute("title")).toBe("Only the controller may switch.");
    expect(chip.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByTestId("agent-picker-popover")).toBeNull();
  });

  it("with 14 profiles: caps popover height with a scrolling listbox, flips downward when room above is tight, and scrolls focused option into view", () => {
    const fourteen = Array.from({ length: 14 }, (_, i) =>
      profile(
        `p-${String(i + 1).padStart(2, "0")}`,
        `Agent ${String(i + 1).padStart(2, "0")}`,
        "claude",
      ),
    );
    mocks.profiles = { data: { items: fourteen }, isPending: false, isError: false };
    vi.stubGlobal("innerHeight", 900);

    renderPicker({ side: "top" });
    const chip = screen.getByTestId("agent-picker");
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({
      top: 180,
      bottom: 208,
      left: 100,
      right: 240,
      width: 140,
      height: 28,
      x: 100,
      y: 180,
      toJSON: () => ({}),
    });

    fireEvent.click(chip);
    const popover = screen.getByTestId("agent-picker-popover");
    expect(popover.className).toContain("max-h-[min(360px,calc(100vh-96px))]");
    expect(popover.getAttribute("data-side")).toBe("bottom");

    const listbox = screen.getByRole("listbox", { name: "Agent" });
    expect(listbox.className).toContain("overflow-y-auto");
    expect(screen.getByTestId("agent-picker-manage").parentElement?.className).toContain(
      "shrink-0",
    );

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(14);
    const scrollSpy = vi.fn();
    for (const opt of options) {
      opt.scrollIntoView = scrollSpy;
    }

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });

    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(document.activeElement).toBe(options[13]);
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });
});
