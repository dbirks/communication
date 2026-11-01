/**
 * The kind identity used by the graph, the stage strip, the tree and the
 * inspector. A kind is *not* a state, so it deliberately does not use the
 * STATUS-E chip: a 1px hairline box, the shared `StepKindIcon` (#65), and the
 * catalogue name verbatim (`01`: the kind is the catalogue name, not a
 * translated label).
 *
 * A `kind_not_implemented` kind (ADR-0024 § 2) says so in a word — a node that
 * cannot execute must not look like a node that can. The word is *what* is
 * missing ("not available yet"), never the internal build milestone: milestone
 * names are our roadmap vocabulary, and a person reading a graph has no way to
 * decode `M5`.
 */
import { StepKindIcon } from "../../lib/stepIcons";

export interface KindChipProps {
  kind: string;
  /** Truthy for a kind the runtime refuses (ADR-0024 § 2's `kind_not_implemented`
   * set). The value is the roadmap label the data model carries; the chip renders
   * the words, never the label. */
  deferredTo?: string | null;
  /** Compact = icon only (plus screen-reader text), used inside 28px tree rows. */
  compact?: boolean;
  className?: string;
  testid?: string;
}

export function KindChip({
  kind,
  deferredTo,
  compact = false,
  className = "",
  testid,
}: KindChipProps) {
  return (
    <span
      // The icon is decoration; the kind name is the information. Screen
      // readers get the name alone.
      aria-hidden={false}
      data-testid={testid ?? "kind-chip"}
      className={`inline-flex max-w-full items-center gap-[5px] rounded-[2px] border px-[4px] py-[1px] font-mono text-[10.5px] leading-[14px] text-muted ${
        deferredTo ? "border-dashed border-line-strong" : "border-line"
      } ${className}`}
      title={
        deferredTo ? `${kind} — not available yet: a workflow can't run this step today` : kind
      }
    >
      {/* The icon stands for the kind; unknown kinds keep a neutral box: the
          document may name a kind from a newer catalogue, and inventing an
          icon for it would be a claim. */}
      <StepKindIcon kind={kind} size={12} className="shrink-0 text-ink-2" />
      {compact ? (
        // The row is dense enough to drop the word, but the name stays in the
        // accessibility tree.
        <span className="sr-only">{kind}</span>
      ) : (
        <span className="truncate">{kind}</span>
      )}
      {deferredTo ? (
        <span
          className="text-faint"
          data-testid={testid ? `${testid}-deferred` : "kind-chip-deferred"}
        >
          not available yet
        </span>
      ) : null}
    </span>
  );
}
