package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// The picture fixtures are the shortest bodies http.DetectContentType names for
// each accepted type — the API sniffs before it calls SaveUserAvatar, so the
// store's job is the cap and the type set, not the sniff.
var (
	avJPEG = []byte{0xff, 0xd8, 0xff, 0xe0, 'j', 'p', 'g', '!', 1, 2, 3, 4, 5, 6, 7, 8}
	avPNG  = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 'p', 'n', 'g', 1, 2, 3, 4, 5}
	avGIF  = []byte{'G', 'I', 'F', '8', '9', 'a', 1, 0, 1, 0, 0x80, 0, 0}
)

// avUser opens a user through the identity path the avatar belongs to, so the
// row is shaped like a real one (organization, issuer, subject) and is swept by
// idnTestStore's issuer-scoped cleanup.
func avUser(t *testing.T, ctx context.Context, store *IdentityStore, subject string) User {
	t.Helper()
	org := idnDefaultOrg(t, ctx, store)
	u, err := store.UpsertOIDCUser(ctx, org.ID, "https://idn.test/avatars", subject,
		"Avatar Subject", "", "", false)
	if err != nil {
		t.Fatalf("UpsertOIDCUser(%q): %v", subject, err)
	}
	return u
}

func TestStoreUserAvatarRoundTrip(t *testing.T) {
	ctx, store := idnTestStore(t)
	u := avUser(t, ctx, store, "avatar-round-trip")

	// No photo yet: the user's avatar_url is the empty string and the read is a
	// plain not-found, which the route answers 404 and the UI draws as initials.
	if u.AvatarURL != "" {
		t.Fatalf("new user AvatarURL = %q, want empty", u.AvatarURL)
	}
	if _, err := store.GetUserAvatar(ctx, u.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetUserAvatar before a save = %v, want ErrNotFound", err)
	}

	saved, err := store.SaveUserAvatar(ctx, u.ID, "image/png", avPNG)
	if err != nil {
		t.Fatalf("SaveUserAvatar: %v", err)
	}
	wantURL := "/api/v1/users/" + u.ID + "/avatar"
	if saved.ContentType != "image/png" || string(saved.Bytes) != string(avPNG) {
		t.Errorf("SaveUserAvatar = %+v, want the png back", saved)
	}
	if saved.ETag == "" || !strings.HasPrefix(saved.ETag, "sha256-") {
		t.Errorf("ETag = %q, want a sha256- validator", saved.ETag)
	}
	if saved.UpdatedAt.IsZero() {
		t.Errorf("UpdatedAt is zero")
	}

	// The path is written in the same transaction as the bytes.
	var storedURL string
	if err := store.Pool.QueryRow(ctx, `SELECT avatar_url FROM users WHERE id = $1::uuid`,
		u.ID).Scan(&storedURL); err != nil {
		t.Fatalf("read avatar_url: %v", err)
	}
	if storedURL != wantURL {
		t.Errorf("user AvatarURL = %q, want the same-origin path %q", storedURL, wantURL)
	}

	read, err := store.GetUserAvatar(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserAvatar: %v", err)
	}
	if string(read.Bytes) != string(avPNG) || read.ContentType != "image/png" || read.ETag != saved.ETag {
		t.Errorf("GetUserAvatar = %+v, want the stored png with etag %q", read, saved.ETag)
	}

	// A second photo replaces the first rather than stacking rows: one picture
	// per person, and the validator changes with it.
	replaced, err := store.SaveUserAvatar(ctx, u.ID, "image/jpeg", avJPEG)
	if err != nil {
		t.Fatalf("SaveUserAvatar (replace): %v", err)
	}
	if replaced.ETag == saved.ETag {
		t.Errorf("etag after a replacement = %q, want a new one", replaced.ETag)
	}
	again, err := store.GetUserAvatar(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserAvatar after replace: %v", err)
	}
	if string(again.Bytes) != string(avJPEG) || again.ContentType != "image/jpeg" {
		t.Errorf("GetUserAvatar after replace = %+v, want the jpeg", again)
	}
	var rows int
	if err := store.Pool.QueryRow(ctx, `SELECT count(*) FROM user_avatars WHERE user_id = $1::uuid`,
		u.ID).Scan(&rows); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rows != 1 {
		t.Errorf("user_avatars rows = %d, want 1", rows)
	}
}

