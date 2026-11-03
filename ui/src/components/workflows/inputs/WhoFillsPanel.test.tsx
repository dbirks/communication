/**
 * WhoFillsPanel's warning rows, on their own (design 1j, ADR-0066).
 *
 * The contract rcn-1j review defect 3 settled: a server fill warning reaches
 * the author TWICE, in two different registers.
 *
 *  • the LINE is one human sentence composed from the warning's structured
 *    fields — no fact uuid, no repository handle, no ADR citation in the
 *    reading line;
 *  • the RAW server sentence is never dropped: it rides that same row's
 *    `title` tooltip (and its `data-server-says` twin) for whoever debugs the
 *    form, verbatim, quoted input name and `ADR-0066` tail included.
 *
 * The panel speaks for every row that carries a warning — the trigger row the
 * warning names, and the orphan block's lines for a trigger the reads no
 * longer show — so the tooltip is pinned here once per shape rather than
 * once per trigger kind in the tab's own tests.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

import { projectFixture } from "../../../test/fakes";
import { wireAssignmentList } from "../../../test/fixtures/m4/wire";
import type { Schedule } from "../../../api/pipelines";
import type { IssueTrigger } from "../../../api/useIssueTriggers";
import type { UsedInGroup } from "../../../pages/workflow/useUsedIn";
import type { components } from "../../../api/schema";
import type { DraftInputSpec } from "./inputDoc";
import { WhoFillsPanel } from "./WhoFillsPanel";

type ValidateWarning = components["schemas"]["ValidateWarning"];

const WIRE_USER = "01987b10-0000-7000-8000-abcdef012345";
const SCHEDULE_ID = "01987b22-0005-7000-8000-abcdef012345";
const TRIGGER_ID = "01987b22-0006-7000-8000-abcdef012345";
const GONE_TRIGGER_ID = "01987b22-0007-7000-8000-abcdef012345";

const schedule: Schedule = {
  id: SCHEDULE_ID,
  project_id: projectFixture.id,
  assignment_id: wireAssignmentList.assignments[0].id,
  cron_expr: "0 2 * * *",
  inputs: {},
  enabled: true,
  next_run_at: "2099-01-02T06:00:00Z",
  version: 1,
  created_by: WIRE_USER,
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-27T06:00:00Z",
};

const issueTrigger: IssueTrigger = {
  id: TRIGGER_ID,
  project_id: projectFixture.id,
  assignment_id: wireAssignmentList.assignments[0].id,
  repository_id: "01987b22-0002-7000-8000-abcdef012345",
  event: "labeled",
  labels: ["factory"],
  inputs: {},
  issue_input: "issue",
  enabled: true,
  version: 1,
  created_by: WIRE_USER,
  created_at: "2026-07-20T09:00:00Z",
  updated_at: "2026-07-20T09:00:00Z",
};

const groups: UsedInGroup[] = [
  {
    project: projectFixture,
    assignment: wireAssignmentList.assignments[0],
    repositories: [],
    schedules: [schedule],
    issueTriggers: [issueTrigger],
    runs: [],
    triggersArrived: true,
    triggersError: false,
  },
];

const specs: DraftInputSpec[] = [
  { name: "ticket", type: "text", required: true },
  { name: "issue", type: "github_issue", required: false },
];

/** The server's own sentence, shaped like `internal/api`'s: an operator line
 * with the trigger's fact name, kind, uuid and the ADR it comes from. */
function serverLine(name: string, kind: string, id: string, input: string): string {
  return (
    `trigger ${name} (${kind}, ${id}) cannot fill required input "${input}" and it has ` +
    "no default; a run it fires will be refused at the start (ADR-0066)"
  );
}

const warnings: ValidateWarning[] = [
  {
    code: "input_unfillable_by_trigger",
    source: "trigger",
    message: serverLine("server #labeled", "issue", TRIGGER_ID, "ticket"),
    trigger_id: TRIGGER_ID,
    trigger_kind: "issue",
    trigger_label: "labeled",
    input: "ticket",
  },
  {
    code: "input_unfillable_by_trigger",
    source: "trigger",
    message: serverLine("* * * * *", "schedule", SCHEDULE_ID, "issue"),
    trigger_id: SCHEDULE_ID,
    trigger_kind: "schedule",
    trigger_label: "* * * * *",
    input: "issue",
  },
  {
    code: "trigger_issue_input_unmapped",
    source: "trigger",
    message: serverLine("server #opened", "issue", GONE_TRIGGER_ID, "removed"),
    trigger_id: GONE_TRIGGER_ID,
    trigger_kind: "issue",
    trigger_label: "opened",
    input: "removed",
  },
];

function mount() {
  render(
    <WhoFillsPanel
      specs={specs}
      groups={groups}
      loading={false}
      error={false}
      warnings={warnings}
    />,
  );
}

describe("WhoFillsPanel warning rows", () => {
  it("keep the raw server sentence in the title tooltip of every warning row", async () => {
    mount();
    const rows = [
      await screen.findByTestId(`who-fills-warn-${TRIGGER_ID}-ticket`),
      await screen.findByTestId(`who-fills-warn-${SCHEDULE_ID}-issue`),
      await screen.findByTestId(`who-fills-warn-${GONE_TRIGGER_ID}-removed`),
    ];
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      const warning = warnings[index]!;
      // The tooltip carries the server's WHOLE line — the quoted input name,
      // the fact uuid and the ADR tail included — not a paraphrase of it.
      expect(row.getAttribute("title")).toBe(warning.message);
      expect(row.getAttribute("title")).toContain(`cannot fill required input "${warning.input}"`);
      expect(row.getAttribute("title")).toContain("ADR-0066");
      // …and the same sentence is readable off the element without a hover.
      expect(row.getAttribute("data-server-says")).toBe(warning.message);
    }
  });

  it("keeps the fact uuid, the repository handle and the ADR number out of the reading line", async () => {
    mount();
    const line = await screen.findByTestId(`who-fills-warn-${TRIGGER_ID}-ticket`);
    expect(line.textContent).toBe(
      "! ticket is required and the issue trigger 'labeled' can't fill it",
    );
    const triggerRow = screen.getByTestId(`who-fills-issue-${TRIGGER_ID}`);
    expect(triggerRow.textContent).not.toContain(TRIGGER_ID);
    expect(triggerRow.textContent).not.toContain("ADR-0066");
    expect(triggerRow.textContent).not.toContain("server #labeled");
  });
});
