// Phase 5 acceptance: Agent profiles — the list, the detail, and the
// New-profile dialog (contract C6) driven end to end.
//
// /profiles rows carry the launcher id and the sandbox chip exactly as
// contracts C5 (GET /api/v1/launchers) and /api/v1/system/sandbox derive it;
// the detail page's capability cells read only from recorded probe evidence;
// the dialog disables the unregistered agents (Pi, Antigravity) with a
// reason; and creating a profile through the dialog lands as a row in
// GET /api/v1/agent-profiles. Both viewports.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. evidence() per step;
// checkShellScreen on each page.
import { expect, test } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiAgentProfiles,
  apiLaunchers,
  checkShellScreen,
  evidence,
  signInNarrow,
  watchPageErrors,
  type LauncherRow,
} from "./shell-helpers.js";

const STAMP = Date.now().toString(36);
const PROFILE_NAME = `shell p5 ${STAMP}`;

/** GET /api/v1/system/sandbox — the fleet's verified enforcement report. */
async function apiSandbox(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get(`${BASE_URL}/api/v1/system/sandbox`);
  if (!res.ok()) throw new Error(`GET /system/sandbox -> ${res.status()}`);
  return (await res.json()) as {
    workers: { worker_id: string; enforcement: string; verified: boolean }[];
  };
}

/** The list chip's text, exactly as ui/src/lib/profiles.ts derives it. */
function expectedChip(
  launcher: LauncherRow | undefined,
  sandbox: { workers: { enforcement: string; verified: boolean }[] },
): string {
  if (!launcher || !launcher.registered) return "LAUNCHER NOT REGISTERED";
  const workerHalf = sandbox.workers.some((w) => w.enforcement === "required" && w.verified);
  const probeHalf = launcher.capabilities.some(
    (c) => c.capability === "nono_required" && c.result === "observed",
  );
  return workerHalf && probeHalf ? "REQUIRED · VERIFIED" : "NOT VERIFIED";
}

/** GET /api/v1/agent-profiles, then find the row just created by name. */
async function createdProfile(request: import("@playwright/test").APIRequestContext) {
  const after = await apiAgentProfiles(request);
  const row = after.find((p) => p.name === PROFILE_NAME);
  if (!row) throw new Error(`the API has no profile named "${PROFILE_NAME}"`);
  return row;
}

