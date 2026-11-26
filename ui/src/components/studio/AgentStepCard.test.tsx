import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../test/fakes";
import { AgentStepCard } from "./AgentStepCard";

afterEach(cleanup);

const YAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: test
spec:
  nodes:
    - id: implement
      kind: agent.acp
      config:
        profile: prof-1
        prompt: Write the code
`;

const PROFILES = {
  items: [
    {
      id: "prof-1",
      name: "claude-default",
      launcher_id: "claude",
      model: "sonnet",
      permission_mode: "default",
    },
    {
      id: "prof-2",
      name: "codex-fast",
      launcher_id: "codex",
      model: "gpt-5",
      permission_mode: "default",
    },
  ],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof AgentStepCard>> = {}) {
  mockFetch([
    { path: "/api/v1/agent-profiles", body: PROFILES },
    { path: "/api/v1/me", body: { id: "u1", is_org_admin: false } },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const apply = vi.fn((op) => op(YAML));
  const onMoreSettings = vi.fn();
  const onClose = vi.fn();
  const onRenamed = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentStepCard
          nodeId="implement"
          profile="prof-1"
          prompt="Write the code"
          text={YAML}
          readOnly={false}
          apply={apply}
          onRenamed={onRenamed}
          onMoreSettings={onMoreSettings}
          onClose={onClose}
          {...overrides}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { apply, onMoreSettings, onClose, onRenamed };
}

describe("AgentStepCard", () => {
  it("renders AGENT STEP header, name, AgentPicker, 6+ row prompt, and More settings", async () => {
    const { apply, onMoreSettings, onClose } = renderCard();
    expect(screen.getByText("AGENT STEP")).toBeTruthy();
    expect((screen.getByTestId("agent-card-name") as HTMLInputElement).value).toBe("implement");
    const prompt = screen.getByTestId("agent-card-prompt") as HTMLTextAreaElement;
    expect(prompt.rows).toBeGreaterThanOrEqual(6);
    expect(prompt.value).toBe("Write the code");

    await waitFor(() =>
      expect(screen.getByTestId("agent-card-picker").textContent).toContain("claude-default"),
    );

    fireEvent.click(screen.getByTestId("agent-card-picker"));
    fireEvent.click(await screen.findByTestId("agent-option-prof-2"));
    expect(apply).toHaveBeenCalledTimes(1);
    const profileRes = apply.mock.results[0].value as { ok: boolean; text: string };
    expect(profileRes.ok).toBe(true);
    expect(profileRes.text).toContain("profile: prof-2");

    fireEvent.change(prompt, { target: { value: "Implement and add unit tests" } });
    fireEvent.blur(prompt);
    expect(apply).toHaveBeenCalledTimes(2);
    const promptRes = apply.mock.results[1].value as { ok: boolean; text: string };
    expect(promptRes.text).toContain("Implement and add unit tests");

    fireEvent.click(screen.getByTestId("agent-card-more-settings"));
    expect(onMoreSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("agent-card-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renames the step and reports invalid ids inline", () => {
    const { apply, onRenamed } = renderCard();
    const nameInput = screen.getByTestId("agent-card-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Bad Name!" } });
    fireEvent.blur(nameInput);
    expect(screen.getByTestId("agent-card-rename-error")).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();

    fireEvent.change(nameInput, { target: { value: "code_step" } });
    fireEvent.blur(nameInput);
    expect(screen.queryByTestId("agent-card-rename-error")).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onRenamed).toHaveBeenCalledWith("code_step");
  });
});
