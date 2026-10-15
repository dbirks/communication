import { useSearchParams } from "react-router";
import { ButtonLink } from "../components/ds/Button";
import { Mark, Wordmark } from "../components/ds/Mark";

/**
 * Server rule (`GET /auth/login` in api/openapi.yaml): `return_to` must be a
 * same-origin relative path — starts with `/` and not `//` — or it is `/`.
 */
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default function Login() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("return_to"));
  const href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;

  return (
    <section
      aria-labelledby="login-heading"
      className="mx-auto max-w-[34rem] rounded-[3px] border border-line-strong bg-surface"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-6">
        <Mark size={44} />
        <Wordmark size={16} className="ml-1" />
      </div>
      <div className="space-y-4 px-5 py-5">
        <h1 id="login-heading" className="text-title-xl font-bold">
          Sign in
        </h1>
        <p className="text-body leading-[1.6] text-ink-2">
          Communication signs you in with your organization&apos;s identity provider (OpenID
          Connect, authorization code with PKCE). Sessions live in the shared database rather than
          on one server, so a login can start on one API replica and finish on another.
        </p>
        <p className="text-small text-muted">
          After signing in you will see only the projects you belong to, with the role the project
          owner gave you.
        </p>
        {/* Plain anchor: this leaves the app for the server-side OIDC redirect. */}
        <p>
          <ButtonLink data-testid="sign-in" href={href}>
            Sign in with your organization identity provider
          </ButtonLink>
        </p>
      </div>
    </section>
  );
}
