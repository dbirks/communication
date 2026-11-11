import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { apiFetch } from "../api/client";
import type { components } from "../api/schema";
import { ButtonLink } from "../components/ds/Button";
import { Mark } from "../components/ds/Mark";

type LoginProvider = components["schemas"]["LoginProvider"];

/**
 * Server rule (`GET /auth/login` in api/openapi.yaml): `return_to` must be a
 * same-origin relative path — starts with `/` and not `//` — or it is `/`.
 */
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/**
 * The login request's URL. With one provider (or none named) it is exactly the
 * URL the sign-in screen emitted before ADR-0083: `?return_to=` only, so an
 * env-only deployment's sign-in link is unchanged on the wire.
 */
export function loginHref(returnTo: string, providerId?: string): string {
  const params = new URLSearchParams({ return_to: returnTo });
  if (providerId) params.set("provider", providerId);
  return `/auth/login?${params.toString()}`;
}

/**
 * `GET /auth/providers` is public and answers before anyone is signed in. It is
 * read once and kept: the list changes only when the deployment restarts, and a
 * refetch that fails mid-session must not redraw the buttons a person is about
 * to click.
 */
function useLoginProviders() {
  return useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => apiFetch<LoginProvider[]>("/auth/providers"),
    retry: false,
    staleTime: 600_000,
  });
}

/**
 * The sign-in screen — the only thing a signed-out visitor sees (gh-3: the app
 * shell renders around it no more). One product name, the sign-in action, one
 * short muted line; the explanatory paragraphs of the pre-redesign screen are
 * gone (gh-4).
 *
 * The card is centered in the viewport (min-h-dvh + flex centering) with a 16px
 * side gutter; the brand row reuses the sidebar's Mark + plain wordmark.
 *
 * ADR-0083 gave it a second shape: a deployment with more than one identity
 * provider (tailscale's tsidp and Microsoft Entra side by side) draws one button
 * per provider, in configuration order, each deep-linking that provider. With
 * one provider there is nothing to choose, so the screen is what it always was —
 * one button, the same label, the same URL. While the list is still arriving, or
 * if the read failed, the screen draws that one button too: `/auth/login` with
 * no provider either redirects straight to the single issuer or back here with
 * the chooser's options, so the action is never a dead end.
 */
export default function Login() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("return_to"));
  const providers = useLoginProviders();
  const items = providers.data ?? [];

  return (
    <section
      aria-labelledby="login-heading"
      className="flex min-h-dvh items-center justify-center px-4"
    >
      <div className="w-full max-w-[34rem] rounded-[3px] border border-line-strong bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-5 py-6">
          <Mark size={44} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">Communication</span>
        </div>
        <div className="space-y-6 px-5 py-5">
          <h1 id="login-heading" className="text-title-xl font-bold">
            Sign in
          </h1>
          {items.length > 1 ? (
            <div className="flex flex-col items-start gap-2">
              {items.map((provider) => (
                // Plain anchor: this leaves the app for the server-side OIDC redirect.
                <ButtonLink
                  key={provider.id}
                  data-testid={`sign-in-${provider.id}`}
                  href={loginHref(returnTo, provider.id)}
                  variant="primary"
                >
                  {`Sign in with ${provider.label}`}
                </ButtonLink>
              ))}
            </div>
          ) : (
            <ButtonLink
              data-testid="sign-in"
              href={loginHref(returnTo, items[0]?.id === "default" ? undefined : items[0]?.id)}
              variant="primary"
            >
              {`Sign in with ${items[0]?.label || "OIDC"}`}
            </ButtonLink>
          )}
          <p className="text-small text-muted">
            {items.length > 1
              ? "Choose the provider your account lives at."
              : "You sign in through your organization's OpenID Connect provider."}
          </p>
        </div>
      </div>
    </section>
  );
}
