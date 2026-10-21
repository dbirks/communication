/**
 * Settings → Layout (3g): how the sidebar looks. Three radio groups —
 * projects mode, ask placement, workflow folders — plus the ⌘K line.
 * Changes apply optimistically through the preferences client (contract C2).
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
  const { prefs, update, saved } = useLayoutPrefs();

  return (
    <div className="space-y-4" data-testid="settings-layout">
      <PrefRadioGroup
        legend="Projects in the sidebar"
        name="projects-mode"
        testid="settings-layout-projects-mode"
        value={prefs.projectsMode}
        onChange={(projectsMode) => update({ projectsMode })}
        options={[
          {
            value: "tree",
            label: "All projects as a tree",
            isDefault: true,
            note: "Every project and repo at once, each with its status flag.",
          },
          {
            value: "switcher",
            label: "Project switcher",
            note: "One project at a time. The sidebar shows only its repos, runs and threads.",
          },
        ]}
      />
      <div className="space-y-1">
        <PrefRadioGroup
          legend="Ask button"
          name="ask-placement"
          testid="settings-layout-ask-placement"
          value={prefs.askPlacement}
          onChange={(askPlacement) => update({ askPlacement })}
          options={[
            {
              value: "sidebar",
              label: "Top of the sidebar",
              isDefault: true,
              note: "Next to New. The popover opens from the left.",
            },
            {
              value: "floating",
              label: "Floating, bottom right",
              note: "Always in the same corner, over any page.",
            },
          ]}
        />
        <p data-testid="settings-layout-chord-k" className="px-2 font-mono text-[11px] text-muted">
          ⌘K always opens the assistant.
        </p>
      </div>
      <PrefRadioGroup
        legend="Workflows in the sidebar"
        name="workflow-folders"
        testid="settings-layout-workflow-folders"
        value={prefs.showWorkflowFolders ? "folders" : "link"}
        onChange={(choice) => update({ showWorkflowFolders: choice === "folders" })}
        options={[
          {
            value: "folders",
            label: "Show folders",
            isDefault: true,
            note: "The workflow folders nest under the Workflows link.",
          },
          {
            value: "link",
            label: "Just the Workflows link",
            note: "One link; the folders live on the Workflows page.",
          },
        ]}
      />
      {saved ? null : (
        <Alert state="info" label="NOT SAVED" testid="settings-layout-not-saved" role="status">
          Not saved: this server doesn&apos;t store preferences yet. The choice applies for this
          session.
        </Alert>
      )}
    </div>
  );
}
