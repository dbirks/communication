# Assign a workflow to a project

A workflow (pipeline) runs inside a project only once it is **assigned**: the
assignment pins one published revision and carries the run budgets.

1. Open **Workflows** and pick the workflow (its page is `/workflows/<id>`).
2. On the row's `⋯` menu choose **Use in a repo…**, then the project (and the
   repository, or the whole project) and confirm. The newest published
   revision is pinned.
3. See what it is used in on the workflow's **Used in** tab; a project's own
   list is under its **Workflows** tab (`/p/<project>/workflows`).

Publishing is separate and stays a human action: a draft becomes a revision
through **Publish** on the draft page. `assignment.set` in the assistant pins
the latest published revision and names that revision on the confirm card —
that card is the promotion preview.
