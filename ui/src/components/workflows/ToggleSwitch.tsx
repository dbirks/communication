/**
 * ToggleSwitch — the design's on/off control for a trigger or a schedule, in
 * the one shape every screen uses: a 28×16 pill track with a knob, `on` /
 * `paused` written beside it in mono, all on one line.
 *
 * It began as the private switch of `RepoWorkflows` (2e's STARTS WHEN rows); it
 * is shared now because the same control stands on the workflow page's Triggers
 * rows, on the issue-trigger rows and on the project's schedule rows — and rows
 * whose switches look different from each other read as two products.
 *
 * Why a native checkbox wearing `role="switch"`:
 * - The value IS a boolean the PATCH carries, so the element stays the honest
 *   `checked` control: `el.checked` is the truth a test can read, Playwright's
 *   `toBeChecked`/`isChecked` answer from it, and a keyboard user gets the
 *   native space-toggle.
 * - `role="switch"` + `aria-checked` is what the control MEANS — an on/off
 *   toggle with an immediate effect, not a form field you submit — and it is
 *   what the suites locate it by (`getByRole("switch", { name: … })`).
 * - `styles/tokens.css`'s phone floor grows `button`s and text inputs to 44px
 *   and EXEMPTS `input[type=checkbox]`, so the track can never be stretched
 *   into the tall blue oval the pass-2 review caught at 390
 *   (2c-issue-trigger-saved, 2c-schedule-trigger-saved, 2e-triggers-paused).
 *   The LABEL around it is what the same stylesheet grows to 44px — the tap
 *   target gets bigger, the pill does not.
 *
 * The state travels as colour AND as a word (rule 04: never colour alone).
 */
export interface ToggleSwitchProps {
  /** The value shown — the caller's optimistic state is its own business. */
  checked: boolean;
  /** The switch's own test id. */
  testid: string;
  /** Accessible name. Absent = the state names themselves (`pause this
   * trigger` / `turn this trigger on`), which is what 2e's rows and the
   * emulator's `getByRole("switch", { name: /pause this trigger/i })` ask for. */
  label?: string;
  onChange(next: boolean): void;
  /** The state word's test id; `${testid}-state` by default. */
  stateTestid?: string;
  /** The words beside the pill; `on` / `paused` is the product's pair. */
  stateWords?: [on: string, off: string];
  /** The accessible name per state, for a row that would rather name the
   * thing it switches (`schedule <slug> enabled` stays true to its API). */
  labels?: [on: string, off: string];
}

/** The track: a fixed 28×16 box with a 12px knob 2px inside it, the knob's
 * left edge the only thing that moves. `appearance-none` because the platform
 * checkbox would otherwise paint over it. */
const TRACK =
  "relative h-[16px] w-[28px] shrink-0 grow-0 basis-[28px] cursor-pointer appearance-none rounded-full border transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ring " +
  "before:absolute before:top-[2px] before:block before:h-3 before:w-3 before:rounded-full before:bg-surface before:transition-[left]";

export function ToggleSwitch({
  checked,
  testid,
  label,
  onChange,
  stateTestid,
  stateWords = ["on", "paused"],
  labels,
}: ToggleSwitchProps) {
  const [onWord, offWord] = stateWords;
  const [onLabel, offLabel] = labels ?? ["pause this trigger", "turn this trigger on"];
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-[6px] whitespace-nowrap">
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label ?? (checked ? onLabel : offLabel)}
        checked={checked}
        data-testid={testid}
        onChange={(event) => onChange(event.target.checked)}
        className={`${TRACK} ${
          checked
            ? "border-accent-edge bg-accent before:left-[14px]"
            : "border-line-strong bg-fill before:left-[2px]"
        }`}
      />
      <span
        className="shrink-0 whitespace-nowrap font-mono text-[11px] text-ink"
        data-testid={stateTestid ?? `${testid}-state`}
      >
        {checked ? onWord : offWord}
      </span>
    </label>
  );
}
