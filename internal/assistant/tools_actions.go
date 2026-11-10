package assistant

// Assistant handoff §6 (CONTRACT §5): the risky SETUP tools — the writes a
// person asks for while getting the app running: create a project (with its
// repository), attach a repository to a project, put a workflow on a project,
// stop a run, and set up a recurring run.
//
// The rules are the ones every other risky tool keeps:
//
//   - Each name is exactly one ClassRisky row of the closed table
//     (trust.go), so ask_all and ask_risky stop it into an approval card
//     BEFORE anything runs, and no_ask still logs the change row.
//   - Registration is gated on the wired executor (the honest-degradation
//     rule): a deployment without the service never announces the tool, so
//     the model cannot ask for a write it would fail to run.
//   - The executor is internal/api's half: it runs the SAME
//     permission-checked store call the matching UI route runs, as the
//     caller. This package performs no authorization of its own.
//   - Args are the contract's, bounded like every other tool arg; a
//     credential travels by NAME only. (The descriptions below are part of
//     the request body scanForSecrets reads, so none of them may spell a
//     secret-shaped `token: <value>` — the guard refuses the whole turn.) A token never passes through the
//     model: the descriptions say so, and the store has no route that would
//     accept one here anyway (ADR-0018).

import "strings"

// registerActionTools announces the §6 setup writes. It is the second
// registration pass registerTools makes (after registerSetupTools).
func (r *ConversationRunner) registerActionTools() {
	if r.b == nil {
		return
	}
	stringProp := func(desc string) map[string]any {
		return map[string]any{"type": "string", "description": desc, "maxLength": 200}
	}
	reg := func(name, desc string, props map[string]any, require ...string) {
		if r.actions[name] == nil {
			return // an absent executor means the tool is not announced
		}
		r.regLocalTool(runnerTool{name: name, desc: desc, props: props, require: require})
	}

	reg("project.create",
		"Create a project, as the caller — and with repo_url, ALSO attach that repository (name = the repository name, git_url = https://github.com/<owner>/<repo>.git, the named credential, default_branch) in the SAME confirmation. RISKY: it creates real state. With no project yet, this one call IS the answer to \"add a repository\": there is no add-a-repo-without-a-project, so never send the person to a form for it. Run repo.check on the URL first (it tells you the repository, the default branch and whether the credential reaches it), and name the credential the caller can see from credential.list. NEVER ask for, accept or invent a token or secret value: a credential is only ever a NAME here, and adding one is the person's own job on /settings/secrets (or the project's Secrets page). Without an existing project this is the proposal card the person confirms — say what it will create.",
		map[string]any{
			"name":           stringProp("the project's display name, e.g. \"home-lab\""),
			"repo_url":       stringProp("optional: the repository to attach, e.g. https://github.com/acme/app.git or acme/app"),
			"credential":     stringProp("optional: the credential NAME from credential.list (or system.status) that can reach the repository — never a token"),
			"default_branch": stringProp("optional: the branch to check out; empty means main"),
		},
		"name")

	reg("repo.add",
		"Attach a repository to an EXISTING project, as the caller: the repository's name, its https://github.com/<owner>/<repo>.git remote, the credential it is cloned with (by NAME) and its default branch. RISKY: it changes what the project checks out and which secret a run may use. Run repo.check first. When the project does not exist yet, use project.create with repo_url instead — that is the one proposal for \"add a repo\". NEVER ask for or accept a token — the `credential` argument is a NAME from credential.list, and putting a token in the vault is the person's own job on /settings/secrets (or the project's Secrets settings).",
		map[string]any{
			"project_id":     stringProp("the project id from project.list"),
			"repo_url":       stringProp("the repository, e.g. https://github.com/acme/app.git or acme/app"),
			"credential":     stringProp("the credential NAME from credential.list that can reach the repository — never a token"),
			"default_branch": stringProp("optional: the branch to check out; empty means main"),
		},
		"project_id", "repo_url")

	reg("assignment.set",
		"Put a workflow on a project: the server pins the workflow's LATEST PUBLISHED REVISION, as the caller, through the same call the project's Assign route uses. RISKY: every NEW run of that project then uses that revision (runs already queued keep theirs). Read workflow.inspect first and pass the revision you saw as `revision` — the confirmation card names it, which is the promotion preview the person is approving. If the workflow has no published revision, say so instead of calling this.",
		map[string]any{
			"project_id":  stringProp("the project id from project.list"),
			"pipeline_id": stringProp("the pipeline id from workflow.list / workflow.inspect"),
			"revision":    stringProp("optional: the version label of the latest published revision you read (names it on the card); the server pins the latest published revision itself"),
		},
		"project_id", "pipeline_id")

	reg("run.cancel",
		"Cancel a run, as the caller — the same call the run's Cancel button makes. RISKY: it is a request the scheduler honours at the next boundary (in-flight attempts finish their work), and a cancelled run never resumes: a retry would be a new run. Only cancel the run the person named or the one on screen.",
		map[string]any{
			"run_id": stringProp("the run id (from run.list or the page context)"),
		},
		"run_id")

	reg("schedule.create",
		"Add a cron schedule to a project, as the caller: the same call the project's Schedules form makes, so the schedule starts a NEW run of the assignment's pinned revision on the timer. RISKY: it starts real work with no human in front of it. cron is the 5-field expression in UTC (\"minute hour day-of-month month day-of-week\", e.g. \"0 7 * * 1-5\" for weekday mornings); the server refuses one it cannot parse. The project must already have that workflow assigned (assignment.set) — if it does not, say so rather than guessing an assignment.",
		map[string]any{
			"project_id":  stringProp("the project id from project.list"),
			"pipeline_id": stringProp("the pipeline id whose assignment on this project fires (it must be assigned)"),
			"cron":        stringProp("the 5-field cron expression, UTC, e.g. \"0 7 * * 1-5\""),
		},
		"project_id", "pipeline_id", "cron")
}

