package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// userAvatarForeignKeyViolation reports the 23503 that can only be the
// user_id -> users key (migration 00032 declares no other on this table).
func userAvatarForeignKeyViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23503"
}

// maxStoredAvatarBytes is the profile-photo cap this database will accept:
// 256 KiB (ADR-0083). It is the same number as the CHECK constraint in migration
// 00032 and as internal/api/auth's MaxAvatarBytes — the API refuses an oversized
// photo before it is stored, and the constraint stops a caller that forgot.
const maxStoredAvatarBytes = 262144

// UserAvatar is a profile photo this server stores and serves itself, because
// the provider's photo endpoint cannot be an <img> src: Microsoft Graph's
// `/me/photo/$value` answers only with the signer's bearer token
// (https://learn.microsoft.com/en-us/graph/api/profilephoto-get?view=graph-rest-1.0,
// read 2026-11-11). Serving it from this origin is what keeps the app CSP at
// `img-src 'self'` for Entra users.
type UserAvatar struct {
	UserID string
	// ContentType is what the server sniffed on write (jpeg, png or webp), never
	// what the upstream response header claimed.
	ContentType string
	Bytes       []byte
	// ETag is the content hash, quoted by the route handler.
	ETag      string
	UpdatedAt time.Time
}

// userAvatarURL is the same-origin path a stored photo is served at. It is the
// only non-https shape users.avatar_url may hold (migration 00032), so it is
// built here, from a uuid this store already holds, and never from a claim.
func userAvatarURL(userID string) string {
	return "/api/v1/users/" + userID + "/avatar"
}

// userAvatarETag is a validator over the photo's bytes. It changes exactly when
// the picture changes — which is at a login where Graph released a different
// one — so `Cache-Control: private, max-age=3600` cannot serve a stale face
// longer than an hour no matter what the browser does with the etag.
func userAvatarETag(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256-" + hex.EncodeToString(sum[:16])
}

// SaveUserAvatar stores (or replaces) a user's photo and points users.avatar_url
// at it, in one transaction: there is no moment in which the row advertises a
// picture the browser would then fail to load, nor one in which a replaced
// picture is still described by the old path.
//
// The content type must already be the sniffed one and the body must fit inside
// the cap; both are refused here rather than by the database's CHECK, so the
// caller gets a Go error it can read instead of a constraint violation.
func (s *IdentityStore) SaveUserAvatar(ctx context.Context, userID, contentType string,
	body []byte) (UserAvatar, error) {
	if s == nil || s.Pool == nil {
		return UserAvatar{}, errors.New("postgres: identity store has no pool")
	}
	if userID == "" {
		return UserAvatar{}, errors.New("postgres: SaveUserAvatar requires a user id")
	}
	switch contentType {
	case "image/jpeg", "image/png", "image/webp":
	default:
		return UserAvatar{}, fmt.Errorf("postgres: avatar content type %q is not jpeg, png or webp", contentType)
	}
	if len(body) == 0 {
		return UserAvatar{}, errors.New("postgres: avatar body is empty")
	}
	if len(body) > maxStoredAvatarBytes {
		return UserAvatar{}, fmt.Errorf("postgres: avatar is %d bytes, over the %d byte cap",
			len(body), maxStoredAvatarBytes)
	}
	av := UserAvatar{UserID: userID, ContentType: contentType, Bytes: body, ETag: userAvatarETag(body)}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return UserAvatar{}, fmt.Errorf("postgres: begin avatar save: %w", err)
	}
	// Unconditional, and after every return below: a transaction left open holds
	// its locks on users and user_avatars for the life of the pooled connection,
	// which is how a store test comes to hang for the whole package. After a
	// Commit, Rollback is a no-op error this ignores.
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		INSERT INTO user_avatars (user_id, content_type, bytes, etag)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET
			content_type = EXCLUDED.content_type,
			bytes        = EXCLUDED.bytes,
			etag         = EXCLUDED.etag,
			updated_at   = now()
		RETURNING updated_at`, userID, av.ContentType, av.Bytes, av.ETag).
		Scan(&av.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return UserAvatar{}, fmt.Errorf("postgres: save avatar: %w", ErrNotFound)
		}
		// The one foreign key on this table is user_id -> users, so a violation
		// can only mean the person is gone: not-found, not a 500.
		if userAvatarForeignKeyViolation(err) {
			return UserAvatar{}, fmt.Errorf("postgres: save avatar for user %q: %w", userID, ErrNotFound)
		}
		return UserAvatar{}, fmt.Errorf("postgres: save avatar: %w", err)
	}
	// A user row that does not exist surfaces here as ErrNotFound, which is the
	// honest answer: the FK would have refused the photo anyway.
	tag, err := tx.Exec(ctx, `
		UPDATE users SET avatar_url = $2 WHERE id = $1::uuid`, userID, userAvatarURL(userID))
	if err != nil {
		return UserAvatar{}, fmt.Errorf("postgres: point user at avatar: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return UserAvatar{}, fmt.Errorf("postgres: save avatar for user %q: %w", userID, ErrNotFound)
	}
	if err := tx.Commit(ctx); err != nil {
		return UserAvatar{}, fmt.Errorf("postgres: commit avatar save: %w", err)
	}
	return av, nil
}

// GetUserAvatar reads a stored photo. A user with none is ErrNotFound.
func (s *IdentityStore) GetUserAvatar(ctx context.Context, userID string) (UserAvatar, error) {
	if s == nil || s.Pool == nil {
		return UserAvatar{}, errors.New("postgres: identity store has no pool")
	}
	if userID == "" {
		return UserAvatar{}, ErrNotFound
	}
	var av UserAvatar
	err := s.Pool.QueryRow(ctx, `
		SELECT user_id::text, content_type, bytes, etag, updated_at
		FROM user_avatars WHERE user_id = $1::uuid`, userID).
		Scan(&av.UserID, &av.ContentType, &av.Bytes, &av.ETag, &av.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserAvatar{}, ErrNotFound
	}
	if err != nil {
		return UserAvatar{}, fmt.Errorf("postgres: get avatar: %w", err)
	}
	return av, nil
}

// EnsureUserAvatarURL points users.avatar_url back at a photo this server
// already stores, and reports whether one exists.
//
// It exists for the Entra login where Graph released nothing — the endpoint was
// down, the consent was refused, the photo was over the cap. The ID token
// carries no picture URL of its own, so "refresh the claim from this login"
// would erase a face the database still holds; this re-attaches it instead. A
// user with no stored photo at all is a no-op returning false.
func (s *IdentityStore) EnsureUserAvatarURL(ctx context.Context, userID string) (bool, error) {
	if s == nil || s.Pool == nil {
		return false, errors.New("postgres: identity store has no pool")
	}
	if userID == "" {
		return false, errors.New("postgres: EnsureUserAvatarURL requires a user id")
	}
	var have bool
	err := s.Pool.QueryRow(ctx, `
		UPDATE users u SET avatar_url = $2
		FROM user_avatars a
		WHERE u.id = $1::uuid AND a.user_id = $1::uuid
		RETURNING true`, userID, userAvatarURL(userID)).Scan(&have)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("postgres: ensure avatar url: %w", err)
	}
	return have, nil
}
