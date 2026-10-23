import { useSearchParams } from "react-router";
import { ButtonLink } from "../components/ds/Button";
import { Mark } from "../components/ds/Mark";

/**
 * Server rule (`GET /auth/login` in api/openapi.yaml): `return_to` must be a
 * same-origin relative path — starts with `/` and not `//` — or it is `/`.
 */
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/**
 * The sign-in screen — the only thing a signed-out visitor sees (gh-3: the app
 * shell renders around it no more). One product name, one primary action, one
 * short muted line; the explanatory paragraphs of the pre-redesign screen are
 * gone (gh-4).
 *
 * The card is centered in the viewport (min-h-dvh + flex centering) with a 16px
 * side gutter; the brand row reuses the sidebar's Mark + plain wordmark.
 */
export default function Login() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("return_to"));
  const href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;

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
          {/* Plain anchor: this leaves the app for the server-side OIDC redirect. */}
          <ButtonLink data-testid="sign-in" href={href} variant="primary">
            Sign in with OIDC
          </ButtonLink>
          <p className="text-small text-muted">
            You sign in through your organization&apos;s OpenID Connect provider.
          </p>
        </div>
      </div>
    </section>
  );
}
