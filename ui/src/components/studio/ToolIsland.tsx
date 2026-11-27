import {
  IconPointer,
  IconHandStop,
  IconMarquee2,
  IconLine,
  IconNote,
  IconRobot,
  IconTerminal2,
  IconUserCheck,
  IconDots,
} from "@tabler/icons-react";

export type CanvasTool = "select" | "move" | "box" | "connect" | "note";

export function ToolIsland({
  tool,
  onTool,
  onAddStep,
  onMoreSteps,
  disabled,
  narrow = false,
}: {
  tool: CanvasTool;
  onTool(tool: CanvasTool): void;
  onAddStep(kind: string): void;
  onMoreSteps(): void;
  disabled: boolean;
  /** The app-shell phone band (CONTRACT “below 768px”): there the island
   * never widens, hover or no hover (review-1 10-390-1). */
  narrow?: boolean;
}) {
  const tools = [
    { id: "select" as const, label: "Select", key: "V", Icon: IconPointer },
    { id: "move" as const, label: "Move around", key: "H", Icon: IconHandStop },
    { id: "box" as const, label: "Box select", key: "B", Icon: IconMarquee2 },
    { id: "connect" as const, label: "Connect", key: "C", Icon: IconLine },
    // Review-1 09-1280-1 (the review's one blocker): README's island is
    // “Select V, Move around H, Box select B, Connect C, Note N; a separator;
    // then Agent, Command, Approval” — the Note row sits before the separator.
    { id: "note" as const, label: "Note", key: "N", Icon: IconNote },
  ];
  const additions = [
    { kind: "agent.acp", label: "Agent", Icon: IconRobot },
    { kind: "process.exec", label: "Command", Icon: IconTerminal2 },
    { kind: "human.approval", label: "Approval", Icon: IconUserCheck },
  ];
  const row =
    "flex h-[34px] w-full items-center gap-[10px] overflow-hidden rounded-[8px] px-[9px] text-left whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
  return (
    <div
      data-testid="tool-island"
      role="toolbar"
      aria-label="Canvas tools"
      // README “(16, 100)” is viewport px: the top bar is 60px, so the
      // island's top edge sits 40px below the top of the canvas pane (and
      // left 16). Review-1 09-1280-2 measured it at the pane corner.
      //
      // The widening to 176px is gated to a FINE pointer AND off the phone
      // band — review-1 10-390-1, CONTRACT phone “the tool island stays
      // 48px”: a touch device keeps :hover stuck after a tap and focuses the
      // pressed button, so plain `hover:`/`focus-within:` — and the old
      // any-touch-opens-it handler — let a tap widen the island. The island
      // has no toggle of its own, so on touch it simply never widens; the
      // icons and 44px targets stay.
      className={`absolute left-4 top-[40px] z-20 box-border w-[48px] overflow-hidden rounded-[12px] border border-fill-edge bg-surface p-[5px] shadow-[var(--shadow-island)] transition-[width] duration-100 ${
        narrow ? "" : "pointer-fine:hover:w-[176px] pointer-fine:focus-within:w-[176px]"
      }`}
    >
      {tools.map(({ id, label, key, Icon }) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-label={`${label} (${key})`}
          aria-pressed={tool === id}
          data-testid={id === "note" ? "tool-note" : undefined}
          onClick={() => onTool(id)}
          className={`${row} ${tool === id ? "bg-accent-tint font-semibold text-accent-edge" : "text-ink-2"}`}
        >
          <Icon size={18} stroke={1.5} className="shrink-0" />
          <span className="text-[13px]">{label}</span>
          {/* One key style at every row (review-1 10-1280-1): the active row
              bolds only the LABEL — the key stays normal-weight muted mono. */}
          <span className="ml-auto font-mono text-[10.5px] font-normal text-muted">{key}</span>
        </button>
      ))}
      <div className="mx-[6px] my-1 h-px bg-line" />
      {additions.map(({ kind, label, Icon }) => (
        <button
          key={kind}
          type="button"
          disabled={disabled}
          aria-label={label}
          onClick={() => onAddStep(kind)}
          className={`${row} text-ink-2`}
        >
          <Icon size={18} stroke={1.5} className="shrink-0" />
          <span className="text-[13px]">{label}</span>
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        aria-label="More steps…"
        onClick={onMoreSteps}
        className={`${row} text-ink-2`}
      >
        <IconDots size={18} stroke={1.5} className="shrink-0" />
        <span className="text-[13px]">More steps…</span>
      </button>
    </div>
  );
}
