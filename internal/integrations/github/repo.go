package github

import (
	"net/url"
	"regexp"
	"strings"
)

// repoSegment is one path component of a GitHub remote: a username or
// repository name. GitHub itself allows alphanumerics, '-', '_' and '.';
// '.' and '..' are refused separately because they are directory traversal
// in every consumer of a checked-out name (`05`).
var repoSegment = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

// githubHost is the only host this adapter speaks to. A GitHub Enterprise
// host is a different deployment with a different base URL and is reported as
// "not a GitHub repository" rather than silently queried at api.github.com.
const githubHost = "github.com"

// ParseRepository reads owner and repo out of a repository git remote. It
// accepts the three forms a registered `repositories.git_url` can hold
// (internal/api/projects.go prjGitURLPattern):
//
//	https://github.com/o/r            https://github.com/o/r.git
//	git@github.com:o/r.git
//	ssh://git@github.com/o/r.git
//
// and returns a *NotGitHubRepositoryError for anything else, including a
// GitHub Enterprise host, a GitLab URL, a `file://` path, or a github.com URL
// that is not exactly `owner/repo` (`/owner/repo/issues` is a web page, not a
// remote). The `.git` suffix and a trailing slash are trimmed.
func ParseRepository(gitURL string) (Repository, error) {
	s := strings.TrimSpace(gitURL)
	if s == "" {
		return Repository{}, &NotGitHubRepositoryError{GitURL: gitURL}
	}

	// scp-style: [user@]host:path. There is no scheme, so url.Parse would read
	// the whole thing as a path; split it by hand on the first ':' after the
	// optional user@.
	host, path, ok := splitGitRemote(s)
	if !ok {
		return Repository{}, &NotGitHubRepositoryError{GitURL: gitURL}
	}
	if !strings.EqualFold(host, githubHost) {
		return Repository{}, &NotGitHubRepositoryError{GitURL: gitURL}
	}

	path = strings.Trim(path, "/")
	path = strings.TrimSuffix(path, ".git")
	owner, repo, found := strings.Cut(path, "/")
	if !found || strings.Contains(repo, "/") {
		return Repository{}, &NotGitHubRepositoryError{GitURL: gitURL}
	}
	if !validSegment(owner) || !validSegment(repo) {
		return Repository{}, &NotGitHubRepositoryError{GitURL: gitURL}
	}
	return Repository{Owner: owner, Name: repo}, nil
}

func validSegment(s string) bool {
	return s != "." && s != ".." && repoSegment.MatchString(s)
}

// splitGitRemote reduces every accepted form to (host, path). It reports
// false for anything that is not a host-and-path remote at all.
func splitGitRemote(s string) (host, path string, ok bool) {
	switch {
	case strings.HasPrefix(s, "ssh://"), strings.HasPrefix(s, "https://"),
		strings.HasPrefix(s, "http://"), strings.HasPrefix(s, "git://"):
		u, err := url.Parse(s)
		if err != nil || u.Host == "" {
			return "", "", false
		}
		// Strip any :port and any user@ the URL carried; the host is what
		// identifies GitHub, and a port on api.github.com:443 is not a hint
		// this adapter honours.
		h := u.Hostname()
		if h == "" {
			return "", "", false
		}
		return h, u.Path, true

	case strings.Contains(s, "://"):
		// file:// and any other scheme: not a GitHub remote.
		return "", "", false

	default:
		// scp-style. The ':' separator must come after the optional user@ and
		// before the first '/', or this is a relative path with a Windows-
		// style drive letter, not a remote.
		colon := strings.IndexByte(s, ':')
		if colon <= 0 {
			return "", "", false
		}
		head, tail := s[:colon], s[colon+1:]
		if at := strings.LastIndexByte(head, '@'); at >= 0 {
			head = head[at+1:]
		}
		if head == "" || tail == "" || strings.ContainsAny(head, "/\\") {
			return "", "", false
		}
		return head, tail, true
	}
}
