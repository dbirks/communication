/**
 * Profile (route `/profile`) — who you are, as this application knows it.
 *
 * Every field here is read-only on purpose, and the page says why in one
 * muted line: the name, the email and the picture are claims the identity
 * provider released at sign-in (`display_name`, `email`, `avatar_url` on
 * `GET /api/v1/me`), so editing them here would either be a lie or a second
 * source of truth for the same person. Changing them happens at the provider;
 * the next login picks the new values up (ADR-0012 § 4, migration 00031).
 *
 * The band is the shared one (`ds/Page`, `reading` layout): title row, mono
 * subline. Nothing else on the page competes with it.
 */
import type { ReactNode } from "react";
import Page from "../components/ds/Page";
import UserAvatar from "../components/UserAvatar";
import { useMe } from "../api/queries";

/** One label/value row of the read-only detail list. */
function Field({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-line-soft py-2 last:border-b-0">
      <dt className="w-[132px] shrink-0 font-mono text-[10.5px] tracking-[.04em] text-muted uppercase">
        {label}
      </dt>
      <dd className="min-w-0 text-[13px] text-ink" data-testid={testid}>
        {children}
      </dd>
    </div>
  );
}

export default function Profile() {
  const me = useMe();

  if (!me.data) {
    return (
      <Page layout="reading" testid="profile-page" title="Profile" subtitle="your sign-in">
        <p className="font-mono text-[11px] text-faint" data-testid="profile-loading">
          {me.isError ? "could not read your session" : "reading your session…"}
        </p>
      </Page>
    );
  }

  const { display_name: name, email, avatar_url: avatarUrl, issuer_host: issuerHost } = me.data;
  const organization = me.data.organization?.name ?? "";

  return (
    <Page
      layout="reading"
      testid="profile-page"
      title="Profile"
      subtitle="your sign-in · read only"
    >
      <div className="mt-4 max-w-[520px]">
        <div className="flex items-center gap-3">
          <UserAvatar name={name} avatarUrl={avatarUrl} size={64} testid="profile-avatar" />
          <div className="min-w-0">
            <div className="truncate text-[20px] font-semibold text-ink" data-testid="profile-name">
              {name}
            </div>
            <p
              className="mt-[2px] text-[11.5px] leading-[16px] text-muted"
              data-testid="profile-source-note"
            >
              Your name and picture come from your identity provider. Change them there.
            </p>
          </div>
        </div>

        <dl className="mt-5">
          <Field label="Email" testid="profile-email">
            {email ? email : <span className="font-mono text-[11.5px] text-faint">not shared</span>}
          </Field>
          {issuerHost ? (
            <Field label="Signed in with" testid="profile-provider">
              {issuerHost}
            </Field>
          ) : null}
          {organization ? (
            <Field label="Organization" testid="profile-organization">
              {organization}
            </Field>
          ) : null}
          <Field label="Role" testid="profile-role">
            {/* The only role M1 models is the organization-wide one; a member
                with no project role is still a member here. */}
            {me.data.is_org_admin ? "Organization admin" : "Member"}
          </Field>
        </dl>
      </div>
    </Page>
  );
}
