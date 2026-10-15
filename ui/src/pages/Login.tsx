export default function Login() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-gray-700">
        <a
          className="text-blue-800 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          href="/auth/login"
        >
          Continue with your organization identity provider
        </a>
      </p>
    </section>
  );
}