test.describe("shell p5 — agent profiles: list, detail, new-profile dialog", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(10 * 60_000);

  test("list rows and chips match the API; detail capability cells read from the probes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const [profiles, launchers, sandbox] = [
      await apiAgentProfiles(page.request),
      await apiLaunchers(page.request),
      await apiSandbox(page.request),
    ];
    expect(profiles.length).toBeGreaterThan(0);
    await page.goto(BASE_URL + "/profiles", { waitUntil: "domcontentloaded" });
    const rows = page.locator('[data-testid^="agent-item-"]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(await rows.count(), "one row per profile").toBe(profiles.length);
    for (const profile of profiles) {
      await expect(page.getByTestId(`agent-launcher-${profile.id}`)).toHaveText(
        `launcher: ${profile.launcher_id}`,
      );
      const chip = page.getByTestId(`profile-chip-${profile.id}`);
      // The chip renders glyph + text; assert the text span exactly.
      const chipText = (await chip.locator("span:not([aria-hidden])").innerText()).trim();
      expect(chipText, `chip for ${profile.name}`).toBe(
        expectedChip(
          launchers.find((l) => l.id === profile.launcher_id),
          sandbox,
        ),
      );
    }
    await checkShellScreen(page, "profiles list", stopWatching);
    await evidence(
      page,
      "shell-p5-list",
      `/profiles lists the ${profiles.length} API profiles; every launcher line and sandbox chip matches C5 (/api/v1/launchers) plus /api/v1/system/sandbox`,
    );

    // Detail: open the first row; the capability cells mirror the launcher's
    // recorded evidence (result + date, never a promise).
    const profile = profiles[0];
    const launcher = launchers.find((l) => l.id === profile.launcher_id);
    await page.getByTestId(`agent-row-${profile.id}`).click();
    await expect(page.getByTestId(`profile-detail-${profile.id}`)).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toContain(`/profiles/${profile.id}`);
    for (const capability of launcher?.capabilities ?? []) {
      const cell = page.getByTestId(`profile-capability-${profile.id}-${capability.capability}`);
      await expect(cell).toBeVisible();
      // The cell row is <capability name> + "<glyph> <text>"; read the value
      // span (the row's last span) and compare it exactly.
      const text = (await cell.locator("span").last().innerText()).trim();
      if (capability.result === "observed") {
        const day = capability.observed_at?.slice(0, 10);
        expect(text, `${capability.capability} cell`).toBe(
          day ? `✓ observed ${day}` : "✓ observed",
        );
      } else if (capability.result === "not_supported") {
        expect(text).toBe("× not supported");
      } else {
        expect(text).toBe("· not tested");
      }
    }
    await checkShellScreen(page, "profile detail", stopWatching);
    await evidence(
      page,
      "shell-p5-detail",
      `the ${profile.name} detail page shows its sections and every capability cell equals the launcher's recorded evidence (observed / not supported / not tested)`,
    );
  });

  test("New profile dialog: registered launcher cards are enabled, unregistered ones are disabled with reasons", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const launchers = await apiLaunchers(page.request);
    await page.goto(BASE_URL + "/profiles", { waitUntil: "domcontentloaded" });
    await page.getByTestId("agents-new-open").click();
    const dialog = page.getByTestId("new-profile-dialog");
    await expect(dialog).toBeVisible();
    // The truth per card comes from the registry read: registered => the card
    // is enabled with no refusal reason; unregistered => disabled with one.
    // (Pi is registered since ADR-0059; Antigravity is not.)
    for (const id of ["claude", "codex", "pi", "antigravity"]) {
      const card = page.getByTestId(`new-profile-card-${id}`);
      await expect(card).toBeVisible();
      const registered = launchers.find((l) => l.id === id)?.registered ?? false;
      const radio = card.locator("input[type=radio]");
      const reason = await card.getAttribute("data-reason");
      if (registered) {
        expect(await radio.isDisabled(), `${id} card is selectable`).toBe(false);
        expect(reason, `${id} card carries no reason`).toBeNull();
      } else {
        expect(await radio.isDisabled(), `${id} card is disabled`).toBe(true);
        expect(reason, `${id} card carries the reason`).toBeTruthy();
      }
    }
    await checkShellScreen(page, "new profile dialog", stopWatching);
    await evidence(
      page,
      "shell-p5-dialog-disabled-cards",
      "in the New profile dialog the unregistered Pi and Antigravity cards are disabled with their reasons, while the registered Claude and Codex cards stay selectable",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    stopWatching();
  });

  test("create a profile through the dialog — the API and the list both carry it", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/profiles", { waitUntil: "domcontentloaded" });
    await page.getByTestId("agents-new-open").click();
    await expect(page.getByTestId("new-profile-dialog")).toBeVisible();
    await page.getByTestId("new-profile-card-claude").click();
    await page.getByTestId("agents-new-name-input").fill(PROFILE_NAME);
    const post = page.waitForResponse(
      (res) => res.url().includes("/agent-profiles") && res.request().method() === "POST",
    );
    await page.getByTestId("agents-new-submit").click();
    // Contract C6: on the POST 201 the dialog hands the row to the caller
    // through onCreated and the caller closes it — /profiles navigates to
    // the new profile's detail (no "Done" confirmation click in between).
    expect((await post).status(), "POST /api/v1/agent-profiles answers 201").toBe(201);
    const row = await createdProfile(page.request);
    await expect(page.getByTestId("new-profile-dialog")).toBeHidden();
    await expect(page).toHaveURL(/\/profiles\/[^/]+$/);
    await evidence(
      page,
      "shell-p5-created-dialog",
      `creating "${PROFILE_NAME}" through the dialog closes it (the caller acts on onCreated) and lands on the new profile's detail page`,
    );
    await page.goto(BASE_URL + "/profiles", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`agent-name-${row.id}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`agent-launcher-${row.id}`)).toHaveText("launcher: claude");
    stopWatching();
    await evidence(
      page,
      "shell-p5-created-list",
      `GET /api/v1/agent-profiles and the /profiles list both carry the new row "${PROFILE_NAME}" (id ${row.id.slice(0, 8)}…)`,
    );
  });

  test("versioned save: the glyph moves v<n> → v<n+1>, history lists both, restore lands v<n+2>", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    const versionName = `shell p5 version ${STAMP}`;
    await page.goto(BASE_URL + "/profiles", { waitUntil: "domcontentloaded" });
    await page.getByTestId("agents-new-open").click();
    const dialog = page.getByTestId("new-profile-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("new-profile-card-claude").click();
    await page.getByTestId("agents-new-name-input").fill(versionName);
    const post = page.waitForResponse(
      (res) => res.url().includes("/agent-profiles") && res.request().method() === "POST",
    );
    await page.getByTestId("agents-new-submit").click();
    expect((await post).status()).toBe(201);
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/profiles\/[^/?]+$/);
    const profileId = /\/profiles\/([^/?]+)/.exec(page.url())?.[1] ?? "";
    const version = page.getByTestId("profile-version");
    // A created profile carries its first version: v1.
    await expect(version).toHaveText("v1");
    // Change the profile through the detail's save: the write carries the
    // version it saw and lands v2 ("Save as v2").
    const edit = page.getByTestId(`agent-apm-edit-${profileId}`);
    await expect(edit).toBeVisible();
    await edit.click();
    const save = page.waitForResponse(
      (res) => res.url().includes("/agent-profiles") && res.request().method() === "PATCH",
    );
    const saveButton = page.getByTestId(`agents-apm-save-${profileId}`);
    await expect(saveButton).toHaveText("Save as v2");
    await page.getByTestId(`agents-ref-input-${profileId}`).fill("mattpocock/skills#v1.3.1");
    await page.getByTestId(`agents-target-select-${profileId}`).selectOption("claude");
    await saveButton.click();
    expect((await save).status()).toBe(200);
    await expect(version).toHaveText("v2");
    // The HISTORY panel lists both versions, newest first.
    await expect(page.getByTestId("profile-history")).toBeVisible();
    await expect(page.getByTestId("profile-history-row-v2")).toBeVisible();
    await expect(page.getByTestId("profile-history-row-v1")).toBeVisible();
    // Restore the older version: the restore lands a NEW version (v3).
    const restore = page.waitForResponse(
      (res) => res.url().includes("/versions/1/restore") && res.request().method() === "POST",
    );
    await page.getByTestId("profile-history-restore-v1").click();
    await expect(page.getByTestId("profile-history-confirm")).toBeVisible();
    await page.getByTestId("profile-history-restore-submit").click();
    expect((await restore).status()).toBe(200);
    await expect(version).toHaveText("v3");
    await checkShellScreen(page, "profile version history", stopWatching);
    await evidence(
      page,
      "shell-p5-profile-versions",
      `the ${versionName} profile moved v1 → v2 through the "Save as v2" write, the HISTORY panel listed both versions, and restoring v1 landed v3`,
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("phone: the dialog fits and a profile is created through it", async ({ page }) => {
      await signInNarrow(page, "admin");
      const stopWatching = watchPageErrors(page);
      await page.goto(BASE_URL + "/profiles", { waitUntil: "domcontentloaded" });
      await page.getByTestId("agents-new-open").click();
      const dialog = page.getByTestId("new-profile-dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box, "the dialog is on screen at 390px").not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(390);
      await checkShellScreen(page, "new profile dialog at phone width", stopWatching);
      await evidence(
        page,
        "shell-p5-dialog-phone",
        "at 390x844 the New profile dialog fits the viewport without sideways scroll",
      );
      await page.getByTestId("new-profile-card-claude").click();
      await page.getByTestId("agents-new-name-input").fill(`${PROFILE_NAME} phone`);
      const post = page.waitForResponse(
        (res) => res.url().includes("/agent-profiles") && res.request().method() === "POST",
      );
      await page.getByTestId("agents-new-submit").click();
      // The dialog's success state (and the caller's close) ride on the POST
      // answer: wait for it before reading the list back, so the read is not
      // a read-before-write.
      expect((await post).status(), "POST /api/v1/agent-profiles answers 201").toBe(201);
      const res = await page.request.get(`${BASE_URL}/api/v1/agent-profiles?limit=100`);
      const body = (await res.json()) as { items: { id: string; name: string }[] };
      expect(body.items.some((p) => p.name === `${PROFILE_NAME} phone`)).toBe(true);
      stopWatching();
      await evidence(
        page,
        "shell-p5-created-phone",
        `at 390x844 the profile "${PROFILE_NAME} phone" is created through the dialog and exists in the API`,
      );
    });
  });
});
