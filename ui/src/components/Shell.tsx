import type { ReactNode } from "react";
import { NavLink } from "react-router";

const navLinkClass =
  "rounded px-2 py-1 font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 aria-[current=page]:text-blue-800";

export interface ShellProps {
  replica: string;
  children: ReactNode;
}

/** App shell: header with product name and primary nav, main content, footer. */
export default function Shell({ replica, children }: ShellProps) {
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
          <span className="ml-auto text-sm text-gray-600">not signed in</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t border-gray-200 px-4 py-2 text-sm text-gray-500">
        replica: {replica}
      </footer>
    </div>
  );
}
