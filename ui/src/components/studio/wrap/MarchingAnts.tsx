/**
 * MarchingAnts — animated dashed royal outline used around box-selected steps
 * and around an active GoalFrame while a run is executing. Respects
 * `prefers-reduced-motion: reduce`.
 */

export interface MarchingAntsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MarchingAntsProps {
  rect: MarchingAntsRect;
  label?: string;
  animated?: boolean;
  rx?: number;
  className?: string;
  "data-testid"?: string;
}

export function MarchingAnts({
  rect,
  label,
  animated = true,
  rx = 14,
  className = "",
  "data-testid": testId = "marching-ants",
}: MarchingAntsProps) {
  const width = Math.max(0, rect.width);
  const height = Math.max(0, rect.height);
  const innerW = Math.max(0, width - 1.5);
  const innerH = Math.max(0, height - 1.5);

  return (
    <div
      data-testid={testId}
      className={`pointer-events-none absolute ${className}`}
      style={{
        left: rect.x,
        top: rect.y,
        width,
        height,
      }}
    >
      <style>{`
        @keyframes studio-marching-ants {
          from { stroke-dashoffset: 0; }
          to { stroke-dashoffset: -22; }
        }
        .studio-marching-ants-rect {
          animation: studio-marching-ants 0.7s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .studio-marching-ants-rect {
            animation: none;
          }
        }
      `}</style>
      {label ? (
        <span
          className="absolute bottom-full left-0 mb-[6px] whitespace-nowrap font-mono text-[10.5px] leading-none text-accent-text"
          data-testid={`${testId}-label`}
        >
          {label}
        </span>
      ) : null}
      <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
        <rect
          x={0.75}
          y={0.75}
          width={innerW}
          height={innerH}
          rx={rx}
          fill="rgba(47, 75, 214, 0.035)"
          stroke="#2f4bd6"
          strokeWidth={1.5}
          strokeDasharray="6 5"
          className={animated ? "studio-marching-ants-rect" : undefined}
        />
      </svg>
    </div>
  );
}
