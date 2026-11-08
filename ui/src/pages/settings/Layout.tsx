/**
 * Settings → Layout (3g, redesigned by finding 10).
 *
 * The three radio groups this page used to hold — projects mode, ask
 * placement, workflow folders — are gone: each one was a second sidebar layout,
 * and the 08/10 decisions fixed the answers (always the tree, Ask is the
 * floating ⌘J button, folders are a filter on the Workflows page). The sidebar
 * collapse lives in the sidebar itself (its own chevron), so there is no
 * control left to put here; the page keeps the shortcut line and the honest
 * "this server does not store preferences" note, and `PrefRadioGroup` stays
 * exported because Settings → Assistant uses it.
 */
import type { ReactNode } from "react";
import { Alert } from "../../components/ds/Alert";
import { useLayoutPrefs } from "../../lib/prefs";

export interface PrefOption<T extends string> {
  value: T;
  label: string;
  note?: ReactNode;
  /** Marks the documented default (3g shows it inline after the label). */
  isDefault?: boolean;
}

export interface PrefRadioGroupProps<T extends string> {
  legend: string;
  /** Radio group name — one per section on the page. */
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: PrefOption<T>[];
  testid: string;
}

/**
 * One settings section: an uppercase mono legend and native radios (the
 * keyboard arrows cycle the group; the focus ring uses the standard accent
 * outline). No colour carries meaning on its own: the checked state also
 * carries a glyph and the ink edge.
 */
export function PrefRadioGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  testid,
}: PrefRadioGroupProps<T>) {
  return (
    <fieldset className="space-y-1" data-testid={`${testid}-group`}>
      <legend className="pb-1 font-mono text-[10.5px] font-semibold tracking-[.04em] text-muted uppercase">
        {legend}
      </legend>
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            data-testid={`${testid}-option-${option.value}`}
            className={`flex cursor-pointer items-start gap-2 rounded-[3px] border px-2 py-1.5 ${
              checked ? "border-ink bg-surface" : "border-transparent hover:border-line-strong"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
              className="mt-[3px] size-[13px] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
            <span className="space-y-0.5">
              <span className="block text-[13px] font-medium text-ink">
                <span className={checked ? "" : "font-normal"}>{option.label}</span>
                {option.isDefault ? (
                  <span
                    aria-label="default"
                    className="ml-2 rounded-[2px] border border-line-strong px-1 font-mono text-[10px] font-semibold text-muted"
                  >
                    default
                  </span>
                ) : null}
                {checked ? (
                  <span aria-label="selected" className="ml-2 font-mono text-[11px] text-ink">
                    ✓
                  </span>
                ) : null}
              </span>
              {option.note ? (
                <span className="block text-[12px] leading-[1.45] text-muted">{option.note}</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export default function LayoutSettings() {
  const { saved } = useLayoutPrefs();

  return (
    <div className="space-y-4" data-testid="settings-layout">
      <p data-testid="settings-layout-chord-k" className="px-2 font-mono text-[11px] text-muted">
        ⌘K opens Search · ⌘J opens Ask
      </p>
      <p data-testid="settings-layout-sidebar-note" className="px-2 text-[12px] text-muted">
        The sidebar is always the project tree, and its collapse lives on the sidebar’s own chevron.
      </p>
      {saved ? null : (
        <Alert state="info" label="NOT SAVED" testid="settings-layout-not-saved" role="status">
          Not saved: this server doesn&apos;t store preferences yet. The choice applies for this
          session.
        </Alert>
      )}
    </div>
  );
}
