/**
 * The branch a thread shows, from the workspace rows a person can read
 * (review 2e defect 2).
 *
 * `WorkspaceRepo.run_ref` is `<scope-id>/<repository-name>` — the ref
 * namespace one scope may write (ADR-0017 D4). It is a legitimate wire
 * identity and a useless sentence: the reviewed 2e chat printed
 * `01a19dd0-848e-74a0-a1ad-5caa7f2abfc2/server` in its header and again under
 * BRANCH, in a thread that works in **web**.
 *
 * Two facts were wrong at once, and both are this helper's job:
 *
 * 1. **The wrong repository.** A conversation's workspace holds every
 *    repository of its project (the agent's cwd is the workspace root, so a
 *    chat opened in one repo still sees its neighbours — `05` § workspace
 *    layout), and the rows come back ordered by name. Taking `repos[0]`
 *    therefore named whichever repository sorted first — `server` before
 *    `web` — not the one the thread belongs to. The thread's repository is
 *    the fact the caller already resolved once (ADR-0067's chain); matching
 *    on it is the fix, and it is why the suffix looked like another repo's.
 *
 * 2. **No human branch exists yet.** Nothing in the reads carries a branch a
 *    person named: the scope ref is machine topology. So when the matched
 *    value IS that scope ref, the honest sentence is "no branch yet" — the
 *    design's `chat/search-spike` is what a thread shows the day a read
 *    records a real branch name, never a prettified uuid.
 */
import type { components } from "../../api/schema";

type WorkspaceRepo = components["schemas"]["WorkspaceRepo"];

/** A `<scope-id>/<name>` ref: a 36-char uuid (any case) and a slash. */
const SCOPE_REF = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\//;

/** True when the stored ref is the workspace's internal namespace, not a name. */
export function isInternalWorkspaceRef(ref: string | null | undefined): boolean {
  return !ref || SCOPE_REF.test(ref);
}

/** What the header and BRANCH say when there is no branch to show. */
export const NO_BRANCH_YET = "no branch yet";

export interface ThreadBranch {
  /** The name to print — never a raw scope ref, never an id. */
  label: string;
  /** True when the thread has no real branch yet (the label is `NO_BRANCH_YET`). */
  none: boolean;
  /** The repository whose workspace row produced this answer; null if none matched. */
  repository: string | null;
  /** The modified-path count that repository's manifest records; null = unrecorded. */
  filesChanged: number | null;
}

/**
 * The thread's one branch fact.
 *
 * `repositoryName` is the caller's resolved repository (the same fact the
 * header's repo segment and WORKS IN print, so the three can never disagree).
 * A workspace row whose name matches is the thread's own; with a match, the
 * row's ref is shown only when it is a real branch name, and its manifest is
 * the file count. With no matching row the answer is "no branch yet" and no
 * file count — saying nothing beats naming another repository's checkout.
 */
export function threadBranch(
  repos: readonly Pick<WorkspaceRepo, "name" | "run_ref" | "modified_paths">[],
  repositoryName: string | null,
): ThreadBranch {
  const own = repositoryName
    ? (repos.find((repo) => repo.name === repositoryName) ?? null)
    : repos.length === 1
      ? repos[0]
      : null;
  if (!own) {
    return { label: NO_BRANCH_YET, none: true, repository: null, filesChanged: null };
  }
  const filesChanged = own.modified_paths?.length ?? null;
  if (isInternalWorkspaceRef(own.run_ref)) {
    return { label: NO_BRANCH_YET, none: true, repository: own.name, filesChanged };
  }
  return { label: own.run_ref, none: false, repository: own.name, filesChanged };
}
