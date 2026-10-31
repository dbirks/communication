/**
 * StudioStatusBar — design 1g: the 30px status strip under the Studio canvas.
 *
 * The header keeps only the canvas / YAML control and the action row. The
 * strip answers the questions the header no longer carries: how many steps
 * the draft holds, the last server validation verdict (the old header chip),
 * the diff against the newest published revision (`diff vs r<N>`, the old
 * header Diff button), and what publishing would say — a short reason in
 * words, never the long server sentence.
 *
 * What the strip does NOT say is `unsaved`: the header's draft chip is the one
 * place that word appears (2026-10-30 review, 1g item 4 — it used to print here
 * too, and once more beside the chip, three times over one draft).
 */
interface StudioStatusBarProps {
  /** The parsed draft's step count (the graph's node list). */
  stepCount: number;
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
  validation,
  diffLabel,
  onDiff,
  publishReason,
}: StudioStatusBarProps) {
  return (
    // 390 reflow (pass-2 review, 1g-studio): the strip is a fixed 30px row at
    // md and above, and a WRAPPING strip below it — the short publish reason
    // (“to publish: save, then validate”) used to truncate to
    // “to publish: va…”, which is the one thing a status bar may never do.
    <div
      className="flex min-h-[30px] flex-wrap items-center gap-x-[8px] gap-y-[2px] border-t border-line bg-surface px-4 py-[5px] font-mono text-[10.5px] text-faint md:h-[30px] md:flex-nowrap md:gap-[12px] md:overflow-hidden md:py-0"
      data-testid="studio-status-bar"
    >
      <span className="shrink-0" data-testid="studio-status-bar-summary">
        {stepCount} {stepCount === 1 ? "step" : "steps"}
      </span>
      {/* The strip carries count/state left, the validation verdict, the
          diff link and the short reason right at EVERY width (390 reflow:
          nothing is display:none on the phone, nothing truncates below md).
          e2e clicks `studio-diff` at desktop widths. */}
      <span className="shrink-0" data-testid="studio-validation-chip" title={validation ?? ""}>
        {validation ?? "not validated"}
      </span>
      <button
        type="button"
        onClick={onDiff}
        data-testid="studio-diff"
        title={diffLabel ?? "compare the draft with the published revisions"}
        className="shrink-0 text-muted underline decoration-line underline-offset-2 hover:text-ink"
      >
        {/* A verb, not a bare noun (2026-10-30 copy review, 1g item 9): the
            strip read `4 steps · not validated · diff`, where `diff` looked
            like a third state of the draft rather than the thing you can press.
            The revision it compares against is the button's title. */}
        view diff
      </button>
      {/* The phone gives the reason a line of its own (right-aligned, full
          width, never truncated); md keeps the design's right-hand slot. */}
      <span
        className="w-full text-right md:ml-auto md:w-auto md:min-w-0 md:shrink md:truncate"
        data-testid="studio-publish-reason"
        title={publishReason ?? ""}
      >
        {publishReason ?? "ready to publish"}
      </span>
    </div>
  );
}
