# Start a run

A run executes the revision an assignment pins. There is one door per surface,
and the same form behind all of them.

- **Today** (`/`) — the **Start run** button, for the quick case.
- **A project's Runs tab** (`/p/<project>/runs`) — the header band's
  **Start run** opens the New run form: pick the project, the workflow, and
  fill that revision's declared run inputs.
- **A workflow page** (`/p/<project>/workflows`, then a row) — start it from
  the workflow the same way.
- **A GitHub issue** (a repository page's open issues) — expand a row with
  **Start a run…** and the issue arrives as the run's typed input.

The assistant can start a run for you: `run.start` is a change, so it waits on
the confirm card (unless your trust level is *Don't ask*), and the thread then
links the run.
