# Approve a gate

A gate is a pipeline step waiting for a human decision. The people who may
decide it are the approver roles on that step (or named users), so it is a
project role question, not an app-wide one.

- **Today** lists the gates waiting on you, with the run, the summary and the
  deadline; decide from the callout or open the run.
- **The run page** (`/runs/<id>`) lists its approvals; open one for its detail
  page (`/approvals/<id>`).
- On the detail page the three fixed verbs are **Approve**, **Request
  changes** and **Reject**. A 5-second undo hold follows the press; a decision
  taken elsewhere says who took it.

The assistant can record your decision (`approval.decide`, with `approve` or
`reject`), but approving a gate always asks on a confirm card — whatever your
trust level and whatever the decision model says.