func TestStoreUserAvatarRefusesWhatTheDatabaseMustNotHold(t *testing.T) {
	ctx, store := idnTestStore(t)
	u := avUser(t, ctx, store, "avatar-refusals")

	if _, err := store.SaveUserAvatar(ctx, u.ID, "image/gif", avGIF); err == nil {
		t.Errorf("SaveUserAvatar(gif) = nil error, want a refusal: only jpeg, png, webp")
	}
	if _, err := store.SaveUserAvatar(ctx, u.ID, "image/png", nil); err == nil {
		t.Errorf("SaveUserAvatar(empty) = nil error, want a refusal")
	}
	if _, err := store.SaveUserAvatar(ctx, u.ID, "image/png",
		make([]byte, maxStoredAvatarBytes+1)); err == nil {
		t.Errorf("SaveUserAvatar(over cap) = nil error, want a refusal")
	}
	// Exactly at the cap is storeable (and the CHECK agrees).
	if _, err := store.SaveUserAvatar(ctx, u.ID, "image/png",
		append(append([]byte{}, avPNG...), make([]byte, maxStoredAvatarBytes-len(avPNG))...)); err != nil {
		t.Errorf("SaveUserAvatar(exactly at the cap) = %v, want success", err)
	}
	// A user that does not exist gets not-found, not a foreign-key 500.
	if _, err := store.SaveUserAvatar(ctx, "00000000-0000-0000-0000-000000000000",
		"image/png", avPNG); !errors.Is(err, ErrNotFound) {
		t.Errorf("SaveUserAvatar(unknown user) = %v, want ErrNotFound", err)
	}

	// The CHECK constraint is there even for a caller that skipped the Go guard.
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO user_avatars (user_id, content_type, bytes, etag)
		VALUES ($1::uuid, 'image/png', repeat('x', 262145)::bytea, 'x')`, u.ID)
	if err == nil || !strings.Contains(err.Error(), "user_avatars_bytes_size_check") {
		t.Errorf("raw over-cap insert = %v, want the size CHECK to refuse it", err)
	}
}

// TestStoreUsersAvatarURLAcceptsOnlyTheTwoShapes pins the migration-00032
// constraint: an https URL, this server's own avatar path, or nothing.
func TestStoreUsersAvatarURLAcceptsOnlyTheTwoShapes(t *testing.T) {
	ctx, store := idnTestStore(t)
	u := avUser(t, ctx, store, "avatar-url-shapes")

	cases := []struct {
		value string
		ok    bool
	}{
		{"", true},
		{"https://avatars.example.test/p.png", true},
		{"/api/v1/users/" + u.ID + "/avatar", true},
		{"/etc/passwd", false},
		{"/api/v1/users/../avatar", false},
		{"http://cdn.example.test/p.png", false},
		{"data:image/png;base64,AA", false},
		{"javascript:alert(1)", false},
	}
	for _, c := range cases {
		_, err := store.Pool.Exec(ctx, `UPDATE users SET avatar_url = $2 WHERE id = $1::uuid`,
			u.ID, c.value)
		if c.ok && err != nil {
			t.Errorf("avatar_url %q rejected: %v", c.value, err)
		}
		if !c.ok && err == nil {
			t.Errorf("avatar_url %q accepted, want the CHECK to refuse it", c.value)
		}
	}
}

func TestStoreEnsureUserAvatarURL(t *testing.T) {
	ctx, store := idnTestStore(t)

	// A user with no stored photo: a no-op, and the answer says so.
	plain := avUser(t, ctx, store, "avatar-ensure-none")
	have, err := store.EnsureUserAvatarURL(ctx, plain.ID)
	if err != nil {
		t.Fatalf("EnsureUserAvatarURL (no photo): %v", err)
	}
	if have {
		t.Errorf("EnsureUserAvatarURL for a user with no photo = true, want false")
	}

	// A user whose photo this server holds: the face is re-attached, which is
	// what a login with a Graph outage must not erase.
	withPic := avUser(t, ctx, store, "avatar-ensure-held")
	if _, err := store.SaveUserAvatar(ctx, withPic.ID, "image/webp",
		append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), 1, 2, 3)); err != nil {
		t.Fatalf("SaveUserAvatar: %v", err)
	}
	if _, err := store.Pool.Exec(ctx, `UPDATE users SET avatar_url = '' WHERE id = $1::uuid`,
		withPic.ID); err != nil {
		t.Fatalf("clear avatar_url: %v", err)
	}
	have, err = store.EnsureUserAvatarURL(ctx, withPic.ID)
	if err != nil {
		t.Fatalf("EnsureUserAvatarURL: %v", err)
	}
	if !have {
		t.Fatalf("EnsureUserAvatarURL = false, want true for a stored photo")
	}
	var url string
	if err := store.Pool.QueryRow(ctx, `SELECT avatar_url FROM users WHERE id = $1::uuid`,
		withPic.ID).Scan(&url); err != nil {
		t.Fatalf("read avatar_url: %v", err)
	}
	if want := "/api/v1/users/" + withPic.ID + "/avatar"; url != want {
		t.Errorf("avatar_url = %q, want %q", url, want)
	}
	// An unknown id is a no-op, never an error.
	if have, err := store.EnsureUserAvatarURL(ctx, "00000000-0000-0000-0000-000000000000"); err != nil || have {
		t.Errorf("EnsureUserAvatarURL(unknown) = (%v, %v), want (false, nil)", have, err)
	}
}

// TestStoreLoginStateRecordsProvider is the state↔provider binding's storage
// half (ADR-0083 "State"): a named provider round-trips, and the empty and
// `default` forms both come back as `default` — the value an env-only
// deployment, whose rows carry NULL, has always meant.
func TestStoreLoginStateRecordsProvider(t *testing.T) {
	ctx, store := idnTestStore(t)

	for _, c := range []struct{ name, saved, want string }{
		{"named", "tailnet", "tailnet"},
		{"explicit default", "default", "default"},
		{"empty means default", "", "default"},
	} {
		state := "idn-state-provider-" + c.name
		if err := store.SaveLoginState(ctx, LoginState{
			State: state, CodeVerifier: "v", Nonce: "n", ProviderID: c.saved,
			ExpiresAt: time.Now().Add(5 * time.Minute),
		}); err != nil {
			t.Fatalf("SaveLoginState(%q): %v", c.name, err)
		}
		got, err := store.TakeLoginState(ctx, state)
		if err != nil {
			t.Fatalf("TakeLoginState(%q): %v", c.name, err)
		}
		if got.ProviderID != c.want {
			t.Errorf("saved %q, TakeLoginState ProviderID = %q, want %q", c.saved, got.ProviderID, c.want)
		}
	}

	// A NULL provider_id — the shape every pre-ADR-0083 row has — reads as
	// `default`, so an old in-flight login still completes after the upgrade.
	if _, err := store.Pool.Exec(ctx, `
		INSERT INTO oidc_login_states (state, code_verifier, nonce, return_to, expires_at)
		VALUES ('idn-state-provider-legacy', 'v', 'n', '/', now() + interval '5 minutes')`); err != nil {
		t.Fatalf("insert a legacy row: %v", err)
	}
	legacy, err := store.TakeLoginState(ctx, "idn-state-provider-legacy")
	if err != nil {
		t.Fatalf("TakeLoginState (legacy row): %v", err)
	}
	if legacy.ProviderID != "default" {
		t.Errorf("legacy row ProviderID = %q, want %q", legacy.ProviderID, "default")
	}
}
