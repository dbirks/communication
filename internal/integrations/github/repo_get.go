package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// RepoInfo is GitHub's own answer about one repository, narrowed to the two
// facts a "can we use this repository?" question needs plus the identity the
// call addressed. Nothing here is authoritative for long: `07` is explicit
// that GitHub owns this data, and Communication caches none of it.
//
// CanPush is GitHub's `permissions.push` for the credential the call was made
// with, which is the honest answer to "can this token push" — an
// anonymous call reports false for anything but a public repository the
// viewer cannot write to.
type RepoInfo struct {
	// FullName is GitHub's `owner/repo`; it is what the caller echoes, so a
	// renamed or redirected repository reports the name GitHub used.
	FullName string
	// DefaultBranch is the repository's own default branch ("" when GitHub
	// answered none).
	DefaultBranch string
	// Private is GitHub's `private` flag.
	Private bool
	// CanPush is `permissions.push` for this credential.
	CanPush bool
}

// RepoGetter is the read of one repository's identity (assistant handoff §6's
// repo.check). Client implements it; the interface is what internal/api holds
// so a test can answer it without an egress.
type RepoGetter interface {
	GetRepo(ctx context.Context, repo Repository, token string) (RepoInfo, error)
}

// interface check: Client is a RepoGetter.
var _ RepoGetter = (*Client)(nil)

// GetRepo calls GET /repos/{owner}/{repo} — the same pinned media type and
// per-call bearer token as the issue read, behind the same transient-upstream
// retry. A 404 is ErrRepositoryNotFound, exactly as the issue list classifies
// it: for an anonymous call that also covers a private repository, which is
// why the caller reports "not reachable" rather than "does not exist".
func (c *Client) GetRepo(ctx context.Context, repo Repository, token string) (RepoInfo, error) {
	if repo.Owner == "" || repo.Name == "" {
		return RepoInfo{}, &NotGitHubRepositoryError{GitURL: repo.String()}
	}
	target := c.base() + "/repos/" + url.PathEscape(repo.Owner) + "/" + url.PathEscape(repo.Name)

	resp, err := c.getRetried(ctx, target, repo, token)
	if err != nil {
		return RepoInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return RepoInfo{}, fmt.Errorf("github: repository read answered %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return RepoInfo{}, fmt.Errorf("github: read repository response: %w", err)
	}
	var raw struct {
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
		Permissions   struct {
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return RepoInfo{}, fmt.Errorf("github: decode repository: %w", err)
	}
	return RepoInfo{
		FullName:      raw.FullName,
		DefaultBranch: raw.DefaultBranch,
		Private:       raw.Private,
		CanPush:       raw.Permissions.Push,
	}, nil
}
