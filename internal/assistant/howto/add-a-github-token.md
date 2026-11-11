# Add a GitHub token

A GitHub token is a secret reference, not assistant input. `credential.create`
is not a tool, no token value ever passes through the assistant, and nothing
in the app reads one back.

1. Open the project's **Settings** page (`/p/<project>/settings`).
2. In the **SECRETS** panel, under **Add a secret reference**, set:
   - **Slug** — e.g. `github-token` (a pipeline or repository names it later);
   - **Purpose** — say *github credential* (this is how the app recognises a
     git/GitHub credential);
   - **Scope** — `project`, or `org` to share it across the organization's
     projects;
   - **Delivery** — `integration_broker`: the platform uses it for the
     mirror clone/fetch and issue reads, and it never reaches an agent. If
     the list offers only `env` and `env_file`, brokered delivery is not
     enabled on this server; ask an admin.
   - **Value (write-only)** — paste the token here. It is encrypted on write
     and never shown again.
3. Save, then attach it where it is used: on the repository's page choose
   **GitHub access** and pick that secret. `None (public repo)` reads
   anonymously.
4. Rotating means **Add version** on the same row; revoking stops delivery.
