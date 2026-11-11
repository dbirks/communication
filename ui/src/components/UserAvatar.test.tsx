/**
 * `components/UserAvatar.tsx`: the provider's picture when /me released one,
 * the person's initials when it did not — and the initials are what the tile
 * falls back to the moment a picture 404s, because a dead avatar URL is normal
 * (the person changed providers, the host is unreachable) and a broken-image
 * glyph is the one thing a face cannot be.
 *
 * The rules this pins are the ones the design brief fixed: a 4px-radius SQUARE
 * with a 1px `line-strong` border (the app has no circles), `alt=""` because the
 * name prints beside it, `referrerPolicy="no-referrer"` so the picture host
 * never learns who loaded it, and the initials rule — up to two words, first
 * letters, upper-cased.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import UserAvatar, { initialsOf } from "./UserAvatar";

const PICTURE = "https://avatars.example.test/d.png";

afterEach(cleanup);

describe("initialsOf", () => {
  it("takes the first letter of up to two words, upper-cased", () => {
    expect(initialsOf("David Birks")).toBe("DB");
    expect(initialsOf("dbirks")).toBe("D");
    expect(initialsOf("ada marie lovelace")).toBe("AM");
    expect(initialsOf("  Ada   Lovelace  ")).toBe("AL");
    expect(initialsOf("")).toBe("");
    expect(initialsOf("   ")).toBe("");
  });
});

describe("UserAvatar with a picture", () => {
  it("draws the image as decoration, no-referrer, covering the box", () => {
    render(<UserAvatar name="David Birks" avatarUrl={PICTURE} size={24} />);
    const img = screen.getByTestId("user-avatar-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(PICTURE);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.className).toContain("object-cover");
  });

  it("is a 4px-radius square with the line-strong border, at each size", () => {
    for (const size of [24, 32, 64] as const) {
      const { unmount } = render(<UserAvatar name="David Birks" avatarUrl={PICTURE} size={size} />);
      const tile = screen.getByTestId("user-avatar");
      expect(tile.className).toContain("rounded-[4px]");
      expect(tile.className).toContain("border-line-strong");
      expect(tile.style.width).toBe(`${size}px`);
      expect(tile.style.height).toBe(`${size}px`);
      unmount();
    }
  });

  it("falls back to the initials when the image fails, and keeps the name beside it", () => {
    render(<UserAvatar name="David Birks" avatarUrl={PICTURE} size={32} />);
    fireEvent.error(screen.getByTestId("user-avatar-img"));

    expect(screen.queryByTestId("user-avatar-img")).toBeNull();
    const tile = screen.getByTestId("user-avatar");
    expect(tile.textContent).toBe("DB");
    // The initials are decoration too: the name prints beside the tile.
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    // The size's own type scale (32px → 12px mono), on fill with ink-2 glyphs.
    expect(tile.style.fontSize).toBe("12px");
    expect(tile.className).toContain("bg-fill");
    expect(tile.className).toContain("text-ink-2");
    expect(tile.className).toContain("font-mono");
  });

  it("tries again for a NEW url after an old one failed", () => {
    const { rerender } = render(<UserAvatar name="David Birks" avatarUrl={PICTURE} size={24} />);
    fireEvent.error(screen.getByTestId("user-avatar-img"));
    expect(screen.queryByTestId("user-avatar-img")).toBeNull();

    rerender(
      <UserAvatar name="David Birks" avatarUrl="https://avatars.example.test/new.png" size={24} />,
    );
    const img = screen.getByTestId("user-avatar-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://avatars.example.test/new.png");
  });
});

describe("UserAvatar without a picture", () => {
  it("draws the initials at the size's mono scale (24px → 10.5px, 64px → 20px)", () => {
    const { unmount } = render(<UserAvatar name="David Birks" avatarUrl="" size={24} />);
    const tile = screen.getByTestId("user-avatar");
    expect(screen.queryByTestId("user-avatar-img")).toBeNull();
    expect(tile.textContent).toBe("DB");
    expect(tile.style.fontSize).toBe("10.5px");
    unmount();

    render(<UserAvatar name="David Birks" avatarUrl={undefined} size={64} />);
    expect(screen.getByTestId("user-avatar").style.fontSize).toBe("20px");
  });

  it("draws a question mark rather than an empty box for a name with no letters", () => {
    render(<UserAvatar name="  " avatarUrl="" size={32} />);
    expect(screen.getByTestId("user-avatar").textContent).toBe("?");
  });
});
