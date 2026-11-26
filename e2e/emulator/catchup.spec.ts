// catchup.spec.ts — SinceYouLeft on Home All + kept catch-up detail
// (/catch-up/:workId, 8a) and guided tour (/catch-up/tour, 8b).
//
// RETIRED by redesign R1/R2: `/catch-up` standalone index page (redirects to `/`,
// where SinceYouLeft lives) and `Today` Ask box (replaced by HomePrompt + QuickChat).
import { test, expect, apiMutate } from "./fixtures";
import { EMU_ADMIN_STATE, EMU_BASE_URL } from "./env";

test.use({ storageState: EMU_ADMIN_STATE });

test("Home SinceYouLeft + /catch-up redirect + piece page (8a) + tour (8b)", async ({
  page,
  request,
  emu,
}) => {
  test.setTimeout(90_000);
  const ts = Date.now().toString(36);

  // Verify /catch-up redirects cleanly to /
  await page.goto(`${EMU_BASE_URL}/catch-up`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("since-you-left")).toBeVisible();
  await emu.screen("home", "all");

  // Check if any catch-up item exists from Home/API, or seed a completed run/conversation
  const catchupRes = await request.get(`${EMU_BASE_URL}/api/v1/catch-up`);
  let firstWorkId: string | null = null;
  if (catchupRes.ok()) {
    const body = (await catchupRes.json()) as {
      items?: { id: string }[];
      rows?: { id: string }[];
    };
    firstWorkId = body.items?.[0]?.id ?? body.rows?.[0]?.id ?? null;
  }

  if (!firstWorkId) {
    // Seed a project + chat so at least a conversation exists if catch-up index returns items later.
    await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
      name: `Emu Catchup ${ts}`,
    });
  }

  // Visit TourPlayer (/catch-up/tour) — renders clean full-screen player or caught-up state
  await page.goto(`${EMU_BASE_URL}/catch-up/tour`);
  await expect(page.getByTestId("tour-player")).toBeVisible();
  await expect(
    page.getByTestId("tour-current").or(page.getByTestId("tour-caught-up")),
  ).toBeVisible();
  if (await page.getByTestId("tour-current").isVisible()) {
    await emu.screen("8b", "catchup-tour");
  }

  if (firstWorkId) {
    await page.goto(`${EMU_BASE_URL}/catch-up/${encodeURIComponent(firstWorkId)}`);
    await expect(page.getByTestId("catchup-item-current")).toBeVisible();
    await emu.screen("8a", "catchup-item");
  }
});
