/**
 * One library card (ADR-0084): the mono kicker counts the pinned revision and
 * the packages of what the collection currently IS (its `latest_revision`
 * summary — a draft says so), the description clamps, and the footer only
 * appears when a profile the caller can see actually attaches it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionCard } from "./CollectionCard";
import type { APMCollection } from "../../api/apmCollections";

const base: APMCollection = {
  id: "c-1",
  slug: "matt-pocock-skills",
  name: "Matt Pocock skills",
  description: "Twenty-seven skills for spec, tickets and review — the whole plugin set.",
  created_by: "migration:00033",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 3,
  latest_revision: {
    revision_id: "r-3",
    revision: 3,
    status: "published",
    entries: Array.from({ length: 14 }, (_, i) => ({ ref: `owner/repo-${i}#v1.0.0` })),
    created_at: "2026-11-11T10:00:00Z",
  },
};

function mount(collection: APMCollection, usedByProfiles: number) {
  render(
    <MemoryRouter>
      <CollectionCard collection={collection} usedByProfiles={usedByProfiles} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("CollectionCard", () => {
  it("shows the revision, the package count, the name and the used-by footer", () => {
    mount(base, 2);
    const card = screen.getByTestId("collection-card-c-1");
    expect(card.textContent).toContain("COLLECTION · r3 · 14 PACKAGES");
    expect(card.textContent).toContain("Matt Pocock skills");
    expect(card.textContent).toContain("Twenty-seven skills");
    expect(screen.getByTestId("collection-card-usage-c-1").textContent).toBe("used by 2 profiles");
    // A published collection's card carries no draft marker.
    expect(screen.queryByTestId("collection-card-draft-c-1")).toBeNull();
  });

  it("says so when the newest revision is a draft, and stays silent at zero users", () => {
    mount(
      {
        ...base,
        latest_revision: { ...base.latest_revision!, revision: 4, status: "draft" },
      },
      0,
    );
    const card = screen.getByTestId("collection-card-c-1");
    expect(card.textContent).toContain("COLLECTION · r4 · 14 PACKAGES · draft");
    expect(screen.queryByTestId("collection-card-usage-c-1")).toBeNull();
  });
});
