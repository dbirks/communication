/**
 * The answer's links (design 2a/2f, round-17 rcn-review17-2f): the places the
 * turn points at, drawn as their OWN group under the prose and the draft step
 * list.
 *
 * Round 17's defect was that these rows read as more steps: they carried the
 * step list's `●` glyph, sat in the step list's visual style, and one of them
 * printed the internal id the model had handled (`Open M4 Exit (01a1aa60…)`).
 * So: no step glyphs here — the ✓ / ● / · marks belong to the step list and
 * mean done / next / later, which a link cannot be — the group is separated by
 * a hairline, each row is link text in the accent colour with the app's own
 * `Go ›` affordance, and a label never carries a raw id (`draftSteps.ts`
 * `readableLinkLabel`).
 *
 * The saved draft's row also stands aside when the panel's footer already
 * offers `Open draft` for that same draft (see `openDraftHref`): one door, one
 * control. Where the footer shows no button — the 400px popover — the row is
 * the draft's only way in and always renders.
 */
import type { ReactElement } from "react";
import { useDraft } from "../../api/pipelines";
import {
  draftNameOf,
  draftRouteOf,
  isDraftLink,
  readableLinkLabel,
  sameDraftTarget,
} from "./draftSteps";

/** One answer's links, minus the draft row the footer already offers. */
export function AnswerLinks({
  links,
  openDraftHref = null,
  onGo,
}: {
  links: readonly { label: string; route: string }[];
  /** The draft route the panel footer's `Open draft` button points at, or `null` when it shows none. */
  openDraftHref?: string | null;
  onGo: (route: string) => void;
}) {
  const rows = links
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => openDraftHref === null || !sameDraftTarget(link.route, openDraftHref));
  if (rows.length === 0) return null;
  return (
    <div
      data-testid="assistant-links"
      className="flex flex-col gap-[3px]"
      style={{
        borderTop: "1px solid var(--color-line)",
        marginTop: 8,
        paddingTop: 6,
      }}
    >
      {rows.map(({ link, index }) => (
        <LinkRow key={`${link.route}-${index}`} link={link} onGo={onGo} />
      ))}
    </div>
  );
}

/**
 * The saved draft's readable wording: `Open draft · <name>`, the name riding
 * the draft document the step list fetches anyway, so nothing extra loads.
 * While that read is pending the base label stands — the door is never
 * labelled with an id the person cannot read.
 */
function DraftLinkLabel({ draftId }: { draftId: string }) {
  const { data } = useDraft(draftId);
  const name = data !== undefined ? draftNameOf(data.document_yaml) : null;
  return <>{name !== null ? `Open draft · ${name}` : "Open draft"}</>;
}

/** What one link row says: never a raw path, never a raw id, never a step glyph. */
function linkLabelFor(link: { label: string; route: string }): ReactElement | string {
  const draftId = draftRouteOf(link.route);
  if (draftId !== null) return <DraftLinkLabel draftId={draftId} />;
  if (isDraftLink(link)) return "Open draft";
  return readableLinkLabel(link);
}

/**
 * One `Go ›` row: the whole row is the button (it is a same-origin jump the
 * caller performs, not an `<a>` — the app keeps the assistant open over the
 * destination).
 */
function LinkRow({
  link,
  onGo,
}: {
  link: { label: string; route: string };
  onGo: (route: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="assistant-link"
      onClick={() => onGo(link.route)}
      className="flex w-full cursor-pointer items-center justify-between gap-[8px] border-none bg-transparent p-0 text-left text-[12.5px] leading-[1.5] text-accent-text"
    >
      <span
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {linkLabelFor(link)}
      </span>
      <span aria-hidden="true" className="flex-shrink-0 font-mono text-[11px]">
        Go ›
      </span>
    </button>
  );
}
