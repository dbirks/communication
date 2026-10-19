import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useLogout, useMe } from "../api/queries";
import { useReplicaName } from "../api/replica";
import { problemOf } from "../api/client";
import { AppBar, InitialsBox } from "./ds/AppBar";
import CommandPalette from "./CommandPalette";
import NewMenu from "./NewMenu";
import { Button } from "./ds/Button";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const NAV_ITEMS = [
  { to: "/inbox", label: "Inbox" },
  { to: "/", label: "Projects", end: true },
  { to: "/library", label: "Workflows" },
  { to: "/agents", label: "Agents" },
  { to: "/ops", label: "Operations" },
];

export interface ShellProps {
  children: ReactNode;
}

/** The Ask box's context chip: the section the current path belongs to. A nav
 * item wins; anything outside the track is named by its own first segment
 * (`/projects/p-1` is `projects`, `/login` is `login`) rather than guessed at. */
export function sectionOf(pathname: string): string {
  const hit = NAV_ITEMS.find((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  const first = pathname.split("/")[1] ?? "";
  return (hit?.label ?? (first || "projects")).toLowerCase();
}

/** App shell: NAV-I app bar (C mark, section track, signed-in user, sign
 * out), main content on paper, mono replica footer. */
export default function Shell({ children }: ShellProps) {
  const replica = useReplicaName();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  const onSignOut = () => {
    logout.mutate(undefined, {
      onSuccess: () => navigate("/login"),
      onError: () => navigate("/login"),
    });
  };

  const logoutError = logout.error ? problemOf(logout.error).detail || "Sign out failed." : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <AppBar
        items={NAV_ITEMS}
        ask={<CommandPalette context={sectionOf(location.pathname)} />}
        right={
          <>
            {me.data ? (
              <>
                {/* The New menu starts things; signed-out visitors have nothing to start. */}
                <NewMenu />
                <span className="hidden text-[12.5px] text-muted sm:inline">
                  Signed in as{" "}
                  <strong data-testid="user-badge" className="font-semibold text-ink">
                    {me.data.display_name}
                  </strong>
                  {me.data.organization ? ` · ${me.data.organization.name}` : ""}
                </span>
                <InitialsBox name={me.data.display_name} />
                <Button variant="secondaryPlain" data-testid="sign-out" onClick={onSignOut}>
                  Sign out
                </Button>
              </>
            ) : (
              <span className="font-mono text-[11px] text-faint">not signed in</span>
            )}
          </>
        }
      />
      {logoutError ? (
        <p
          className="mx-auto w-full max-w-5xl px-4 pt-2 font-mono text-[11px] text-st-failed-tag-fg"
          role="alert"
        >
          × {logoutError}
        </p>
      ) : null}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {/* Keyed by the path: navigating clears a caught render error instead
            of leaving the crash banner on every later page. */}
        <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>
      </main>
      <footer className="border-t border-line px-4 py-2">
        <span data-testid="replica-badge" className="font-mono text-[11px] text-faint">
          replica: {replica}
        </span>
      </footer>
    </div>
  );
}
