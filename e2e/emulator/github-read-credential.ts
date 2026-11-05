// github-read-credential.ts — the ADR-0061 GitHub read credential for the
// emulator's `server` repository row (repo-chat-nav.spec.ts).
//
// Why this exists: `server`'s remote is a REAL public tracker
// (octocat/Hello-World), and the rcn-3b lanes journey drags a card that
// `server`'s ISSUES lane read off it. Read ANONYMOUSLY that costs the
// api.github.com 60-requests/hour budget of the runner's egress IP — the same
// IP every other workflow on the account shares — so a spent budget is a flake
// source in a pass that must come back clean twice in a row. Read
// AUTHENTICATED the same read costs 5000/hour.
//
// The knob is the one `e2e/tests/m5-issue-run.spec.ts` already uses on the lab
// suite, copied rather than imported: that file is a Playwright spec, so
// importing it would register its journeys in this suite's listing.
// acceptance.yml's job writes its own `GITHUB_TOKEN` to a mode-600 file under
// `$RUNNER_TEMP` and exports only the PATH as `E2E_GITHUB_READ_TOKEN_FILE`.
// When the variable names a file, the pass attaches the token to its project
// as an `integration_broker` secret (ADR-0061) and to the repository row as
// that secret's credential, so the control plane sends
// `Authorization: Bearer` on the issue reads. When it is unset — every local
// run — the read stays anonymous exactly as before.
//
// The token VALUE never enters argv, a log line, a screenshot, `results.json`
// or the repository row: it goes only into the secret's create/rotate request
// body, and the assertions below name only statuses, never response bodies.
import { existsSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { apiMutate, expect } from "./fixtures.js";
import { EMU_BASE_URL } from "./env.js";

/** How this pass read GitHub. Journey failure messages name it. */
export type GitHubReadMode = "authenticated" | "anonymous";

/**
 * Whether `E2E_GITHUB_READ_TOKEN_FILE` names a token file. An ENVIRONMENT
 * fact, so a failure can name the mode it ran in before any credential call
 * has happened; an empty file still fails loudly at the credential step.
 */
export const GITHUB_READ_MODE: GitHubReadMode =
  (process.env.E2E_GITHUB_READ_TOKEN_FILE ?? "") === "" ? "anonymous" : "authenticated";

/**
 * The ADR-0061 GitHub read token, or null for today's anonymous behaviour.
 * Set `E2E_GITHUB_READ_TOKEN_FILE` (a 0600 file the acceptance workflow
 * writes from the run's `GITHUB_TOKEN`) and the suite attaches the token to
 * its repository row as an `integration_broker` credential, so the ISSUES
 * lane's read is authenticated. A set-but-unreadable or EMPTY file is the
 * workflow's setup failing, so it fails loudly here rather than silently
 * falling back to the anonymous budget.
 */
export function githubReadToken(): string | null {
  const file = process.env.E2E_GITHUB_READ_TOKEN_FILE;
  if (!file) return null;
  if (!existsSync(file)) {
    throw new Error(
      `E2E_GITHUB_READ_TOKEN_FILE=${file} does not exist — the emulator's \`server\` GitHub read needs the ADR-0061 credential file the workflow writes (or unset the variable to read anonymously)`,
    );
  }
  const token = readFileSync(file, "utf8").trim();
  if (token === "") {
    throw new Error(
      `E2E_GITHUB_READ_TOKEN_FILE=${file} is empty — the emulator's \`server\` GitHub read needs a non-empty token (ADR-0061 credential)`,
    );
  }
  return token;
}

/**
 * Ensure the project holds the `integration_broker` secret (ADR-0061) whose
 * token the control plane sends as `Authorization: Bearer` on the `server`
 * repository's issue reads, and return its id — or null when no token file is
 * configured, which keeps today's anonymous behaviour. A pass's slug is unique
 * per pass, but the lab survives a pass boundary and a workflow's
 * `GITHUB_TOKEN` dies with its run, so a pre-existing row is ROTATED to this
 * run's token rather than trusted to still be live.
 */
export async function ensureGitHubReadCredential(
  page: Page,
  projectId: string,
  slug: string,
): Promise<string | null> {
  const token = githubReadToken();
  if (token === null) return null;
  const list = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${projectId}/secrets`);
  // Statuses only: a secret route's body is never echoed into an assertion.
  expect(list.status(), "the project's secret list answers").toBe(200);
  const body = (await list.json()) as {
    secrets?: { id: string; slug: string; delivery_mode: string }[];
  };
  const existing = (body.secrets ?? []).find((row) => row.slug === slug);
  if (existing) {
    expect(
      existing.delivery_mode,
      `${slug} already exists but is ${existing.delivery_mode}, not integration_broker`,
    ).toBe("integration_broker");
    const rotated = await apiMutate(
      page,
      "POST",
      `${EMU_BASE_URL}/api/v1/projects/${projectId}/secrets/${existing.id}/versions`,
      { value: token },
    );
    expect(
      rotated.status(),
      `rotate ${slug} to this run's token (POST /secrets/${existing.id}/versions)`,
    ).toBe(201);
    return existing.id;
  }
  const created = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${projectId}/secrets`,
    {
      slug,
      purpose: "github_repo",
      delivery_mode: "integration_broker",
      scope: "project",
      value: token,
    },
  );
  expect(
    created.status(),
    `create the ${slug} integration_broker secret (POST /projects/${projectId}/secrets)`,
  ).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

/**
 * Point an existing repository row at the ADR-0061 credential. The row may
 * already read `configured` with a DEAD token (a previous run's expired
 * `GITHUB_TOKEN` under the same name), so the patch is sent whenever a token
 * file is set, not only when the row says it has no credential.
 */
export async function attachGitHubReadCredential(
  page: Page,
  projectId: string,
  repositoryId: string,
  credentialSecretId: string,
): Promise<void> {
  const patched = await apiMutate(
    page,
    "PATCH",
    `${EMU_BASE_URL}/api/v1/projects/${projectId}/repos/${repositoryId}`,
    { credential_secret_id: credentialSecretId },
  );
  expect(
    patched.status(),
    `attach the ADR-0061 credential to the repository row (PATCH /repos/${repositoryId})`,
  ).toBe(200);
}

/**
 * The one-line cause a GitHub-backed read names in its failure message: what
 * mode this pass read api.github.com in, and what to check in that mode.
 */
export function gitHubReadModeNote(repoName: string): string {
  return GITHUB_READ_MODE === "authenticated"
    ? `\`${repoName}\` reads api.github.com AUTHENTICATED through its ADR-0061 credential (the pass attached the E2E_GITHUB_READ_TOKEN_FILE token, 5000 requests/hour) — an upstream-error read there is the credential or the tracker, not the anonymous budget`
    : `\`${repoName}\` reads api.github.com ANONYMOUSLY (E2E_GITHUB_READ_TOKEN_FILE unset — locally that is today's behaviour; on Actions the verification job is expected to write it), so a spent 60-requests/hour budget is a real refusal`;
}
