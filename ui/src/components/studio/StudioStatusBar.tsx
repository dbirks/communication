/**
 * StudioStatusBar — design 1g: the 30px status strip under the Studio canvas.
 *
 * The header keeps only the canvas / YAML control and the action row; the
 * publish reason moved here (it used to truncate inside the 52px header), and
 * the strip answers two questions at a glance: how many steps the draft holds,
 * and what publishing would say.
 */
interface StudioStatusBarProps {
  /** The parsed draft's step count (the graph's node list). */
  stepCount: number;
  /** Unsaved local edits: the strip says so and the publish gate refuses. */
  dirty: boolean;
  /** The page's publish-gate verdict in words; null = ready to publish. */
  publishReason: string | null;
}

export function StudioStatusBar({ stepCount, dirty, publishReason }: StudioStatusBarProps) {
  return (
    <div
      className="flex h-[30px] shrink-0 items-center gap-[12px] border-t border-line bg-surface px-4 font-mono text-[10.5px] text-faint"
      data-testid="studio-status-bar"
    >
      <span data-testid="studio-status-bar-summary">
        {stepCount} {stepCount === 1 ? "step" : "steps"} · {dirty ? "unsaved changes" : "saved"}
      </span>
      <span className="ml-auto truncate" data-testid="studio-publish-reason" title={publishReason ?? ""}>
        {publishReason ?? "ready to publish"}
      </span>
    </div>
  );
}
