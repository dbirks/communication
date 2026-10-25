/**
 * StudioStatusBar — design 1g: the 30px status strip under the Studio canvas.
 *
 * The header keeps only the canvas / YAML control and the action row. The
 * strip answers the questions the header no longer carries: how many steps
 * the draft holds, the last server validation verdict (the old header chip),
 * the diff against the newest published revision (`diff vs r<N>`, the old
 * header Diff button), and what publishing would say — a short reason in
 * words, never the long server sentence.
 */
interface StudioStatusBarProps {
  /** The parsed draft's step count (the graph's node list). */
  stepCount: number;
  /** Unsaved local edits: the strip says so and the publish gate refuses. */
  dirty: boolean;
  /** The draft's last server validation verdict in words; null = never validated. */
  validation: string | null;
  /** The diff affordance's label (e.g. `diff vs r3`); null = no revision yet. */
  diffLabel: string | null;
  onDiff(): void;
  /** The page's publish-gate verdict in short words; null = ready to publish. */
  publishReason: string | null;
}

export function StudioStatusBar({
  stepCount,
  dirty,
  validation,
  diffLabel,
  onDiff,
  publishReason,
}: StudioStatusBarProps) {
  return (
    <div
      className="flex h-[30px] shrink-0 items-center gap-[8px] overflow-hidden border-t border-line bg-surface px-4 font-mono text-[10.5px] text-faint md:gap-[12px]"
      data-testid="studio-status-bar"
    >
      <span className="shrink-0 truncate" data-testid="studio-status-bar-summary">
        {stepCount} {stepCount === 1 ? "step" : "steps"} · {dirty ? "unsaved changes" : "saved"}
      </span>
      {/* Pass 3 #1: below md the strip carries ONLY the count/state left and
          the short reason right — one line, never wrapped or clipped. The
          validation verdict and the diff link stay on md+ (e2e clicks
          `studio-diff` at desktop widths). */}
      <span
        className="hidden shrink-0 md:inline"
        data-testid="studio-validation-chip"
        title={validation ?? ""}
      >
        {validation ?? "not validated"}
      </span>
      <button
        type="button"
        onClick={onDiff}
        data-testid="studio-diff"
        className="hidden shrink-0 text-muted underline decoration-line underline-offset-2 hover:text-ink md:inline"
      >
        {diffLabel ?? "diff"}
      </button>
      <span
        className="ml-auto min-w-0 shrink truncate text-right"
        data-testid="studio-publish-reason"
        title={publishReason ?? ""}
      >
        {publishReason ?? "ready to publish"}
      </span>
    </div>
  );
}
