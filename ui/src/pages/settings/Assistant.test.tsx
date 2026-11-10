/**
 * Settings → Assistant (handoff A5/A6): the trust radios read their copy from
 * `TRUST_LEVELS` (never duplicated here, and no level promises that a change
 * can be undone); the 1p table answers "which actions ask at your level" with
 * the current level's column highlighted; the decision-model line and the
 * Speech rows read `GET /api/v1/assistant/status` in both states; and the two
 * dictation switches PATCH the same assistant preference section the trust
 * level uses.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantSystemStatus } from "../../api/assistant";
import { DEFAULT_TRUST_LEVEL, TRUST_LEVELS } from "../../components/assistant/types";
import { setCsrfToken } from "../../api/client";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import AssistantSettings from "./Assistant";

const PREFERENCES_PATH = "/api/v1/me/preferences";
const STATUS_PATH = "/api/v1/assistant/status";
const CSRF = meFixture.csrf_token;

interface AssistantSection {
  trust_level?: string;
  speech_auto_send?: boolean;
  speech_browser_fallback?: boolean;
}

function preferencesDocument(assistant: AssistantSection) {
  return {
    layout: { expanded: {} },
    assistant,
    updated_at: "2026-02-12T10:00:00Z",
  };
}

/** Fully wired server: judge + speech endpoint set, key present. */
function statusHealthy(overrides: Partial<AssistantSystemStatus> = {}): AssistantSystemStatus {
  return {
    chat_model: { configured: true, model: "qwen3-8-flash-next" },
    speech_model: {
      configured: true,
      model: "qwen3-asr-1-7b",
      endpoint_host: "llm-collective.internal",
      key_set: true,
    },
    decision_model: { configured: true, model: "system-one" },
    workers: { online: 1, sandbox_mode: "required" },
    execution_mode: "inprocess",
    github_credentials: [],
    projects: { count: 1 },
    workflows: { count: 3, samples: 2, assigned: 1 },
    ...overrides,
  };
}

/** The bare server: no judge, no speech endpoint. */
function statusBare(): AssistantSystemStatus {
  return statusHealthy({
    speech_model: { configured: false, model: "" },
    decision_model: { configured: false, model: "" },
  });
}

function mount(stubs: RouteStub[]) {
  const { requests } = mockFetch([
    {
      path: PREFERENCES_PATH,
      method: "GET",
      body: preferencesDocument({ trust_level: DEFAULT_TRUST_LEVEL }),
    },
    ...stubs,
  ]);
  setCsrfToken(CSRF);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AssistantSettings />
    </QueryClientProvider>,
  );
  return { requests };
}

const checked = (label: RegExp) => {
  const radio = screen.getByRole("radio", { name: label });
  return (radio as HTMLInputElement).checked;
};

const cell = (row: number, level: string) =>
  screen.getByTestId(`settings-assistant-trust-table-cell-${row}-${level}`);

const isHighlighted = (element: HTMLElement) => element.className.includes("bg-accent-wash");

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
});

describe("Settings → Assistant trust copy", () => {
  it("reads every label and blurb from TRUST_LEVELS and never mentions undo", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByTestId("settings-assistant")).toBeTruthy());
    // "Don't ask" is also the table's column header, so the radio group is the scope.
    const group = within(screen.getByTestId("settings-assistant-trust-level-group"));
    for (const level of TRUST_LEVELS) {
      expect(group.getByText(level.label)).toBeTruthy();
      expect(screen.getByText(level.blurb)).toBeTruthy();
      expect(
        screen.getByTestId(`settings-assistant-trust-level-option-${level.value}`),
      ).toBeTruthy();
    }
    expect(checked(new RegExp(TRUST_LEVELS[1].label))).toBe(true); // the documented default
    const text = document.body.textContent?.toLowerCase() ?? "";
    expect(text).not.toContain("undo");
    expect(text).not.toContain("revers");
  });
});

describe("Settings → Assistant trust table (1p)", () => {
  const ROWS = [
    ["Read, search, navigate", "—", "—", "—"],
    ["Edit a draft", "asks", "—", "—"],
    ["Create project / add repo", "asks", "asks*", "—"],
    ["Start or retry a run", "asks", "asks*", "—"],
    ["Approve, grant permission", "asks", "always", "—"],
    ["Publish a workflow", "asks", "asks*", "—"],
    ["Credentials, members, delete", "never", "never", "never"],
  ] as const;

  it("shows the columns, every row, and the footnote", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByTestId("settings-assistant-trust-table")).toBeTruthy());
    expect(screen.getByText("Which actions ask at your level")).toBeTruthy();
    for (const level of ["ask_all", "ask_risky", "no_ask"]) {
      expect(screen.getByTestId(`settings-assistant-trust-table-head-${level}`)).toBeTruthy();
    }
    expect(screen.getByTestId("settings-assistant-trust-table-head-ask_all").textContent).toBe(
      "Every change",
    );
    expect(screen.getByTestId("settings-assistant-trust-table-head-ask_risky").textContent).toBe(
      "When risky",
    );
    expect(screen.getByTestId("settings-assistant-trust-table-head-no_ask").textContent).toBe(
      "Don't ask",
    );
    ROWS.forEach((row, index) => {
      expect(screen.getByTestId(`settings-assistant-trust-table-row-${index}`)).toBeTruthy();
      expect(screen.getByText(row[0])).toBeTruthy();
      expect(cell(index, "ask_all").textContent).toBe(row[1]);
      expect(cell(index, "ask_risky").textContent).toBe(row[2]);
      expect(cell(index, "no_ask").textContent).toBe(row[3]);
    });
    expect(screen.getByTestId("settings-assistant-trust-table-footnote").textContent).toContain(
      "* With a decision model, it decides these case by case and asks when a call looks risky.",
    );
  });

  it("highlights the column of the current level and follows a change", async () => {
    const { requests } = mount([
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: preferencesDocument({ trust_level: "ask_all" }),
      },
    ]);
    await waitFor(() => expect(screen.getByTestId("settings-assistant-trust-table")).toBeTruthy());
    // Default level ask_risky: its whole column is washed, the others are not.
    ROWS.forEach((_, index) => {
      expect(isHighlighted(cell(index, "ask_risky"))).toBe(true);
      expect(isHighlighted(cell(index, "ask_all"))).toBe(false);
      expect(isHighlighted(cell(index, "no_ask"))).toBe(false);
    });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(TRUST_LEVELS[0].label) }));
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    ROWS.forEach((_, index) => {
      expect(isHighlighted(cell(index, "ask_all"))).toBe(true);
      expect(isHighlighted(cell(index, "ask_risky"))).toBe(false);
    });
  });
});

