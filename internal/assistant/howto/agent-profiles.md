# Agent profiles

A profile is the agent a step runs as: the harness it launches with, the
account it signs in with, its skill package and its permission mode.

1. Open **Agents** (`/profiles`).
2. Choose **New profile**.
3. Pick the **Agent** (the harness launcher), the **Project** and the account
   **secret** it signs in with, a **Name**, and optionally an APM skill
   package (`ref`, `target`, lock digest) and a pinned model.
4. **Create profile**. Open a profile for its version history — every write
   to a profile is a new version, and a run names the version it used.

Steps name a profile in their config, so a workflow says *which agent* runs
each step. `profile.list` answers which profiles you can see; the assistant
reads them, it never creates or edits one.
