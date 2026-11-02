/**
 * WhoFillsPanel — the right rail of the Inputs tab (design 1j): one row per
 * way the workflow can start, read from its assignments, schedules and issue
 * triggers, and the draft's own validate warnings.
 *
 * The fill rules are ADR-0066's, not an invention of this panel: a hand start
 * fills every input from the generated form; an issue trigger fills the
 * `github_issue` input it names (or the revision's single one, implicitly)
 * plus every name its template inputs carry; a schedule fills nothing but
 * its own inputs — defaults carry the rest. The “can't fill it” lines are
 * NEVER computed here: they are the server's `input_unfillable_by_trigger`
 * warnings verbatim, ONE LINE PER WARNING, shown on the trigger row each
 * warning names (issue triggers included). A trigger row whose warnings fill
 * every required input simply states its fills; a schedule row with no
 * warning states the ADR's fact (it fills no inputs) rather than guessing
 * which inputs would suffer. Warnings whose trigger no longer reads (a row
 * deleted since the last validate) still get one line each under the panel's
 * own “orphan” heading — a server warning is never silently dropped.
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

/** The server's `input_unfillable_by_trigger` warnings for ONE trigger, in
 * the server's own order. Matching is by trigger id alone: the server owns
 * the rule (every trigger kind, every required input with no default), and
 * the panel renders exactly what it said. */
function warningsForTrigger(warnings: readonly ValidateWarning[], triggerId: string) {
  return warnings.filter(
    (entry) => entry.code === "input_unfillable_by_trigger" && entry.trigger_id === triggerId,
  );
}

/** One `!` line per warning — the server's message verbatim. The testid
 * names the trigger AND the input so a journey can pin each warning to its
 * own row; the id part is the warning's own trigger, so the orphan block
 * (whose lines come from several triggers) can never mint two equal ids. */
function warningLines(warnings: readonly ValidateWarning[]) {
  return warnings.map((warning, index) => (
    <p
      key={`${warning.trigger_id ?? "trigger"}-${warning.input ?? "input"}-${index}`}
      className={`mt-[2px] font-mono text-[11px] ${STATES.waiting.paleFg}`}
      data-testid={`who-fills-warn-${warning.trigger_id ?? "trigger"}-${warning.input ?? index}`}
    >
      {`! ${warning.message}`}
    </p>
  ));
}

const ROW = "px-[12px] py-[8px]";
const TITLE = "text-[12.5px] font-semibold text-ink";
const BODY = "mt-[2px] text-[12px] text-muted";

export function WhoFillsPanel({ specs, groups, loading, error, warnings }: WhoFillsPanelProps) {
  const names = askNames(specs);
  const issueSpecs = specs.filter((spec) => spec.type === "github_issue");
  const all = warnings ?? [];
  // Every trigger row claims its warnings; whatever is left names a trigger
  // the reads no longer show (deleted since the validate). Those warnings
  // still get a line each — the panel may not drop one on the floor.
  const listed = new Set<string>();
  for (const group of groups) {
    for (const trigger of group.issueTriggers) if (trigger.enabled) listed.add(trigger.id);
    for (const schedule of group.schedules) if (schedule.enabled) listed.add(schedule.id);
  }
  const orphans = all.filter(
    (warning) =>
      warning.code === "input_unfillable_by_trigger" &&
      !(warning.trigger_id !== undefined && listed.has(warning.trigger_id)),
  );
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
                  const triggerWarnings = warningsForTrigger(all, trigger.id);
                  return (
                    <div
                      key={trigger.id}
                      className={`${ROW} ${triggerWarnings.length > 0 ? STATES.waiting.paleBodyBg : ""}`}
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
                      {warningLines(triggerWarnings)}
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
                  const triggerWarnings = warningsForTrigger(all, schedule.id);
                  return (
                    <div
                      key={schedule.id}
                      className={`${ROW} ${triggerWarnings.length > 0 ? STATES.waiting.paleBodyBg : ""}`}
                      data-testid={`who-fills-schedule-${schedule.id}`}
                    >
                      <span
                        className={TITLE}
                      >{`Schedule · ${scheduleWords(schedule.cron_expr)}`}</span>
                      {triggerWarnings.length > 0 ? (
                        warningLines(triggerWarnings)
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
        {!loading && !error && orphans.length > 0 ? (
          <div className={`${ROW} ${STATES.waiting.paleBodyBg}`} data-testid="who-fills-orphans">
            <span className={TITLE}>Warnings without a row</span>
            {warningLines(orphans)}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