describe("Settings → Assistant decision model line", () => {
  it("names the model when one is configured", async () => {
    mount([{ path: STATUS_PATH, body: statusHealthy() }]);
    await waitFor(() =>
      expect(screen.getByTestId("settings-assistant-decision-model").textContent).toBe(
        "Decision model: system-one · if it's down, it asks you",
      ),
    );
  });

  it("says the fixed table decides when none is set up", async () => {
    mount([{ path: STATUS_PATH, body: statusBare() }]);
    await waitFor(() =>
      expect(screen.getByTestId("settings-assistant-decision-model").textContent).toBe(
        "Decision model: none set up · the fixed table decides",
      ),
    );
  });

  it("claims nothing while the status is unreadable", async () => {
    mount([{ path: STATUS_PATH, status: 501 }]);
    await waitFor(() => expect(screen.getByTestId("settings-assistant-trust-table")).toBeTruthy());
    expect(screen.queryByTestId("settings-assistant-decision-model")).toBeNull();
  });
});

describe("Settings → Assistant Speech", () => {
  it("shows endpoint, model, key and status when configured", async () => {
    mount([{ path: STATUS_PATH, body: statusHealthy() }]);
    await waitFor(() =>
      expect(screen.getByTestId("settings-assistant-speech-status").textContent).toContain(
        "configured",
      ),
    );
    expect(screen.getByTestId("settings-assistant-speech-endpoint").textContent).toContain(
      "llm-collective.internal · from env",
    );
    expect(screen.getByTestId("settings-assistant-speech-model").textContent).toContain(
      "qwen3-asr-1-7b",
    );
    expect(screen.getByTestId("settings-assistant-speech-key").textContent).toContain(
      "set · never shown",
    );
    expect(screen.getByTestId("settings-assistant-speech-audio-note").textContent).toBe(
      "Audio is discarded after transcription.",
    );
  });

  it("says dictation uses the browser when the endpoint is not configured", async () => {
    mount([{ path: STATUS_PATH, body: statusBare() }]);
    await waitFor(() =>
      expect(screen.getByTestId("settings-assistant-speech-status").textContent).toContain(
        "not configured — dictation uses the browser",
      ),
    );
    expect(screen.getByTestId("settings-assistant-speech-endpoint").textContent).toContain(
      "not set",
    );
    expect(screen.getByTestId("settings-assistant-speech-model").textContent).toContain("not set");
    expect(screen.getByTestId("settings-assistant-speech-key").textContent).toContain("not set");
  });

  it("defaults: auto-send off, browser fallback on", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByTestId("settings-assistant-speech")).toBeTruthy());
    expect(
      (
        screen
          .getByTestId("settings-assistant-speech-auto-send")
          .querySelector("input") as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen
          .getByTestId("settings-assistant-speech-browser-fallback")
          .querySelector("input") as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("the checkboxes PATCH the assistant preference section", async () => {
    const { requests } = mount([
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: preferencesDocument({ trust_level: DEFAULT_TRUST_LEVEL, speech_auto_send: true }),
      },
    ]);
    await waitFor(() => expect(screen.getByTestId("settings-assistant-speech")).toBeTruthy());
    const autoSendInput = () =>
      screen
        .getByTestId("settings-assistant-speech-auto-send")
        .querySelector("input") as HTMLInputElement;
    const fallbackInput = () =>
      screen
        .getByTestId("settings-assistant-speech-browser-fallback")
        .querySelector("input") as HTMLInputElement;
    fireEvent.click(autoSendInput());
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    expect(JSON.parse(requestsTo(requests, PREFERENCES_PATH, "PATCH")[0].body ?? "{}")).toEqual({
      assistant: { speech_auto_send: true },
    });
    fireEvent.click(fallbackInput());
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(2));
    expect(JSON.parse(requestsTo(requests, PREFERENCES_PATH, "PATCH")[1].body ?? "{}")).toEqual({
      assistant: { speech_browser_fallback: false },
    });
  });
});
