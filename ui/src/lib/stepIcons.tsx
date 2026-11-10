/**
 * stepIcons.tsx — the ONE map from a step kind to the icon drawn wherever
 * that kind is rendered (issue #65).
 *
 * The Unicode glyphs of `KIND_GLYPH` (lib/pipeline/definition.ts) render at
 * different metrics in every font and read inconsistently across platforms.
 * These are real Tabler icons (`@tabler/icons-react`) at a fixed 14px box with the
 * design system's 1.5 stroke and `currentColor`, so they sit on the text baseline
 * of the dense mono rows instead of floating in them.
 *
 * Contract (mirrors the glyph rule in `docs/design/handoff/graph-nodes.md`):
 * the icon is *decoration* — `aria-hidden`, never shape alone. The kind's
 * name (its word or catalogue name) always travels next to it as the
 * accessible text. Unknown kinds get a neutral square box: inventing an
 * icon for a kind from a newer catalogue would be a claim.
 */
import {
  IconArrowsJoin,
  IconArrowsSplit2,
  IconBolt,
  IconColumns,
  IconDiamond,
  IconFileUpload,
  IconGitCommit,
  IconMessage,
  IconRepeat,
  IconRobot,
  IconSearch,
  IconShieldCheck,
  IconSitemap,
  IconSquare,
  IconTerminal2,
  IconUpload,
  IconUserCheck,
  type TablerIcon,
} from "@tabler/icons-react";
import { isNodeKind, type NodeKind } from "./pipeline/definition";

/** The icon per catalogue kind. Each reads clearly at 14px. */
export const STEP_KIND_ICONS: Record<NodeKind, TablerIcon> = {
  "agent.acp": IconRobot,
  "model.chat": IconMessage,
  "process.exec": IconTerminal2,
  condition: IconDiamond,
  gate: IconShieldCheck,
  "human.approval": IconUserCheck,
  until: IconRepeat,
  for_each: IconArrowsSplit2,
  parallel: IconColumns,
  join: IconArrowsJoin,
  "pipeline.invoke": IconSitemap,
  "artifact.publish": IconFileUpload,
  "git.commit": IconGitCommit,
  "git.publish": IconUpload,
  "integration.query": IconSearch,
  "integration.action": IconBolt,
};

/** Neutral box for a kind outside this catalogue (same rule as the glyph
 * map's unknown `□`): the document may name a newer kind; we show a box,
 * never an invented icon. */
export const UNKNOWN_STEP_ICON: TablerIcon = IconSquare;

export function stepKindIcon(kind: string): TablerIcon {
  return isNodeKind(kind) ? STEP_KIND_ICONS[kind] : UNKNOWN_STEP_ICON;
}

/** Compact inline step-kind icon: 14px (16px max), 1.5 stroke, currentColor,
 * `aria-hidden` — the kind's name is carried by the text beside it. */
export function StepKindIcon({
  kind,
  size = 14,
  className,
}: {
  kind: string;
  /** 16px is the ceiling the design allows; the default is the dense 14px. */
  size?: number;
  className?: string;
}) {
  const Icon = stepKindIcon(kind);
  return (
    <Icon
      size={Math.min(size, 16)}
      stroke={1.5}
      aria-hidden
      // Identifies which kind this icon stands for without adding a name.
      data-step-kind={kind}
      className={className}
    />
  );
}
