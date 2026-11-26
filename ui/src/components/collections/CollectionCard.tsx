/**
 * One collection card on the Collections tab (ADR-0084): the redesign's card
 * shell (docs/design/redesign/CONTRACT.md — a 10px-corner card, 1px line on
 * white, the line darkening on hover, never the old hard offset shadow) carrying
 * the mono kicker `COLLECTION · r3 · 14 PACKAGES`, the name,
 * a two-line description clamp, and the `used by N profiles` footer.
 *
 * The counts are reads, never claims: `r{n}` and the package count come from
 * the list row's own `latest_revision` summary (what the collection currently
 * IS, draft or published), and the used-by count is joined client-side from
 * the agent-profiles list — the read that carries `apm_collections`
 * (ADR-0084). A collection no visible profile attaches carries no footer
 * rather than a `used by 0 profiles` nobody asked about.
 */
import { Link } from "react-router";
import {
  collectionPackageCount,
  collectionRoute,
  type APMCollection,
} from "../../api/apmCollections";

export interface CollectionCardProps {
  collection: APMCollection;
  /** Profiles (visible to the caller) that pin this collection at any revision. */
  usedByProfiles: number;
}

export function CollectionCard({ collection, usedByProfiles }: CollectionCardProps) {
  const revision = collection.latest_revision;
  const packages = collectionPackageCount(collection);
  const label =
    `COLLECTION · r${revision?.revision ?? 0} · ` +
    `${packages} ${packages === 1 ? "PACKAGE" : "PACKAGES"}`;
  return (
    <Link
      to={collectionRoute(collection.id)}
      data-testid={`collection-card-${collection.id}`}
      className="flex min-h-[120px] flex-col rounded-[10px] border border-line bg-surface p-[14px] no-underline transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <span className="font-mono text-[10.5px] uppercase tracking-[.06em] text-faint">
        {label}
        {revision?.status === "draft" ? (
          <span data-testid={`collection-card-draft-${collection.id}`}> · draft</span>
        ) : null}
      </span>
      <span className="mt-[8px] text-[14px] font-semibold text-ink">{collection.name}</span>
      {collection.description ? (
        <span className="mt-[2px] line-clamp-2 text-[12.5px] leading-[17px] text-muted">
          {collection.description}
        </span>
      ) : null}
      {usedByProfiles > 0 ? (
        <span
          className="mt-auto truncate pt-[8px] font-mono text-[10.5px] text-faint"
          data-testid={`collection-card-usage-${collection.id}`}
        >
          used by {usedByProfiles} {usedByProfiles === 1 ? "profile" : "profiles"}
        </span>
      ) : null}
    </Link>
  );
}

export default CollectionCard;
