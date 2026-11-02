/**
 * The thread's branch fact (rcn-2e review defect 2), proven on plain data.
 *
 * The reviewed screen showed `01a19dd0-848e-74a0-a1ad-5caa7f2abfc2/server` in
 * the header and under BRANCH of a chat that works in **web** — two bugs at
 * once: the panel read `repos[0]` of a workspace that mirrors every repository
 * of the project (ordered by name, so `server` sorted first), and it printed a
 * `<scope-id>/<name>` run ref as if a person had named it.
 */
import { describe, expect, it } from "vitest";
import { isInternalWorkspaceRef, NO_BRANCH_YET, threadBranch } from "./threadBranch";

type Repo = { name: string; run_ref: string; modified_paths?: string[] };

function repo(name: string, runRef: string, modified: string[] = []): Repo {
  return { name, run_ref: runRef, modified_paths: modified };
}

const SCOPE = "01a19dd0-848e-74a0-a1ad-5caa7f2abfc2";

describe("threadBranch", () => {
  it("reads the thread's OWN repository, not whichever sorts first", () => {
    // The reviewed shape: one conversation workspace holding both project
    // repositories, the rows ordered by name — `server` before `web`.
    const repos = [repo("server", `${SCOPE}/server`), repo("web", `${SCOPE}/web`, ["a.go"])];
    const branch = threadBranch(repos, "web");
    expect(branch.repository).toBe("web");
    // The ref is machine topology, so the sentence is the honest one…
    expect(branch.label).toBe(NO_BRANCH_YET);
    expect(branch.none).toBe(true);
    // …and the file count is the manifest of THAT repository.
    expect(branch.filesChanged).toBe(1);
  });

  it('says "no branch yet" for a scope ref and prints a real branch name', () => {
    expect(isInternalWorkspaceRef(`${SCOPE}/web`)).toBe(true);
    expect(isInternalWorkspaceRef("chat/search-spike")).toBe(false);
    expect(isInternalWorkspaceRef("main")).toBe(false);
    expect(isInternalWorkspaceRef("")).toBe(true);

    const named = threadBranch([repo("web", "chat/search-spike", ["a.go", "b.go"])], "web");
    expect(named).toEqual({
      label: "chat/search-spike",
      none: false,
      repository: "web",
      filesChanged: 2,
    });
  });

  it("claims nothing when the thread's repository has no workspace row", () => {
    // Naming another repository's checkout as this thread's branch would say
    // something the reads do not: the thread works in `api`, and no row of
    // this workspace belongs to it.
    const branch = threadBranch([repo("web", `${SCOPE}/web`)], "api");
    expect(branch.label).toBe(NO_BRANCH_YET);
    expect(branch.repository).toBeNull();
    expect(branch.filesChanged).toBeNull();
  });

  it("reads a single-repo workspace with no repository fact to match on", () => {
    // A thread whose repository binding never resolved still has ONE checkout,
    // and there is no other candidate to confuse it with.
    const branch = threadBranch([repo("web", "thread/fix-flaky")], null);
    expect(branch.label).toBe("thread/fix-flaky");
    expect(branch.repository).toBe("web");
  });

  it("says nothing about a workspace it does not have", () => {
    const branch = threadBranch([], "web");
    expect(branch.label).toBe(NO_BRANCH_YET);
    expect(branch.filesChanged).toBeNull();
  });
});
