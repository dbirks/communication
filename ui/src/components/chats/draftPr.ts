/**
 * The exact prompt the "Open a draft PR" confirm card sends (ADR-0045):
 * the platform has no push code, so the ask rides the ordinary message path
 * and the only proof of a PR is a URL in the transcript.
 */
export const DRAFT_PR_PROMPT =
  "Please push your current branch to origin and open a DRAFT pull request against the default branch using the GitHub CLI or API with your configured token. Reply with the PR URL, or explain exactly why you couldn't.";
