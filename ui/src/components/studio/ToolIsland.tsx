import {
  IconRobot,
  IconTerminal2,
  IconUserCheck,
  IconGavel,
  IconNote,
  IconDots,
} from "@tabler/icons-react";

export type CanvasTool = "select" | "move" | "box" | "connect" | "note";

export interface AddBarProps {
  /** Click on Agent / Command / Approval / Judge. */
  onAddStep(kind: string): void;
  /** Click on Note. */
  onAddNote(): void;
  /** Click on More. */
  onMoreSteps(): void;
  disabled: boolean;
  /** The app-shell phone band (< 768px): the bar scrolls sideways. */
  narrow?: boolean;
  /** dataTransfer type used when dragging an item onto the canvas. */
  dragType: string;
  /** Called with the kind on dragstart, null on dragend. */
  onDragKind?(kind: string | null): void;
}

/**
 * The add bar (editor-interactions README 1b): replaces the old tool
 * island. Floating bottom-centre, 22px from the bottom; labels always
 * visible; step items drag onto the canvas.
 */
export function AddBar({
  onAddStep,
  onAddNote,
  onMoreSteps,
  disabled,
  narrow = false,
  dragType,
  onDragKind,
}: AddBarProps) {
  const steps = [
    { kind: "agent.acp", label: "Agent", Icon: IconRobot },
    { kind: "process.exec", label: "Command", Icon: IconTerminal2 },
    { kind: "human.approval", label: "Approval", Icon: IconUserCheck },
    { kind: "model.chat", label: "Judge", Icon: IconGavel },
  ];
  const item =
    "flex h-[34px] min-w-0 shrink-0 items-center gap-[6px] rounded-[8px] px-[11px] text-ink-2 hover:bg-disabled-bg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
  return (
    <div
      data-testid="add-bar"
      role="toolbar"
      aria-label="Add to canvas"
      className={`absolute bottom-[22px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-[2px] rounded-[12px] border border-fill-edge bg-surface p-[5px] shadow-[var(--shadow-pop)] ${
        narrow ? "max-w-[calc(100%-24px)] overflow-x-auto" : ""
      }`}
    >
      {steps.map(({ kind, label, Icon }) => (
        <button
          key={kind}
          type="button"
          disabled={disabled}
          draggable
          aria-label={label}
          data-testid={`add-bar-${kind}`}
          onClick={() => onAddStep(kind)}
          onDragStart={(event) => {
            event.dataTransfer.setData(dragType, kind);
            event.dataTransfer.effectAllowed = "copy";
            onDragKind?.(kind);
          }}
          onDragEnd={() => onDragKind?.(null)}
          className={`${item} ${narrow ? "min-h-[44px]" : ""}`}
        >
          <Icon size={17} stroke={1.5} className="shrink-0" aria-hidden />
          <span className="whitespace-nowrap text-[13px]">{label}</span>
        </button>
      ))}
      <div className="mx-[4px] h-[20px] w-px shrink-0 bg-line" />
      <button
        type="button"
        disabled={disabled}
        aria-label="Note"
        data-testid="add-bar-note"
        onClick={onAddNote}
        className={`${item} ${narrow ? "min-h-[44px]" : ""}`}
      >
        <IconNote size={17} stroke={1.5} className="shrink-0" aria-hidden />
        <span className="whitespace-nowrap text-[13px]">Note</span>
        <span className="font-mono text-[10.5px] text-muted">N</span>
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-label="More steps…"
        data-testid="add-bar-more"
        onClick={onMoreSteps}
        className={`${item} ${narrow ? "min-h-[44px]" : ""}`}
      >
        <IconDots size={17} stroke={1.5} className="shrink-0" aria-hidden />
        <span className="whitespace-nowrap text-[13px]">More</span>
      </button>
    </div>
  );
}
