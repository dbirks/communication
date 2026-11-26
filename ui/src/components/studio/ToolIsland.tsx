import {
  IconPointer,
  IconHandStop,
  IconMarquee2,
  IconLine,
  IconRobot,
  IconTerminal2,
  IconUserCheck,
  IconDots,
} from "@tabler/icons-react";
import { useState } from "react";

export type CanvasTool = "select" | "move" | "box" | "connect";

export function ToolIsland({
  tool,
  onTool,
  onAddStep,
  onMoreSteps,
  disabled,
}: {
  tool: CanvasTool;
  onTool(tool: CanvasTool): void;
  onAddStep(kind: string): void;
  onMoreSteps(): void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const tools = [
    { id: "select" as const, label: "Select", key: "V", Icon: IconPointer },
    { id: "move" as const, label: "Move around", key: "H", Icon: IconHandStop },
    { id: "box" as const, label: "Box select", key: "B", Icon: IconMarquee2 },
    { id: "connect" as const, label: "Connect", key: "C", Icon: IconLine },
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
      onPointerDown={(event) => {
        if (event.pointerType === "touch") setExpanded((open) => !open);
      }}
      className={`group absolute left-4 top-4 z-20 box-border overflow-hidden rounded-[12px] border border-line bg-surface p-[5px] shadow-[var(--shadow-pop)] transition-[width] duration-100 hover:w-[176px] focus-within:w-[176px] ${expanded ? "w-[176px]" : "w-[48px]"}`}
    >
      {tools.map(({ id, label, key, Icon }) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-label={`${label} (${key})`}
          aria-pressed={tool === id}
          onClick={() => onTool(id)}
          className={`${row} ${tool === id ? "bg-accent-tint font-semibold text-accent-edge" : "text-ink-2"}`}
        >
          <Icon size={18} stroke={1.5} className="shrink-0" />
          <span className="text-[13px]">{label}</span>
          <span className="ml-auto font-mono text-[10.5px] text-muted">{key}</span>
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
