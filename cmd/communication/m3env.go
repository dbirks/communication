package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/artifacts"
	"github.com/dbirks/communication/internal/sandbox/nono"
	"github.com/dbirks/communication/internal/secrets"
)

// defaultArtifactRoot is where artifact bytes live when nothing says otherwise
// (the compose stack names its volume mount here, ADR-0020 D2).
const defaultArtifactRoot = "/var/lib/communication/artifacts"

// artifactBytesFromEnv builds the artifact backend this process talks to.
//
// `readOnly` is what a serving replica passes: its mount of the artifact volume
// is `ro` by contract (one writer — the worker — many readers), and a backend
// that learns EROFS three syscalls into a Put would be a worse answer than
// "this process cannot write".
//
// S3 credentials come from the deployment environment only, never from a
// SecretRef: "a storage credential that can write artifacts cannot be an
// artifact of the system it stores" (ADR-0020 D7).
func artifactBytesFromEnv(readOnly bool, log *slog.Logger) (artifacts.Store, error) {
	backend := strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_BACKEND"))
	if backend == "" {
		backend = artifacts.BackendLocal
	}
	root := strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_ROOT"))
	if root == "" {
		root = defaultArtifactRoot
	}
	switch backend {
	case artifacts.BackendLocal:
		store, err := artifacts.NewLocal(artifacts.LocalConfig{Root: root, ReadOnly: readOnly})
		if err != nil {
			return nil, fmt.Errorf("COMMUNICATION_ARTIFACT_BACKEND=local: %w", err)
		}
		return store, nil
	case artifacts.BackendS3:
		spool := strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_SPOOL"))
		if spool == "" {
			// The spool lives beside the local root by default because that is
			// a path this process can definitely write (the artifact volume):
			// an agent-writable temp directory would make a digested artifact
			// forgeable (ADR-0019 P9, ADR-0020 Consequences).
			spool = filepath.Join(root, ".spool")
		}
		store, err := artifacts.NewS3(artifacts.S3Config{
			Endpoint:       strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_S3_ENDPOINT")),
			Bucket:         strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_S3_BUCKET")),
			AccessKey:      os.Getenv("COMMUNICATION_ARTIFACT_S3_ACCESS_KEY"),
			SecretKey:      os.Getenv("COMMUNICATION_ARTIFACT_S3_SECRET_KEY"),
			Region:         strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_S3_REGION")),
			SpoolDir:       spool,
			ForcePathStyle: strings.TrimSpace(os.Getenv("COMMUNICATION_ARTIFACT_S3_PATH_STYLE")) != "false",
		})
		if err != nil {
			return nil, fmt.Errorf("COMMUNICATION_ARTIFACT_BACKEND=s3: %w", err)
		}
		return store, nil
	default:
		return nil, fmt.Errorf("COMMUNICATION_ARTIFACT_BACKEND %q is not local or s3", backend)
	}
}

// keyringFromEnvOrDefault loads the envelope keyring.
//
// The refusal rule distinguishes two configurations that look alike: an
// explicitly configured keyring that cannot be read is a broken deployment and
// must stop the process (ADR-0018 D2.3: "missing keyring at startup is a loud
// failure"), while an *unset* default directory is a deployment that has no
// secrets yet — M1/M2 serve keeps working, and the secret write routes refuse
// through SecretStore.Keys == nil exactly as the store is built to.
func keyringFromEnvOrDefault(log *slog.Logger) *secrets.Keyring {
	dir := strings.TrimSpace(os.Getenv(secrets.EnvKeyring))
	explicit := dir != ""
	if !explicit {
		dir = secrets.DefaultKeyring
	}
	keyring, err := secrets.LoadKeyring(dir)
	if err != nil {
		if explicit {
			log.Error("configured keyring is unreadable; secret writes will refuse to start",
				slog.String("dir", dir), slog.String("error", err.Error()))
			// The explicit case is fatal for the caller: runServe turns a nil
			// return with this log line into an exit-2 configuration refusal.
			return nil
		}
		log.Warn("no keyring at the default path; secret writes will refuse until one is mounted",
			slog.String("dir", dir), slog.String("error", err.Error()))
		return nil
	}
	log.Info("keyring loaded",
		slog.String("dir", dir),
		slog.Int("generations", len(keyring.KeyIDs())),
	)
	return keyring
}

// previewTokenSecret reads the HMAC key for preview/download tokens. An unset
// key is a *dev* default: a random per-process key, warned about loudly, so
// single-replica local runs work and a multi-replica deployment discovers the
// requirement (identical keys everywhere) by seeing 401s rather than by being
// silently secure-but-broken.
func previewTokenSecret(log *slog.Logger) []byte {
	if file := strings.TrimSpace(os.Getenv("COMMUNICATION_PREVIEW_TOKEN_SECRET_FILE")); file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			log.Error("COMMUNICATION_PREVIEW_TOKEN_SECRET_FILE is unreadable",
				slog.String("error", err.Error()))
			return nil
		}
		return append([]byte(nil), trimSecret(raw)...)
	}
	if inline := os.Getenv("COMMUNICATION_PREVIEW_TOKEN_SECRET"); inline != "" {
		return []byte(inline)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil
	}
	log.Warn("COMMUNICATION_PREVIEW_TOKEN_SECRET is unset: minted preview tokens will not verify on another replica or after a restart",
		slog.Bool("dev_default", true))
	return key
}

func trimSecret(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

// previewConfigFromEnv assembles the preview-origin wiring. Host and BaseURL
// are required together: one names the origin rule, the other the minted URL,
// and a deployment that sets only half has a router pointed at nothing.
func previewConfigFromEnv() (host, baseURL string, ttl time.Duration) {
	host = strings.TrimSpace(os.Getenv("COMMUNICATION_PREVIEW_HOST"))
	baseURL = strings.TrimRight(strings.TrimSpace(os.Getenv("COMMUNICATION_PREVIEW_BASE_URL")), "/")
	ttl = artifacts.DefaultTokenTTL
	if raw := strings.TrimSpace(os.Getenv("COMMUNICATION_PREVIEW_TOKEN_TTL")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			ttl = d
		}
	}
	return host, baseURL, ttl
}

// pinnedPolicy is the (version, digest) pair the deployment ships, read from
// code so GET /api/v1/system/sandbox can disagree with a worker that registered
// something else. DigestProfile of ProfileJSON(agent-turn) is the same digest
// the worker's written profile file carries (profile.go digests what it writes).
func pinnedPolicy() (string, string, error) {
	data, err := nono.ProfileJSON(nono.ProfileAgentTurn)
	if err != nil {
		return "", "", err
	}
	digest := nono.DigestProfile(data)
	if !strings.HasPrefix(digest, "sha256:") {
		return "", "", errors.New("serve: profile digest is malformed")
	}
	return nono.PinnedVersion, digest, nil
}
