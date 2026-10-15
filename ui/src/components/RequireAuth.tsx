import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError } from "../api/client";
import { useMe } from "../api/queries";
import { Spinner } from "./Feedback";

export interface RequireAuthProps {
  children: ReactNode;
}

/**
 * Gate for signed-in routes: a 401 from `GET /api/v1/me` sends the browser to
 * `/login?return_to=<current path>` (the server only accepts same-origin
 * relative paths, so the current location is exactly what to send).
 */
export default function RequireAuth({ children }: RequireAuthProps) {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <Spinner label="Loading your session" />;

  const error = me.error;

  if (error instanceof ApiError && error.status === 401) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?return_to=${encodeURIComponent(returnTo)}`} replace />;
  }

  if (error || !me.data) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Cannot load your session</h1>
        <p className="mt-2 text-red-800" role="alert">
          {error instanceof ApiError ? `${error.title}: ${error.detail}` : "Unknown error."}
        </p>
      </section>
    );
  }

  return <>{children}</>;
}
