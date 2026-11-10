# Add a repository

Repositories are added inside a project.

1. Open the project (sidebar, or **Projects** → **Open project**).
2. In the project header choose **Add repository**. The form is titled
   **Add a repository**.
3. Fill in **Name**, **Git URL** (`https://`, `ssh://`, `git@host:path` or
   `file://`) and, optionally, **Default branch** (blank means `main`).
4. Choose **Add repository**. The repository gets its own page under the
   project: `/p/<project>/<repo>`.

A private repository also needs a credential — see "Add a GitHub token". The
assistant can check a URL before you add it (`repo.check` reports whether a
credential reaches it, its default branch, and whether that credential can
push), and it adds repositories through a proposal card you confirm.
