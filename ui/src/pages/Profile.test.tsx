/**
 * `/profile` (the signed-in person's own page): everything it prints is read
 * off the mocked `GET /api/v1/me` — the picture from `avatar_url`, the name,
 * the email, the issuer host, the organization and the role — and nothing on it
 * is editable, because the identity provider owns those claims. The page is
 * mounted inside the real app shell (`renderApp`), so the sidebar's user block
 * and the route registration are exercised with it.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, type RouteStub } from "../test/fakes";
import type { Me } from "../api/types";

const READ_MS = 5_000;

function routes(me: Me): RouteStub[] {
  return [
    { path: "/api/v1/me", body: me },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/pipelines", body: { pipelines: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    {
      path: "/api/v1/me/preferences",
      method: "GET",
      body: {
        layout: {
          projects_mode: "tree",
          ask_placement: "sidebar",
          show_workflow_folders: true,
          expanded: {},
        },
        assistant: { trust_level: "ask_risky" },
        updated_at: null,
      },
    },
  ];
}

describe("/profile", () => {
  it("renders the name, picture, email, provider, organization and role from /me", async () => {
    renderApp({
      path: "/profile",
      routes: routes({
        ...meFixture,
        display_name: "David Birks",
        email: "david@example.test",
        avatar_url: "https://avatars.example.test/d.png",
        issuer_host: "idp.example.test",
        is_org_admin: true,
      }),
    });

    expect(await screen.findByTestId("profile-page", undefined, { timeout: READ_MS })).toBeTruthy();
    expect(screen.getByTestId("profile-name").textContent).toBe("David Birks");
    expect(screen.getByTestId("profile-email").textContent).toBe("david@example.test");
    expect(screen.getByTestId("profile-provider").textContent).toBe("idp.example.test");
    expect(screen.getByTestId("profile-organization").textContent).toBe("Default organization");
    expect(screen.getByTestId("profile-role").textContent).toBe("Organization admin");

    // The page's own face (the sidebar footer carries a second tile, so the
    // query is scoped to the page, not the document).
    const face = screen.getByTestId("profile-avatar");
    const img = face.querySelector("img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("https://avatars.example.test/d.png");
    // The 64px face, not the 24px footer tile.
    expect(face.style.width).toBe("64px");
    // The page says where the data comes from, and offers no field to edit.
    expect(screen.getByTestId("profile-source-note").textContent).toBe(
      "Your name and picture come from your identity provider. Change them there.",
    );
    // Read-only is the whole point: no form, no field, no save control.
    const page = screen.getByTestId("profile-page");
    expect(page.querySelector("input")).toBeNull();
    expect(page.querySelector("button")).toBeNull();
  });

  it("falls back to initials with no image, an honest email line and the member role", async () => {
    renderApp({
      path: "/profile",
      routes: routes({
        ...meFixture,
        display_name: "dbirks",
        email: null,
        avatar_url: "",
        issuer_host: "",
        is_org_admin: false,
      }),
    });

    expect(await screen.findByTestId("profile-page", undefined, { timeout: READ_MS })).toBeTruthy();
    const face = screen.getByTestId("profile-avatar");
    expect(face.querySelector("img")).toBeNull();
    expect(face.textContent).toBe("D");
    expect(screen.getByTestId("profile-email").textContent).toBe("not shared");
    expect(screen.getByTestId("profile-role").textContent).toBe("Member");
    // An issuer the server did not name is a row that is absent, not a row
    // that lies with an em dash.
    expect(screen.queryByTestId("profile-provider")).toBeNull();
  });
});
