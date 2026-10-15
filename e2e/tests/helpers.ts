// Shared fixtures for the M1 journey specs. Subjects are throwaway identities
// handed to the mock OIDC provider's interactive login form (ADR-0012) — they
// are not credentials and nothing secret crosses this code.
import { expect, type Page } from "@playwright/test";

/** Throwaway mock-IdP subjects used across the suite. */
export const ADMIN_SUBJECT = "admin";
export const OUTSIDER_SUBJECT = "mallory";

/**
 * Sign in through the mock OIDC provider: the app's `sign-in` link leaves the
 * SPA for `/auth/login`, which redirects to the IdP's interactive form
 * (`Enter any user/subject` + optional claims JSON — no real credentials).
 */
export async function signIn(page: Page, subject: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("sign-in").click();
  const subjectField = page.getByPlaceholder("Enter any user/subject");
  await expect(subjectField).toBeVisible();
  await subjectField.fill(subject);
  await page.getByRole("button", { name: "Sign-in" }).click();
  // The redirect chain lands back on the SPA with a session cookie set.
  await expect(page.getByTestId("user-badge")).toBeVisible();
}

/** Add a repository through the project page form and wait for its row. */
export async function addRepository(
  page: Page,
  projectUrl: string,
  name: string,
  gitUrl: string,
): Promise<void> {
  await page.goto(projectUrl);
  await page.getByTestId("repo-name").fill(name);
  await page.getByTestId("repo-git-url").fill(gitUrl);
  await page.getByTestId("repo-submit").click();
  await expect(rowFor(page, name)).toBeVisible();
}

/** The repo table row for a given repository name. */
export function rowFor(page: Page, name: string) {
  return page.getByTestId(`repo-row-${name}`);
}
