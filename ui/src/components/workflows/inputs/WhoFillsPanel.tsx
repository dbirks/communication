/**
 * WhoFillsPanel — the right rail of the Inputs tab (design 1j): one row per
 * way the workflow can start, read from its assignments, schedules and issue
 * triggers, and the draft's own validate warnings.
 *
 * The fill rules are ADR-0066's, not an invention of this panel: a hand start
 * fills every input from the generated form; an issue trigger fills the
 * `github_issue` input it names (or the revision's single one, implicitly);
 * a schedule fills nothing — defaults carry it. The “a schedule can't fill
 * it” line is NEVER computed here: it is the server's `input_unfillable_by_
 * trigger` warning verbatim, shown on the waiting-pale row it belongs to.
 * With no warning from the server the schedule row simply states the ADR's
 * fact (it fills no inputs) rather than guessing which inputs would suffer.
 */
import { Panel } from "../../ds/Panel";
import { STATES } from "../../ds/states";
import { cronInWords } from "../../../lib/cronText";
import type { DraftInputSpec } from "./inputDoc";
import type { UsedInGroup } from "../../../pages/workflow/useUsedIn";
import type { components } from "../../../api/schema";

type ValidateWarning = components["schemas"]["ValidateWarning"];

export interface WhoFillsPanelProps {
  specs: readonly DraftInputSpec[];
  groups: readonly UsedInGroup[];
  loading: boolean;
  error: boolean;
  /** The draft's last validate body's warnings (ADR-0066). Absent until the
   * server has spoken — nothing here substitutes a client-side guess. */
  warnings: readonly ValidateWarning[] | undefined;
}

/** The required inputs with no default — the ones the by-hand form must ask
 * for; an input with a default is “prefilled”. */
function askNames(specs: readonly DraftInputSpec[]): string[] {
  return specs
    .filter((spec) => spec.required && spec.default === undefined)
    .map((spec) => spec.name);
}

function scheduleWords(cron: string): string {
  const raw = cron.trim();
  const words = cronInWords(raw).trim();
  return words === "" || words === raw ? raw : words;
}

const ROW = "px-[12px] py-[8px]";
const TITLE = "text-[12.5px] font-semibold text-ink";
const BODY = "mt-[2px] text-[12px] text-muted";

export function WhoFillsPanel({ specs, groups, loading, error, warnings }: WhoFillsPanelProps) {
  const names = askNames(specs);
  const issueSpecs = specs.filter((spec) => spec.type === "github_issue");
  return (
    <Panel title="WHO FILLS THE INPUTS" headingId="who-fills-heading" headingLevel={2}>
      <div className="divide-y divide-line" data-testid="who-fills">
        {loading ? (
          <p
            className={`${ROW} font-mono text-[10.5px] text-faint`}
            data-testid="who-fills-loading"
          >
            checking how this workflow starts…
          </p>
        ) : null}
        {!loading && error ? (
          <p
            className={`${ROW} font-mono text-[10.5px] text-st-failed-tag-fg`}
            data-testid="who-fills-error"
          >
            the trigger reads failed — who fills what is unknown
          </p>
        ) : null}
        {!loading && !error && groups.length === 0 ? (
          <p className={`${ROW} text-[12px] text-muted`} data-testid="who-fills-empty">
            Nothing can start it yet — use it in a repo, and the starts show here.
          </p>
        ) : null}
        {!loading && !error && groups.length > 0 ? (
          <div className={ROW} data-testid="who-fills-hand">
            <span className={TITLE}>Run by hand</span>
            <p className={BODY} data-testid="who-fills-hand-line">
              {specs.length === 0
                ? "No inputs — the form asks for nothing."
                : names.length === 0
                  ? "Nothing required — defaults cover every input."
                  : `Form asks for ${names.join(", ")}; others prefilled.`}
            </p>
          </div>
        ) : null}
        {!loading && !error
          ? groups.flatMap((group) =>
              group.issueTriggers
                .filter((trigger) => trigger.enabled)
                .map((trigger) => {
                  const mapped =
                    (trigger.issue_input ?? "") !== ""
                      ? trigger.issue_input
                      : issueSpecs.length === 1
                        ? issueSpecs[0].name
                        : null;
                  const eventWord = trigger.event === "opened" ? "opened" : "labeled";
                  return (
                    <div
                      key={trigger.id}
                      className={ROW}
                      data-testid={`who-fills-issue-${trigger.id}`}
                    >
                      <span className={TITLE}>
                        {`Issue ${eventWord}`}
                        {trigger.labels.map((label) => (
                          <span
                            key={label}
                            className="ml-[6px] inline-block rounded-[2px] border border-line-strong bg-fill px-[5px] py-[1px] font-mono text-[10.5px] font-normal text-ink-2"
                          >
                            {label}
                          </span>
                        ))}
                      </span>
                      {mapped ? (
                        <p
                          className={`mt-[2px] font-mono text-[11px] text-st-done-strong`}
                          data-testid={`who-fills-issue-line-${trigger.id}`}
                        >
                          {`✓ ${mapped} ← the ${eventWord} issue`}
                        </p>
                      ) : (
                        <p className={BODY} data-testid={`who-fills-issue-line-${trigger.id}`}>
                          {issueSpecs.length === 0
                            ? "the workflow declares no issue input to fill"
                            : "the trigger maps no issue input yet"}
                        </p>
                      )}
                    </div>
                  );
                }),
            )
          : null}
        {!loading && !error
          ? groups.flatMap((group) =>
              group.schedules
                .filter((schedule) => schedule.enabled)
                .map((schedule) => {
                  const warning = (warnings ?? []).find(
                    (entry) =>
                      entry.code === "input_unfillable_by_trigger" &&
                      entry.trigger_id === schedule.id,
                  );
                  return (
                    <div
                      key={schedule.id}
                      className={`${ROW} ${warning ? STATES.waiting.paleBodyBg : ""}`}
                      data-testid={`who-fills-schedule-${schedule.id}`}
                    >
                      <span
                        className={TITLE}
                      >{`Schedule · ${scheduleWords(schedule.cron_expr)}`}</span>
                      {warning ? (
                        <p
                          className={`mt-[2px] font-mono text-[11px] ${STATES.waiting.paleFg}`}
                          data-testid={`who-fills-schedule-line-${schedule.id}`}
                        >
                          {`! ${warning.message}`}
                        </p>
                      ) : (
                        <p
                          className={`mt-[2px] font-mono text-[11px] text-faint`}
                          data-testid={`who-fills-schedule-line-${schedule.id}`}
                        >
                          fills no inputs — required ones start on defaults
                        </p>
                      )}
                    </div>
                  );
                }),
            )
          : null}
      </div>
    </Panel>
  );
}
