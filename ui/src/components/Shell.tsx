import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useLogout, useMe } from "../api/queries";
import { useReplicaName } from "../api/replica";
import { problemOf } from "../api/client";

const navLinkClass =
  "rounded px-2 py-1 font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 aria-[current=page]:text-blue-800";

const buttonClass =
  "rounded border border-gray-300 px-2 py-1 text-sm font-medium text-gray-800 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50";

export interface ShellProps {
  children: ReactNode;
}

/** App shell: header (nav, signed-in user, sign out), main content, replica footer. */
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
    <div className="flex min-h-screen flex-col bg-white text-gray-950">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">Communication</span>
          <nav aria-label="Primary" className="flex items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Projects
            </NavLink>
            <NavLink to="/ops" className={navLinkClass}>
              Operations
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {me.data ? (
              <>
                <span className="text-sm text-gray-700">
                  Signed in as{" "}
                  <strong data-testid="user-badge" className="font-medium">
                    {me.data.display_name}
                  </strong>
                  {me.data.organization ? ` · ${me.data.organization.name}` : ""}
                </span>
                <button
                  type="button"
                  className={buttonClass}
                  data-testid="sign-out"
                  onClick={onSignOut}
                >
                  Sign out
                </button>
              </>
            ) : (
              <span className="text-sm text-gray-600">not signed in</span>
            )}
          </div>
        </div>
        {logoutError ? (
          <p className="mx-auto w-full max-w-5xl px-4 pb-2 text-sm text-red-800" role="alert">
            {logoutError}
          </p>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t border-gray-200 px-4 py-2 text-sm text-gray-500">
        <span data-testid="replica-badge">replica: {replica}</span>
      </footer>
    </div>
  );
}
