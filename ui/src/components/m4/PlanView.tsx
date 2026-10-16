/**
 * PlanView — a plan a person can read before they decide.
 *
 * A gate's `summary` carries the planner node's output as one JSON string
 * (`{"goal":…,"steps":[{"actions":…,"done_when":…,"id":1,"title":…}],"risks":…}`)
 * and printed raw it is a wall of escaped text — `live-run-inspector.png`. The
 * Approve/Reject call is made on that text (`01` invariant 10: a rejection
 * fails the run), so the payload is decoded into the shape of a plan: goal as a
 * heading line, context as a paragraph, steps as an ordered list with their
 * actions and "done when", criteria and risks as short lists.
 *
 * Nothing is dropped on the way. Keys this view does not know stay reachable in
 * a collapsed "other fields" block, a payload that is not JSON at all renders
 * as the text it is (whitespace preserved, clamped with "show all"), and a
 * value of the wrong shape (a `steps` object, a non-string `goal`) falls back
 * to the JSON block rather than disappearing.
 */
import { useMemo, useState } from "react";

/** Plain-text arm: lines shown before "show all". */
const PLAIN_LINES = 12;
/** The `context` paragraph's collapsed height in lines. */
const CONTEXT_LINES = 4;
/** Characters per line used to decide a "more" is needed. The clamp is done by
 * CSS, which jsdom does not run, so a length test is the only signal a test (or
 * a server-side render) has. At the inspector's column width (~45rem of text at
 * 12.5px) a line is roughly this long. */
const CHARS_PER_LINE = 45;

/** Keys with a rendering of their own; everything else is "other fields". */
const KNOWN_KEYS = new Set(["goal", "context", "steps", "acceptance_criteria", "risks"]);

export interface PlanViewProps {
  /** The payload — a plan document, or the plain text a node served instead. */
  text: string;
  className?: string;
}

/** A parsed plan, with the keys this view knows lifted out and the rest kept. */
interface PlanShape {
  goal: string | null;
  context: string | null;
  steps: unknown[] | null;
  criteria: unknown[] | null;
  risks: unknown[] | null;
  other: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The plan in `text`, or null when it is not a JSON object. Values of an
 * unexpected shape are demoted to `other`, so they stay on screen as JSON. */
export function parsePlan(text: string): PlanShape | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;

  const other: Record<string, unknown> = {};
  let goal: string | null = null;
  let context: string | null = null;
  let steps: unknown[] | null = null;
  let criteria: unknown[] | null = null;
  let risks: unknown[] | null = null;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "goal" && typeof value === "string") goal = value;
    else if (key === "context" && typeof value === "string") context = value;
    else if (key === "steps" && Array.isArray(value)) steps = value;
    else if (key === "acceptance_criteria" && Array.isArray(value)) criteria = value;
    else if (key === "risks" && Array.isArray(value)) risks = value;
    else if (KNOWN_KEYS.has(key)) continue; // same key, wrong shape → JSON below
    else other[key] = value;
  }
  return { goal, context, steps, criteria, risks, other };
}

/**
 * A gate summary that is `title text` + `plan JSON` glued into one string
 * (`samplePipeline`: `"Plan for …\n${{ nodes.plan.outputs.plan }}\n"`). The
 * split happens at the first `{` only when everything after it really parses as
 * a JSON object — a prose summary that merely contains a brace is left alone.
 */
export function splitPlanText(text: string): { title: string | null; body: string } {
  const at = text.indexOf("{");
  if (at < 0) return { title: null, body: text };
  const body = text.slice(at);
  if (!parsePlan(body)) return { title: null, body: text };
  const title = text.slice(0, at).trim();
  return { title: title === "" ? null : title, body };
}

/** A step's headline: its `title`, or the step itself as JSON if it has none. */
function stepTitle(step: unknown): string {
  if (typeof step === "string") return step;
  if (isPlainObject(step) && typeof step.title === "string") return step.title;
  if (typeof step === "object" && step !== null) return JSON.stringify(step);
  return String(step);
}

