/**
 * `isGitHubRepository` — the client-side mirror of the server's
 * `github.ParseRepository` gate. A false here means the issues route is never
 * asked (no `422` in the console); it must accept exactly the remote forms
 * the server accepts and refuse everything else.
 */
import { describe, expect, it } from "vitest";
import { isGitHubRepository } from "./issues";

describe("isGitHubRepository", () => {
  it("accepts the remote forms the server parses as owner/repo", () => {
    for (const url of [
      "https://github.com/o/r",
      "https://github.com/o/r.git",
      "https://github.com/o/r/",
      "https://github.com:443/o/r.git",
      "http://github.com/o/r",
      "git://github.com/o/r.git",
      "ssh://git@github.com/o/r.git",
      "git@github.com:o/r.git",
      "git@github.com:o/r",
      "  https://github.com/o/r  ",
      "https://github.com/my-org.my_repo/thing-2.git",
    ]) {
      expect(isGitHubRepository(url), url).toBe(true);
    }
  });

  it("refuses every remote the server answers 422 not_a_github_repository for", () => {
    for (const url of [
      "",
      "   ",
      "file:///srv/git/lab.git",
      "/srv/git/lab.git",
      "https://gitlab.com/o/r.git",
      "https://ghe.example.com/o/r.git",
      "git@ghe.example.com:o/r.git",
      // A GitHub web page, not a remote — the server refuses the extra segment.
      "https://github.com/o/r/issues",
      "https://github.com/o",
      "https://github.com/",
      "https://github.com/o/r.git/extra",
      // Traversal is refused like the server refuses it.
      "https://github.com/../r",
      "https://github.com/o/..",
      // A windows drive path is not an scp remote.
      "C:\\repos\\lab.git",
      "github.com/o/r",
    ]) {
      expect(isGitHubRepository(url), url).toBe(false);
    }
  });
});
