/**
 * The kind identity used by the graph, the stage strip, the tree and the
 * inspector. A kind is *not* a state, so it deliberately does not use the
 * STATUS-E chip: a 1px hairline box, the drawn glyph, and the catalogue name
 * verbatim (`01`: the kind is the catalogue name, not a translated label).
 *
 * A `kind_not_implemented` kind (ADR-0024 § 2) says so in a word — a node that
 * cannot execute must not look like a node that can. The word is *what* is
 * missing ("not available yet"), never the internal build milestone: milestone
 * names are our roadmap vocabulary, and a person reading a graph has no way to
 * decode `M5`.
 */
import { isNodeKind, kindGlyph } from "../../lib/pipeline/definition";

export interface KindChipProps {
  kind: string;
  /** Truthy for a kind the runtime refuses (ADR-0024 § 2's `kind_not_implemented`
   * set). The value is the roadmap label the data model carries; the chip renders
   * the words, never the label. */
  deferredTo?: string | null;
  /** Compact = glyph only, used inside 28px tree rows. */
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
  const known = isNodeKind(kind);
  return (
    <span
      // The glyph is decoration; the kind name is the information. Screen
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
      <span aria-hidden className="text-[10px] leading-none text-ink-2">
        {/* Unknown kinds keep a neutral box: the document may name a kind from
            a newer catalogue, and inventing a glyph for it would be a claim. */}
        {known ? kindGlyph(kind) : "□"}
      </span>
      {compact ? null : <span className="truncate">{kind}</span>}
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
