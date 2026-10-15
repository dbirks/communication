import { useSearchParams } from "react-router";

/**
 * Server rule (`GET /auth/login` in api/openapi.yaml): `return_to` must be a
 * same-origin relative path — starts with `/` and not `//` — or it is `/`.
 */
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

const buttonLikeLinkClass =
  "inline-block rounded bg-blue-800 px-4 py-2 text-sm font-medium text-white hover:bg-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

export default function Login() {
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("return_to"));
  const href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;

  return (
    <section aria-labelledby="login-heading" className="max-w-prose">
      <h1 id="login-heading" className="text-2xl font-semibold">
        Sign in
      </h1>
      <p className="mt-2 text-gray-700">
        Communication signs you in with your organization&apos;s identity provider (OpenID Connect,
        authorization code with PKCE). Sessions live in the shared database rather than on one
        server, so a login can start on one API replica and finish on another.
      </p>
      <p className="mt-1 text-sm text-gray-600">
        After signing in you will see only the projects you belong to, with the role the project
        owner gave you.
      </p>
      <p className="mt-6">
        {/* Plain anchor: this leaves the app for the server-side OIDC redirect. */}
        <a className={buttonLikeLinkClass} data-testid="sign-in" href={href}>
          Sign in with your organization identity provider
        </a>
      </p>
    </section>
  );
}
