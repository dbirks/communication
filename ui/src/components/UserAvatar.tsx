/**
 * UserAvatar — the signed-in person's face, or the initials they would have
 * got before the identity provider released a picture.
 *
 * Two shapes: the app's square (4px radius, 1px `line-strong` border — the
 * initials box the app has always drawn) and the redesign rail's CIRCLE (a
 * 1px ink border, README §1 "the user avatar (30px circle, 1px ink border,
 * mono 10.5 initials)"). The rail asks for the circle; every other surface
 * keeps the square.
 *
 * The image is decoration: `alt=""`, because the name prints beside it (in the
 * sidebar footer, and under it on `/profile`), and a screen reader that said
 * "Ada Lovelace, Ada Lovelace" would be repeating itself. `referrerPolicy` is
 * `no-referrer` so a provider's picture host never learns which page of a
 * stranger's deployment loaded it.
 *
 * Failure is normal, not exceptional: the provider may release no `picture`
 * claim at all, the URL may be dead by the next login, or the CSP and the
 * network may simply say no. All of them end in the same initials, and no
 * re-render of a NEW url is poisoned by an old failure (the failed URL is
 * remembered by value, not as a sticky flag).
 */
import { useState } from "react";

/** The sizes the app draws: rail (circle), list rows, the Profile page. */
export type UserAvatarSize = 24 | 30 | 32 | 64;

/** The initials rule: the first letter of up to two words, upper-cased.
 * "David Birks" → "DB", "dbirks" → "D", "" → nothing (the tile draws "?"). */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Mono initials per size — the tile's own type scale, small faces included. */
const INITIALS_PX: Record<UserAvatarSize, number> = { 24: 10.5, 30: 10.5, 32: 12, 64: 20 };

export interface UserAvatarProps {
  /** The display name: printed as initials when there is no picture. */
  name: string;
  /** `GET /api/v1/me` → `avatar_url`: an https URL, or "" for none. */
  avatarUrl?: string;
  size?: UserAvatarSize;
  /** "square" (the app's own box) or "circle" (the redesign rail's ring). */
  shape?: "square" | "circle";
  /** Root test handle — the footer tile is `user-avatar`, the Profile page's
   * face is `profile-avatar`. */
  testid?: string;
  className?: string;
}

export default function UserAvatar({
  name,
  avatarUrl,
  size = 24,
  shape = "square",
  testid = "user-avatar",
  className = "",
}: UserAvatarProps) {
  // Which URL this tile already failed to load. Comparing by value (rather than
  // a boolean) is what lets a later login with a NEW picture try again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = avatarUrl && avatarUrl !== failedUrl ? avatarUrl : "";
  const box = { width: `${size}px`, height: `${size}px` };
  const frame = `grid shrink-0 place-items-center overflow-hidden border bg-fill ${
    shape === "circle" ? "rounded-full border-ink" : "rounded-[4px] border-line-strong"
  } ${className}`.trim();

  if (!url) {
    return (
      <span
        aria-hidden="true"
        data-testid={testid}
        className={`${frame} font-mono text-ink-2`}
        style={{ ...box, fontSize: `${INITIALS_PX[size]}px` }}
      >
        {initialsOf(name) || "?"}
      </span>
    );
  }
  return (
    <span data-testid={testid} className={frame} style={box}>
      <img
        data-testid="user-avatar-img"
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
        className="h-full w-full object-cover"
      />
    </span>
  );
}
