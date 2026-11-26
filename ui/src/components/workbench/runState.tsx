/**
 * How a run's state reads in the workbench: the app's short word, from the one
 * `SHORT_WORD` table, as a chip (`RunStateChip`) or as plain text
 * (`runStateWord`) on a line that has no room for the chip.
 */
import { StatusChip } from "../ds/Row";
import { RUN_STATE, SHORT_WORD, stateOf, type StateName } from "../ds/states";
import type { RunStatus } from "../../lib/pipeline/contract";

/**
 * A run's state in the app's short word — the same table the overview's run
 * rows and the stage strip print (`SHORT_WORD`), not the wire's status spelled
 * out as "WAITING HUMAN".
 */
export function RunStateChip({
  status,
  testid = "run-status",
}: {
  status: RunStatus;
  testid?: string;
}) {
  const state: StateName = stateOf(RUN_STATE[status]);
  return (
    <StatusChip
      state={state}
      label={SHORT_WORD[state]}
      labelProps={{ "data-testid": testid, role: "status" }}
    />
  );
}

/** The run's own status in the same short word, for a page with no chip — the
 * mono line beside the child run's slug, the tree row, the header chip: one
 * table (`SHORT_WORD`), never the wire's token spelled out as "waiting human". */
export function runStateWord(status: RunStatus): string {
  return SHORT_WORD[stateOf(RUN_STATE[status])];
}
