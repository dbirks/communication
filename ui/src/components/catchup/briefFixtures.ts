/**
 * The brief's fixtures (ADR-0081): one brief per page state the brief blocks
 * have to draw, shaped exactly as `GET /api/v1/catch-up/brief` answers — same
 * keys, same enums, same closed window vocabulary. `at` stamps are written
 * against `BRIEF_NOW` so an age assertion never depends on the clock.
 *
 * Shared by the brief components' own tests and by the page test; every value
 * here is invented lab prose, not a seeded record.
 */
import type { CatchUpBrief, CatchUpProjectChip } from "../../api/catchup";

/** The fixed "now" every brief fixture is measured against. */
export const BRIEF_NOW = new Date("2026-11-11T12:00:00Z");

/** The three projects the fixture briefs spread their rows over. The `color`
 * is the schema's closed enum, so these are typed as the chip they are. */
const payments: CatchUpProjectChip = {
  id: "01987a90-0000-7000-8000-111111111111",
  name: "payments-api",
  color: "#6a4bc4",
};
const webApp: CatchUpProjectChip = {
  id: "01987a90-0000-7000-8000-222222222222",
  name: "web-app",
  color: "#1f8077",
};
const infra: CatchUpProjectChip = {
  id: "01987a90-0000-7000-8000-333333333333",
  name: "infra",
  color: "#4a5a78",
};

export const emptyNumbers: CatchUpBrief["numbers"] = {
  runs: { succeeded: 0, failed: 0, cancelled: 0, running: 0 },
  approvals: { decided: 0, pending: 0 },
  threads_active: 0,
  prs: 0,
  commits: 0,
};

/** A brief with nothing in it at all — the quiet state's own shape. */
export const quietBrief: CatchUpBrief = {
  window: { key: "24h", since: "2026-11-10T12:00:00Z", until: "2026-11-11T12:00:00Z" },
  headline: { text: "", state: "unavailable" },
  needs_you: [],
  running_now: [],
  shipped: [],
  broke: [],
  heads_up: [],
  changes: [],
  numbers: emptyNumbers,
  by_project: [],
  omitted: {},
};

/** The full brief: one row of everything, a model headline, and a cut `shipped`
 * list so the head has to say "and 4 more". */
export const fullBrief: CatchUpBrief = {
  ...quietBrief,
  headline: {
    text: "Two gates wait on you, and payments-api CI has failed 3 times in a row.",
    state: "ready",
  },
  needs_you: [
    {
      kind: "question",
      title: "Alert routing: one tree or two?",
      project: infra,
      link: "/catch-up/01987a90-0000-7000-8000-444444444444?stop=the-work",
      at: "2026-11-11T10:00:00Z",
      detail: "Fold paging into the existing alert tree, or split it in two?",
    },
    {
      kind: "failed_run",
      title: "Fix flaky checkout test",
      project: webApp,
      link: "/runs/01987a90-0000-7000-8000-555555555555",
      at: "2026-11-11T11:57:00Z",
      detail: "test_failure at node implement",
    },
    {
      kind: "approval",
      title: "Rotate the payments webhook secret",
      project: payments,
      link: "/approvals/01987a90-0000-7000-8000-666666666666",
      at: "2026-11-11T11:45:00Z",
      detail: "Approve plan: rotate webhook secret",
    },
  ],
  running_now: [
    {
      run_id: "01987a90-0000-7000-8000-777777777777",
      title: "Add idempotency keys to refunds",
      project: payments,
      started_at: "2026-11-11T11:54:00Z",
      step: "implement",
      link: "/runs/01987a90-0000-7000-8000-777777777777",
    },
    {
      run_id: "01987a90-0000-7000-8000-787777777777",
      title: "Backfill the ledger accounts",
      project: webApp,
      started_at: "2026-11-11T11:40:00Z",
      step: "",
      link: "/runs/01987a90-0000-7000-8000-787777777777",
    },
  ],
  shipped: [
    {
      kind: "pr",
      title: "Add idempotency keys to refunds",
      project: payments,
      ref: {
        number: 412,
        url: "https://github.com/acme/payments-api/pull/412",
        sha: "3649f6f664c442b050fb1d1666aeeb6fe90649d9",
      },
      by: "ravi",
      at: "2026-11-11T11:51:00Z",
      link: "/runs/01987a90-0000-7000-8000-888888888888",
    },
    {
      kind: "commit",
      title: "Cut the 2026-11 release branch",
      project: webApp,
      ref: { sha: "27fb42914a8f26784a86eb65536192148c80ce1a" },
      by: "ravi",
      at: "2026-11-11T04:00:00Z",
      link: "/runs/01987a90-0000-7000-8000-999999999999",
    },
    {
      kind: "workflow_revision",
      title: "payments-api CI v2.1.0",
      project: payments,
      ref: {},
      by: "a teammate",
      at: "2026-11-10T20:00:00Z",
      link: "/workflows/01987a90-0000-7000-8000-aaaaaaaaaaaa",
    },
  ],
  broke: [
    {
      title: "payments-api CI",
      project: payments,
      failures: 3,
      error_class: "test",
      still_failing: true,
      fixed_at: null,
      link: "/runs/01987a90-0000-7000-8000-bbbbbbbbbbbb",
    },
    {
      title: "web-app CI",
      project: webApp,
      failures: 1,
      error_class: "infra",
      still_failing: false,
      fixed_at: "2026-11-10T18:00:00Z",
      link: "/runs/01987a90-0000-7000-8000-cccccccccccc",
    },
  ],
  heads_up: [
    {
      signal: "push_to_main",
      title: "Pin the shared lint config on main",
      project: payments,
      link: "/runs/01987a90-0000-7000-8000-dddddddddddd",
    },
    {
      signal: "migration",
      title: "Backfill the ledger accounts",
      project: webApp,
      link: "/catch-up/01987a90-0000-7000-8000-eeeeeeeeeeee",
    },
  ],
  changes: [
    {
      kind: "workflow_published",
      title: "Issue to draft PR v3",
      by: "ravi",
      at: "2026-11-11T11:35:00Z",
      link: "/workflows/01987a90-0000-7000-8000-ffffffffffff",
    },
    {
      kind: "member_added",
      title: "a new member joined infra as contributor",
      by: "",
      at: "2026-11-09T10:00:00Z",
      link: "/p/01987a90-0000-7000-8000-333333333333/members",
    },
  ],
  numbers: {
    runs: { succeeded: 12, failed: 3, cancelled: 1, running: 2 },
    approvals: { decided: 2, pending: 2 },
    threads_active: 0,
    prs: 4,
    commits: 1,
  },
  by_project: [
    { project: payments, line: "3 gates decided, 1 PR opened, CI still red on the test node." },
    { project: webApp, line: "The release branch was cut; web-app CI went green again." },
  ],
  omitted: { shipped: 4 },
};

/** The same brief with the model's headline still being written. */
export const pendingBrief: CatchUpBrief = {
  ...quietBrief,
  headline: { text: "", state: "pending" },
};
