import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useLogout, useMe } from "../api/queries";
import { useReplicaName } from "../api/replica";
import { problemOf } from "../api/client";
import { AppBar, InitialsBox } from "./ds/AppBar";
import { Button } from "./ds/Button";

const NAV_ITEMS = [
  { to: "/", label: "Projects", end: true },
  { to: "/ops", label: "Operations" },
];

export interface ShellProps {
  children: ReactNode;
}

/** App shell: NAV-I app bar (C mark, section track, signed-in user, sign
 * out), main content on paper, mono replica footer. */
export default function Shell({ children }: ShellProps) {
  const replica = useReplicaName();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

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
        right={
          me.data ? (
            <>
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
          )
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-line px-4 py-2">
        <span data-testid="replica-badge" className="font-mono text-[11px] text-faint">
          replica: {replica}
        </span>
      </footer>
    </div>
  );
}
