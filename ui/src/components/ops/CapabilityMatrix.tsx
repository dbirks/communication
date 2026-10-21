/**
 * The 4h "AGENTS · CAPABILITY MATRIX": rows are the launcher cards from
 * `GET /api/v1/launchers` (contract C5 / ADR-0051) and the four columns are
 * the 12-test-strategy compatibility cells.
 *
 * Every cell is evidence-backed server-side: `observed` only from a recorded
 * probe row, `not_supported` only from an observed negative, `not_tested`
 * the default and the only value a missing row may produce (AGENTS.md: the
 * compatibility table is never prefilled with PASS). This component renders
 * exactly what the registry says — no hard-coded matrix — and shows the
 * evidence path in the cell's `title` so an operator can read the probe.
 */
import { useLaunchers } from "../../api/launchers";
import { problemOf } from "../../api/client";
import { capabilityCell, type LauncherCapability } from "../../lib/profiles";
import { Panel } from "../ds/Panel";
import { Spinner } from "../Feedback";

const COLUMNS = [
  { key: "acp_session", label: "ACP session" },
  { key: "resume", label: "resume" },
  { key: "permission_prompts", label: "permission prompts" },
  { key: "nono_required", label: "nono required" },
] as const;

/** Cell colour by result: green pass, red negative, muted unknown — the
 *  glyph + words always say the same thing, colour is only emphasis. */
const RESULT_CLASS: Record<string, string> = {
  observed: "text-st-done-tag-fg",
  not_supported: "text-st-failed-tag-fg",
  not_tested: "text-muted",
};

/** The cell title: the evidence path when recorded, the honest reason when not. */
function cellTitle(capability: LauncherCapability | null): string {
  if (!capability) return "no capability row recorded for this launcher";
  const { result, evidence } = capability;
  if (result === "observed") {
    return evidence ? `Evidence: ${evidence}` : "observed — no evidence path recorded";
  }
  if (result === "not_supported") {
    return evidence
      ? `Observed negative — evidence: ${evidence}`
      : "observed negative — no evidence path recorded";
  }
  return "not tested — no recorded compatibility probe";
}

export function CapabilityMatrix() {
  const launchers = useLaunchers();

  return (
    <Panel title="AGENTS · CAPABILITY MATRIX" headingLevel={2} meta="from compatibility probes">
      <div className="p-[10px]">
        {launchers.isPending ? <Spinner label="Loading launcher registry" /> : null}
        {launchers.error ? (
          <p
            className="font-mono text-[11px] text-st-failed-tag-fg"
            role="alert"
            data-testid="capability-matrix-unavailable"
          >
            × {problemOf(launchers.error).detail || "The launcher registry could not be loaded."}
          </p>
        ) : null}
        {launchers.data === null && !launchers.isPending && !launchers.error ? (
          <p className="font-mono text-[11px] text-ink-2" data-testid="capability-matrix-none">
            · The launcher registry is not served by this server yet, so no capability results are
            shown — nothing here is a pass.
          </p>
        ) : null}
        {launchers.data ? (
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[520px] border-collapse text-[12.5px]"
              data-testid="capability-matrix-table"
            >
              <caption className="sr-only">
                Agent launcher × capability results, recorded by compatibility probes
              </caption>
              <thead>
                <tr className="border-b border-line-strong text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
                  <th scope="col" className="py-1 pr-4">
                    Agent
                  </th>
                  {COLUMNS.map((column) => (
                    <th scope="col" key={column.key} className="py-1 pr-4">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {launchers.data.launchers.map((launcher) => (
                  <tr
                    key={launcher.id}
                    className="border-b border-line-soft last:border-b-0"
                    data-testid={`capability-row-${launcher.id}`}
                  >
                    <td className="py-[5px] pr-4 font-semibold">
                      {launcher.display_name}
                      {!launcher.registered ? (
                        <span className="ml-2 font-mono text-[10.5px] font-normal text-muted">
                          · not registered
                        </span>
                      ) : null}
                    </td>
                    {COLUMNS.map((column) => {
                      const capability = launcher.capabilities.find(
                        (entry) => entry.capability === column.key,
                      );
                      const cell = capability ? capabilityCell(capability) : null;
                      const result: string = capability?.result ?? "not_tested";
                      return (
                        <td
                          key={column.key}
                          className={`py-[5px] pr-4 font-mono text-[11px] ${RESULT_CLASS[result] ?? "text-muted"}`}
                          title={cellTitle(capability ?? null)}
                          data-testid={`capability-cell-${launcher.id}-${column.key}`}
                        >
                          {cell ? (
                            <>
                              <span aria-hidden="true">{cell.glyph}</span> {cell.text}
                            </>
                          ) : (
                            <>
                              <span aria-hidden="true">·</span> not tested
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="mt-2 text-[12px] text-muted" data-testid="capability-matrix-footnote">
          Only results recorded by compatibility probes are shown; a missing probe reads “not
          tested”, never a pass.
        </p>
      </div>
    </Panel>
  );
}