/** A list payload's items as strings; anything not a string keeps its JSON. */
function itemsOf(value: unknown[] | null): string[] {
  if (!value) return [];
  return value.map((item) =>
    typeof item === "string"
      ? item
      : isPlainObject(item) || Array.isArray(item)
        ? JSON.stringify(item)
        : String(item),
  );
}

/** `actions` on a step: an array, a single string, or nothing. */
function actionsOf(step: unknown): string[] {
  if (!isPlainObject(step)) return [];
  const actions = step.actions;
  if (Array.isArray(actions)) return itemsOf(actions);
  if (typeof actions === "string") return [actions];
  return [];
}

/** Fields on a step this view does not render, kept for the collapsed block.
 * A scalar `id` is known too — the ordered list already numbers the step — so it
 * never fills the block on its own; a non-scalar `id` stays there so nothing is
 * dropped. */
function stepOther(step: unknown): Record<string, unknown> {
  if (!isPlainObject(step)) return {};
  const known = new Set(["title", "actions", "done_when"]);
  return Object.fromEntries(
    Object.entries(step).filter(([key, value]) => {
      if (known.has(key)) return false;
      if (key === "id" && isStepId(value)) return false;
      return true;
    }),
  );
}

function isStepId(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

/** The step's own `id` when it disagrees with its position in the list — the
 * number printed for `1.`/`2.` already covers the ordinary case. */
function stepIdNote(step: unknown, index: number): string | null {
  if (!isPlainObject(step) || !isStepId(step.id)) return null;
  const id = String(step.id);
  return id === String(index + 1) ? null : `id ${id}`;
}

function doneWhenOf(step: unknown): string | null {
  if (isPlainObject(step) && typeof step.done_when === "string") return step.done_when;
  return null;
}

/* ---------------------------------------------------------------- component */

export function PlanView({ text, className = "" }: PlanViewProps) {
  const plan = useMemo(() => parsePlan(text), [text]);

  if (!plan) return <PlainText text={text} className={className} />;

  const otherCount = Object.keys(plan.other).length;
  return (
    <div className={`space-y-[8px] ${className}`} data-testid="plan-view">
      {plan.goal ? (
        <p className="text-[13.5px] leading-[20px] font-semibold" data-testid="plan-goal">
          {plan.goal}
        </p>
      ) : null}
      {plan.context !== null ? <PlanContext text={plan.context} /> : null}
      {plan.steps !== null ? <PlanSteps steps={plan.steps} /> : null}
      {plan.criteria !== null ? (
        <PlanList
          label="acceptance criteria"
          testid="plan-criteria"
          items={itemsOf(plan.criteria)}
        />
      ) : null}
      {plan.risks !== null ? (
        <PlanList label="risks" testid="plan-risks" items={itemsOf(plan.risks)} />
      ) : null}
      {otherCount > 0 ? (
        <RestBlock label="other fields" count={otherCount} value={plan.other} testid="plan-other" />
      ) : null}
    </div>
  );
}

/** The `context` paragraph: muted, four lines, and a "more" that only appears
 * when there is a more to give. */
function PlanContext({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clamped =
    text.length > CONTEXT_LINES * CHARS_PER_LINE || text.split("\n").length > CONTEXT_LINES;
  return (
    <div data-testid="plan-context-block">
      <p
        className={`text-[12.5px] leading-[18px] whitespace-pre-wrap break-words text-ink-2 ${
          open || !clamped ? "" : "line-clamp-4"
        }`}
        data-testid="plan-context"
      >
        {text}
      </p>
      {clamped ? (
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className="font-mono text-[10.5px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="plan-context-more"
        >
          {open ? "less" : "more"}
        </button>
      ) : null}
    </div>
  );
}

/** The plan as an ordered list: number, title, what it does, what finishes it. */
function PlanSteps({ steps }: { steps: unknown[] }) {
  if (steps.length === 0) {
    return (
      <p className="font-mono text-[10.5px] text-muted" data-testid="plan-steps-empty">
        steps: none served
      </p>
    );
  }
  return (
    <div>
      <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
        steps
      </p>
      <ol className="mt-[4px] space-y-[6px]" data-testid="plan-steps">
        {steps.map((step, index) => {
          const actions = actionsOf(step);
          const doneWhen = doneWhenOf(step);
          const other = stepOther(step);
          const otherCount = Object.keys(other).length;
          const idNote = stepIdNote(step, index);
          return (
            <li key={index} className="flex gap-[6px]" data-testid={`plan-step-${index + 1}`}>
              <span
                aria-hidden
                className="mt-[1px] w-[14px] shrink-0 font-mono text-[11px] text-muted"
              >
                {index + 1}.
              </span>
              <div className="min-w-0 space-y-[3px]">
                <p className="text-[12.5px] leading-[18px] font-semibold">
                  {stepTitle(step)}
                  {idNote ? (
                    <span
                      className="ml-[6px] font-mono text-[10px] font-normal text-faint"
                      data-testid={`plan-step-id-${index + 1}`}
                    >
                      {idNote}
                    </span>
                  ) : null}
                </p>
                {actions.length > 0 ? (
                  <ul className="space-y-[2px]" data-testid={`plan-step-actions-${index + 1}`}>
                    {actions.map((action, actionIndex) => (
                      <li
                        key={actionIndex}
                        className="flex gap-[6px] text-[12px] leading-[17px] text-ink-2"
                      >
                        <span aria-hidden className="text-faint">
                          &middot;
                        </span>
                        <span className="break-words">{action}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {doneWhen ? (
                  <p
                    className="text-[11.5px] leading-[16px] text-muted"
                    data-testid={`plan-step-done-when-${index + 1}`}
                  >
                    done when {doneWhen}
                  </p>
                ) : null}
                {otherCount > 0 ? (
                  <RestBlock
                    label="other fields"
                    count={otherCount}
                    value={other}
                    testid={`plan-step-other-${index + 1}`}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** `acceptance_criteria` / `risks`: a short bulleted list under a mono label. */
function PlanList({ label, testid, items }: { label: string; testid: string; items: string[] }) {
  return (
    <div>
      <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="mt-[4px] font-mono text-[10.5px] text-muted" data-testid={`${testid}-empty`}>
          none served
        </p>
      ) : (
        <ul className="mt-[4px] space-y-[2px]" data-testid={testid}>
          {items.map((item, index) => (
            <li key={index} className="flex gap-[6px] text-[12px] leading-[17px] text-ink-2">
              <span aria-hidden className="text-faint">
                &middot;
              </span>
              <span className="break-words">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Keys with no rendering of their own, and any step fields this view does not
 * name. Collapsed by default (the reader came for the plan, not a JSON dump) but
 * one honest click away, shown as the JSON it is — so "readable" is never also
 * "lossy".
 */
function RestBlock({
  label,
  count,
  value,
  testid,
}: {
  label: string;
  count: number;
  value: unknown;
  testid: string;
}) {
  const [open, setOpen] = useState(false);
  const contentId = `${testid}-json`;
  return (
    <div data-testid={testid}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex items-center gap-[6px] font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase hover:text-ink"
      >
        <span aria-hidden>{open ? "\u25be" : "\u25b8"}</span>
        {label} ({count})
      </button>
      <pre
        id={contentId}
        hidden={!open}
        className="mt-[4px] max-h-64 overflow-auto rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[16px]"
        data-testid={`${testid}-json`}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/**
 * The fallback arm: a payload that is not a JSON object is text, and text is
 * what gets shown — whitespace preserved, clamped to a dozen lines with the
 * whole thing behind "show all". A gate that carries prose instead of a plan is
 * still decidable.
 */
function PlainText({ text, className }: { text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const tooLong = lines.length > PLAIN_LINES || text.length > PLAIN_LINES * CHARS_PER_LINE;
  const shown = open || !tooLong ? text : lines.slice(0, PLAIN_LINES).join("\n");
  return (
    <div className={className} data-testid="plan-view-plain">
      <div
        className={`text-[13px] leading-[19px] break-words whitespace-pre-wrap ${
          open || !tooLong ? "" : "line-clamp-12"
        }`}
        data-testid="plan-plain-text"
      >
        {shown}
      </div>
      {tooLong ? (
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className="font-mono text-[10.5px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="plan-plain-show-all"
        >
          {open ? "show less" : `show all (${lines.length} lines)`}
        </button>
      ) : null}
    </div>
  );
}