// shortRepo renders a repository URL the way the approval card names it:
// `owner/repo`, the same canonical form the GitHub adapter and the run titles
// use. It is presentation only — it recognizes the shapes
// https://github.com/<owner>/<repo>[.git], ssh://git@github.com/<owner>/<repo>,
// git@github.com:<owner>/<repo> and a bare <owner>/<repo> — and answers "" for
// anything else, including a non-GitHub or file:// remote, so no card echoes a
// path into somebody else's filesystem.
func shortRepo(gitURL string) string {
	s := strings.TrimSpace(gitURL)
	if s == "" || strings.HasPrefix(s, "file://") {
		return ""
	}
	s = strings.TrimSuffix(s, "/")
	s = strings.TrimSuffix(s, ".git")
	// scp-style (git@host:path) or a scheme with optional user@.
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	// The user part of either form (`ssh://git@…`, `git@…:`): only ever a
	// prefix of the host, never part of the path.
	if j := strings.Index(s, "@"); j >= 0 && !strings.Contains(s[:j], "/") {
		s = s[j+1:]
	}
	if s == "" {
		return ""
	}
	// Everything up to the first colon or slash is the host, and only a host
	// that looks like one (it carries a dot) counts: a bare `owner/repo` has
	// no host at all. Only github.com is a GitHub repository, so a GitLab or
	// enterprise host is not named as one (the adapter's own rule).
	host, rest := "", s
	if j := strings.IndexAny(s, ":/"); j >= 0 {
		host, rest = s[:j], s[j+1:]
		if !strings.Contains(host, ".") {
			host, rest = "", s
		}
	}
	if host != "" && !strings.EqualFold(host, "github.com") {
		return ""
	}
	owner, repo, found := strings.Cut(strings.Trim(rest, "/"), "/")
	if !found || repo == "" || strings.Contains(repo, "/") {
		return ""
	}
	return owner + "/" + repo
}
