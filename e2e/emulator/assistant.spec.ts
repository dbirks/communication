// assistant.spec.ts — Command palette (⌘K Search or ask), Quick chat (400px
// slide-in panel + TrustPill + PageContext), full /assistant page ("Open as
// chat"), and Manage -> Agents & models -> Assistant settings.
//
// RETIRED by redesign R6: `assistant-dock` (450px push dock alongside page).
// Replaced by `quick-chat` (400px right overlay) + `/assistant` full page.
import { test, expect } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

test("command palette, quick chat panel, /assistant page, and Manage Assistant tab", async ({
  page,
  emu,
}) => {
  test.setTimeout(90_000);

  await page.goto(`${EMU_BASE_URL}/`);
  await expect(page.getByTestId("home-all")).toBeVisible();

  // 1. Search or ask command palette (⌘K / button trigger)
  await page.getByTestId("search-or-ask").click();
  await expect(page.getByRole("dialog", { name: "Search or ask" })).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.getByTestId("palette-input").fill("Summarize open workflows");
  await expect(page.getByTestId("palette-ask")).toBeVisible();
  await emu.screen("quick-chat", "palette");

  // Open Quick chat from palette's Ask option.
  await page.getByTestId("palette-ask").click();
  await expect(page.getByTestId("quick-chat")).toBeVisible();
  await expect(page.getByTestId("assistant-panel-header")).toContainText("Quick chat");
  await expect(page.getByTestId("assistant-pill")).toBeVisible();
  await expect(page.getByTestId("assistant-context-button")).toHaveAttribute("aria-label", /Home/);
  await emu.screen("quick-chat", "open");

  // Check page context persists across navigation and closes cleanly via ×.
  await page.getByTestId("pill-factory").click();
  await expect(page.getByTestId("quick-chat")).toBeVisible();
  await expect(page.getByTestId("assistant-context-button")).toHaveAttribute(
    "aria-label",
    /Factory/,
  );

  await page.getByTestId("quick-chat-open-as-chat").click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByTestId("assistant-page")).toBeVisible();
  await expect(page.getByTestId("quick-chat")).toBeHidden();
  await emu.screen("assistant", "page");

  // Manage -> Agents & models -> Assistant tab
  await page.goto(`${EMU_BASE_URL}/manage/agents?tab=assistant`);
  await expect(page.getByTestId("manage-agents")).toBeVisible();
  await expect(page.getByTestId("settings-assistant")).toBeVisible();
  await expect(page.getByTestId("settings-assistant-trust-table")).toBeVisible();
  await expect(page.getByTestId("settings-assistant-speech")).toBeVisible();
  await emu.screen("manage", "agents-assistant");
});
