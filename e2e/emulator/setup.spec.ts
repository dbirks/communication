// Setup project (runs first, once per pass): sign the lab's identities in
// through the mock IdP and save each browser's storage state, so the
// journey tests start signed-in and never pay the OIDC redirect chain
// twice. No journey logic here — the emu fixture is not used, so nothing
// is recorded.
//
// admin  — the org admin (bootstrap subject, COMMUNICATION_BOOTSTRAP_ADMIN_SUBJECTS)
//          with the library role; plays the workflows journeys.
// alice  — maintainer of the lab's "M4 Exit" project (docs/compatibility/
//          probes/m4/seed.sh); the only seeded identity that owns a project,
//          so the thread journey (New thread needs a writable project) is
//          hers, not the org admin's.
import { test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { signIn } from "../tests/helpers.js";
import { EMU_ALICE_STATE, EMU_OUT_DIR, EMU_ADMIN_STATE } from "./env.js";

test.describe("setup — one sign-in per identity per pass", () => {
  test.setTimeout(2 * 60_000);

  test("admin signs in via the mock IdP", async ({ browser }) => {
    await signIntoState(browser, "admin", EMU_ADMIN_STATE);
  });

  test("alice signs in via the mock IdP", async ({ browser }) => {
    await signIntoState(browser, "alice", EMU_ALICE_STATE);
  });
});

async function signIntoState(
  browser: import("@playwright/test").Browser,
  subject: string,
  stateFile: string,
): Promise<void> {
  await mkdir(EMU_OUT_DIR, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, subject);
    await context.storageState({ path: stateFile });
  } finally {
    await context.close();
  }
}
