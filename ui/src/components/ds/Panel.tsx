import type { ReactNode } from "react";
import { STATES, type StateName } from "./states";

/**
 * CARD-L — panel with a title bar that carries meaning. The bar is gray by
 * default; it takes a state's strong color only when the panel needs action
 * (handoff: "bar by meaning"). Edges are gray except on a state panel, where
 * rule 01 still allows ink/red as emphasis.
 */

export interface PanelProps {
  /** Uppercase mono title-bar text, e.g. "WORKSPACE". */
  title: string;
  /** Right slot of the title bar (mono, faint when neutral). */
  meta?: ReactNode;
  /** Strong-colored bar when the panel needs action; omit for gray. */
  state?: StateName;
  /** Optional id for in-page navigation targets. */
  id?: string;
  headingId?: string;
  /** Render the title-bar text as a heading element (document outline). */
  headingLevel?: 2 | 3;
  className?: string;
  children: ReactNode;
}

export function Panel({
  title,
  meta,
  state,
  id,
  headingId,
  headingLevel,
  className = "",
  children,
}: PanelProps) {
  const spec = state ? STATES[state] : null;
  const Title: "span" | "h2" | "h3" = headingLevel ? `h${headingLevel}` : "span";
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`overflow-hidden rounded-[3px] border bg-surface ${
        spec ? spec.strongEdge : "border-line-strong"
      } ${className}`}
    >
      <div
        data-ds-bar=""
        className={`flex items-center gap-2 border-b px-[10px] py-1 font-mono text-[10px] leading-[1.4] font-semibold tracking-[.04em] ${
          spec
            ? `${spec.strongBg} ${spec.strongFg} ${spec.strongEdge}`
            : "border-line-strong bg-fill text-ink-2"
        }`}
      >
        <Title id={headingId}>
          {spec ? (
            <span aria-hidden="true" className="mr-1.5">
              {spec.glyph}{" "}
            </span>
          ) : null}
          {title}
        </Title>
        {meta !== undefined ? (
          <span className={`ml-auto font-normal ${spec ? "" : "text-faint"}`}>{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}
