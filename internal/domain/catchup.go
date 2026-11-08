package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"strings"
	"time"
)

// Catch-up types (communication-spec design handoff "Catch up", ADR-0078) are
// the vocabulary of "what did the agents do while I was away": a WorkItem is
// one piece of work, its Tour is the shared story of that work, a Stop is one
// beat of the story, and Seen/Recap/Visit are per-user state about reading it.
//
// Like every other type in this package these are SDK-free and
// database-free: they are the shapes the store round-trips and the surface
// renders. Tour text is MODEL OUTPUT RENDERED AS TEXT — nothing here
// interprets a narrative, and nothing here may be re-interpreted as an
// instruction (ADR-0078 § Security/privacy).

// CatchUpShape is the form one piece of work took. The assistant proposes it,
// but the generator reconciles the proposal against the run's refs — an
// issue ref makes `issue` sound, a PR ref makes `pr` sound, commits or a
// branch with no review make `push` sound — and the server's derivation wins
// an omitted, invalid or unfounded claim. The store still accepts any member
// of the set: this is the assistant's grouping vocabulary, not a state
// machine.
type CatchUpShape string

const (
	CatchUpShapeIssue CatchUpShape = "issue"
	CatchUpShapePR    CatchUpShape = "pr"
	CatchUpShapePush  CatchUpShape = "push"
)

func (s CatchUpShape) Validate() error {
	switch s {
	case CatchUpShapeIssue, CatchUpShapePR, CatchUpShapePush:
		return nil
	}
	return fmt.Errorf("%w: catchup shape %q", ErrCatchUpValidation, string(s))
}

// CatchUpResolution is how the work ended. Like shape it is proposed by the
// assistant and reconciled by the generator against the run's own facts
// (terminal run status, PR/branch/commit refs): the server's derivation wins
// an omitted, invalid or unfounded claim. `merged` stays the assistant's word
// for the one fate this server cannot verify — it is only ever believed on
// top of a real PR ref. It remains the assistant's claim about repository
// state, not a state machine the engine drives.
type CatchUpResolution string

const (
	CatchUpResolutionMerged      CatchUpResolution = "merged"
	CatchUpResolutionBranchReady CatchUpResolution = "branch_ready"
	CatchUpResolutionOpen        CatchUpResolution = "open"
	CatchUpResolutionRunFailed   CatchUpResolution = "run_failed"
	CatchUpResolutionNoCode      CatchUpResolution = "no_code"
)

func (r CatchUpResolution) Validate() error {
	switch r {
	case CatchUpResolutionMerged, CatchUpResolutionBranchReady, CatchUpResolutionOpen,
		CatchUpResolutionRunFailed, CatchUpResolutionNoCode:
		return nil
	}
	return fmt.Errorf("%w: catchup resolution %q", ErrCatchUpValidation, string(r))
}

// CatchUpImportance is what the tour says a beat is worth. Ranking is the
// SAME for every member of a project — tours are shared — so importance lives
// in the tour rather than in a per-user score (ADR-0078 § Decision 3).
type CatchUpImportance string

const (
	CatchUpImportanceMustKnow  CatchUpImportance = "must_know"
	CatchUpImportanceWorthLook CatchUpImportance = "worth_a_look"
	CatchUpImportanceRoutine   CatchUpImportance = "routine"
)

func (i CatchUpImportance) Validate() error {
	switch i {
	case CatchUpImportanceMustKnow, CatchUpImportanceWorthLook, CatchUpImportanceRoutine:
		return nil
	}
	return fmt.Errorf("%w: catchup importance %q", ErrCatchUpValidation, string(i))
}

// CatchUpEvidenceType is the discriminator on one piece of proof. The payload
// beside it is opaque to the server (ADR-0078 § Decision 2).
type CatchUpEvidenceType string

const (
	CatchUpEvidenceLog        CatchUpEvidenceType = "log"
	CatchUpEvidenceDiff       CatchUpEvidenceType = "diff"
	CatchUpEvidenceScreenshot CatchUpEvidenceType = "screenshot"
	CatchUpEvidenceFiles      CatchUpEvidenceType = "files"
)

func (t CatchUpEvidenceType) Validate() error {
	switch t {
	case CatchUpEvidenceLog, CatchUpEvidenceDiff, CatchUpEvidenceScreenshot,
		CatchUpEvidenceFiles:
		return nil
	}
	return fmt.Errorf("%w: catchup evidence type %q", ErrCatchUpValidation, string(t))
}

// Length caps. Each is a database CHECK in migration 00028 as well as a Go
// rule, so a writer that skips the store still cannot write nonsense.
const (
	CatchUpTitleMaxChars      = 200
	CatchUpSummaryMaxChars    = 500
	CatchUpReasonMaxChars     = 300
	CatchUpStopTitleMaxChars  = 200
	CatchUpNarrativeMaxChars  = 4000
	CatchUpStopIDMaxChars     = 128
	CatchUpKindMaxChars       = 64
	CatchUpReplyMaxChars      = 2000
	CatchUpRecapMaxChars      = 600
	CatchUpWindowMaxChars     = 64
	CatchUpStopsMax           = 24
	CatchUpDecisionOptionsMax = 4
)

// Errors the catch-up surface maps. A caller that may not be told a work item
// exists gets ErrCatchUpNotFound, the same answer as no work item at all —
// this is ADR-0014 § 3's rule for project-scoped reads, and it is why there is
// no "not a member" error to hand out.
var (
	ErrCatchUpNotFound   = errors.New("catchup: work item not found")
	ErrCatchUpValidation = errors.New("catchup: invalid input")
)

// CatchUpRefs is what the work touched: issue numbers, PR numbers, commit
// SHAs and run ids. It is a summary for the reader, not a join key — refs are
// the assistant's claim about GitHub and this deployment does not sync with
// GitHub (ADR-0078 § Decision 6).
type CatchUpRefs struct {
	IssueNumbers []int    `json:"issue_numbers,omitempty"`
	PRNumbers    []int    `json:"pr_numbers,omitempty"`
	CommitSHAs   []string `json:"commit_shas,omitempty"`
	RunIDs       []string `json:"run_ids,omitempty"`
}

// CatchUpRefsListMax bounds each list inside a refs object. A work item is a
// bounded story, not a repository dump: the assistant writes at most one issue
// and one PR per run and eight commits per run, and a group that has outgrown
// this cap has outgrown what a returning engineer can read (ADR-0063).
const CatchUpRefsListMax = 20

// UnionWith folds another claim set into this one: every number, sha and run id
// of `other` joins the list it appeared in — the four lists the contract has —
// deduped, in the order the reader first saw them, capped. This is what a rewritten work item's refs ARE — the
// union of everything the runs grouped under one piece of work named
// (ADR-0078 § Grouping) — so it is the contract's rule, not a store detail.
func (r CatchUpRefs) UnionWith(other CatchUpRefs) CatchUpRefs {
	return CatchUpRefs{
		IssueNumbers: unionCatchUpNumbers(r.IssueNumbers, other.IssueNumbers),
		PRNumbers:    unionCatchUpNumbers(r.PRNumbers, other.PRNumbers),
		CommitSHAs:   unionCatchUpStrings(r.CommitSHAs, other.CommitSHAs),
		RunIDs:       unionCatchUpStrings(r.RunIDs, other.RunIDs),
	}
}

func unionCatchUpNumbers(lists ...[]int) []int {
	seen := map[int]bool{}
	var out []int
	for _, list := range lists {
		for _, n := range list {
			if seen[n] {
				continue
			}
			seen[n] = true
			out = append(out, n)
			if len(out) >= CatchUpRefsListMax {
				return out
			}
		}
	}
	return out
}

func unionCatchUpStrings(lists ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range lists {
		for _, s := range list {
			s = strings.TrimSpace(s)
			if s == "" || seen[s] {
				continue
			}
			seen[s] = true
			out = append(out, s)
			if len(out) >= CatchUpRefsListMax {
				return out
			}
		}
	}
	return out
}

// The three shapes one piece of work takes (ADR-0078 § Grouping). A key is
// opaque to the store — it is the upsert's conflict target, nothing more — but
// the prefixes are part of the contract, because a key written by one replica
// must be the key another replica finds.
const (
	CatchUpGroupIssuePrefix = "issue:"
	CatchUpGroupPRPrefix    = "pr:"
	CatchUpGroupRunPrefix   = "run:"
	// CatchUpGroupKeyMaxChars bounds the column (migration 00029 CHECKs it):
	// a prefix, a repository uuid and an issue number do not come near it, so
	// hitting the cap means a caller invented a key rather than derived one.
	CatchUpGroupKeyMaxChars = 160
)

// CatchUpGroupKey names the piece of work a finished run belongs to, which is
// what the store's (project, group_key) unique index is the conflict target
// for. The order is the design's: an issue is the piece of work with its PRs
// and commits nested under it, so a run that names an issue joins that issue's
// item; a run that names only a PR joins the PR's item; a run that names
// nothing IS the piece of work, and is keyed by its own id so the run that
// produced it stays the whole story (ADR-0078 § Grouping).
//
// An issue or PR number is only meaningful inside a repository, so a run that
// names a number but belongs to none falls back to its own key rather than
// pretending two repositories' #7 are one story. "" means "no key at all": the
// caller named neither a number nor a run, and the (project, source_run_id)
// path is still the identity.
func CatchUpGroupKey(repositoryID string, issueNumber, prNumber int, runID string) string {
	if repo := strings.TrimSpace(repositoryID); repo != "" {
		if issueNumber > 0 {
			if k, ok := catchUpGroupKeyOf(CatchUpGroupIssuePrefix, repo, issueNumber); ok {
				return k
			}
		}
		if prNumber > 0 {
			if k, ok := catchUpGroupKeyOf(CatchUpGroupPRPrefix, repo, prNumber); ok {
				return k
			}
		}
	}
	if run := strings.TrimSpace(runID); run != "" {
		if k := CatchUpGroupRunPrefix + run; len(k) <= CatchUpGroupKeyMaxChars {
			return k
		}
	}
	return ""
}

func catchUpGroupKeyOf(prefix, repositoryID string, number int) (string, bool) {
	k := fmt.Sprintf("%s%s:%d", prefix, repositoryID, number)
	if len(k) > CatchUpGroupKeyMaxChars {
		return "", false
	}
	return k, true
}

// ValidCatchUpGroupKey reports whether a key is a legal group key. "" is legal
// and means "no grouping": an item that predates grouping, or one a caller
// wrote by id.
func ValidCatchUpGroupKey(key string) bool {
	if key == "" {
		return true
	}
	if key != strings.TrimSpace(key) || len(key) > CatchUpGroupKeyMaxChars {
		return false
	}
	for _, p := range []string{CatchUpGroupIssuePrefix, CatchUpGroupPRPrefix, CatchUpGroupRunPrefix} {
		if rest, ok := strings.CutPrefix(key, p); ok {
			return rest != "" && !strings.ContainsAny(rest, " \t\n\r")
		}
	}
	return false
}

// CatchUpEvidence is one piece of proof for one stop. `type` is the one member
// the server reads; everything else the model wrote beside it rides through as
// `Fields` and is rendered by the client that owns that type. `type` always
// wins on the way out, so a model cannot smuggle a second one into Fields.
type CatchUpEvidence struct {
	Type   CatchUpEvidenceType
	Fields map[string]any
}

func (e CatchUpEvidence) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(e.Fields)+1)
	for k, v := range e.Fields {
		out[k] = v
	}
	out["type"] = string(e.Type)
	return json.Marshal(out)
}

func (e *CatchUpEvidence) UnmarshalJSON(raw []byte) error {
	var in map[string]any
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Errorf("catchup evidence: %w", err)
	}
	typ, ok := in["type"].(string)
	if !ok {
		return fmt.Errorf("%w: catchup evidence carries no string type", ErrCatchUpValidation)
	}
	delete(in, "type")
	e.Type, e.Fields = CatchUpEvidenceType(typ), in
	return nil
}

// CatchUpDecision is the one thing a stop may ASK. It is a question with
// one-of-N labels and an optional free-text box — deliberately NOT a workflow
// gate: a gate keeps the fixed Approve/Request changes/Reject verbs and drives
// a run, while a decision reply is plain text handed to an agent conversation
// (ADR-0078 § Decision 4).
type CatchUpDecision struct {
	Prompt    string   `json:"prompt"`
	Options   []string `json:"options"`
	AllowText bool     `json:"allow_text"`
}

func (d CatchUpDecision) Validate() error {
	if n := len(strings.TrimSpace(d.Prompt)); n == 0 || n > CatchUpStopTitleMaxChars {
		return fmt.Errorf("%w: catchup decision prompt must be 1..%d characters",
			ErrCatchUpValidation, CatchUpStopTitleMaxChars)
	}
	if len(d.Options) == 0 || len(d.Options) > CatchUpDecisionOptionsMax {
		return fmt.Errorf("%w: catchup decision offers %d options, want 1..%d",
			ErrCatchUpValidation, len(d.Options), CatchUpDecisionOptionsMax)
	}
	for _, o := range d.Options {
		if n := len(strings.TrimSpace(o)); n == 0 || n > CatchUpStopTitleMaxChars {
			return fmt.Errorf("%w: catchup decision option must be 1..%d characters",
				ErrCatchUpValidation, CatchUpStopTitleMaxChars)
		}
	}
	return nil
}

// CatchUpStop is one beat of a tour. ID is stable across tour versions — the
// model is told to reuse the id of a beat it is rewriting — because seen
// state, SeenBy and decision replies are all keyed on it (ADR-0078 § Decision
// 3). Kind is a model-chosen label ("BUG · FIXED", "UI CHANGE", "YOUR CALL"),
// never a CHECKed vocabulary.
type CatchUpStop struct {
	ID         string            `json:"id"`
	Title      string            `json:"title"`
	Narrative  string            `json:"narrative"`
	Evidence   []CatchUpEvidence `json:"evidence,omitempty"`
	Kind       string            `json:"kind,omitempty"`
	Importance CatchUpImportance `json:"importance"`
	// AddedInVersion is the tour version that first introduced this stop. Zero
	// on input means "this one"; a stop carried over from an older version
	// keeps the version it came from, which is what makes a carried stop that
	// was already read stay read after the tour is rewritten (ADR-0078 §
	// Decision 3).
	AddedInVersion int              `json:"added_in_version,omitempty"`
	Decision       *CatchUpDecision `json:"decision,omitempty"`
}

func (s CatchUpStop) Validate() error {
	return s.validate(0)
}

// validate checks the stop, and when maxVersion > 0, that its
// added_in_version is a version that could exist at all.
func (s CatchUpStop) validate(maxVersion int) error {
	if n := len(strings.TrimSpace(s.ID)); n == 0 || n > CatchUpStopIDMaxChars {
		return fmt.Errorf("%w: catchup stop id must be 1..%d characters",
			ErrCatchUpValidation, CatchUpStopIDMaxChars)
	}
	if n := len(strings.TrimSpace(s.Title)); n == 0 || n > CatchUpStopTitleMaxChars {
		return fmt.Errorf("%w: catchup stop title must be 1..%d characters",
			ErrCatchUpValidation, CatchUpStopTitleMaxChars)
	}
	if n := len(strings.TrimSpace(s.Narrative)); n == 0 || n > CatchUpNarrativeMaxChars {
		return fmt.Errorf("%w: catchup narrative must be 1..%d characters",
			ErrCatchUpValidation, CatchUpNarrativeMaxChars)
	}
	if n := len(strings.TrimSpace(s.Kind)); n > CatchUpKindMaxChars {
		return fmt.Errorf("%w: catchup stop kind must be at most %d characters",
			ErrCatchUpValidation, CatchUpKindMaxChars)
	}
	if err := s.Importance.Validate(); err != nil {
		return err
	}
	for _, ev := range s.Evidence {
		if err := ev.Type.Validate(); err != nil {
			return err
		}
	}
	if s.Decision != nil {
		if err := s.Decision.Validate(); err != nil {
			return err
		}
	}
	if maxVersion > 0 && (s.AddedInVersion < 1 || s.AddedInVersion > maxVersion) {
		return fmt.Errorf("%w: catchup stop %q claims added_in_version %d, want 1..%d",
			ErrCatchUpValidation, s.ID, s.AddedInVersion, maxVersion)
	}
	return nil
}

// ValidateCatchUpStops checks an ordered stop list: every stop valid, ids
// unique inside the version (a duplicate id would make one click mark two
// beats read), and the count bounded.
func ValidateCatchUpStops(stops []CatchUpStop, maxVersion int) error {
	if len(stops) == 0 || len(stops) > CatchUpStopsMax {
		return fmt.Errorf("%w: catchup tour has %d stops, want 1..%d",
			ErrCatchUpValidation, len(stops), CatchUpStopsMax)
	}
	seen := make(map[string]bool, len(stops))
	for _, s := range stops {
		if err := s.validate(maxVersion); err != nil {
			return err
		}
		if seen[s.ID] {
			return fmt.Errorf("%w: catchup tour repeats stop id %q", ErrCatchUpValidation, s.ID)
		}
		seen[s.ID] = true
	}
	return nil
}

// StampCatchUpStops fills in the added_in_version of every stop that does not
// declare one, so a model that only writes new beats still produces a tour
// whose history is true. A stop that declares a version keeps it.
func StampCatchUpStops(stops []CatchUpStop, version int) {
	for i := range stops {
		if stops[i].AddedInVersion == 0 {
			stops[i].AddedInVersion = version
		}
	}
}

// CatchUpGroupItem is the work item a grouping key already names — the piece
// of work a SECOND run on the same issue (or the same PR) has just moved
// (ADR-0078 § Grouping). It is not a work item view: it is the minimum the
// generator may see to rewrite a story it did not write, which is the item's
// id, the thread its decisions belong in, and the newest tour's version,
// reason and stops.
type CatchUpGroupItem struct {
	ItemID         string
	ConversationID string
	TourHead       int
	Reason         string
	Stops          []CatchUpStop
}

// CatchUpWorkItem is one piece of work: an issue, a PR, or a push, with the
// refs and provenance the assistant derived it from.
type CatchUpWorkItem struct {
	ID         string `json:"id"`
	ProjectID  string `json:"project_id"`
	Shape      CatchUpShape
	Title      string
	Summary    string
	Resolution CatchUpResolution
	Refs       CatchUpRefs
	// SourceRunID is the run that produced the work, when one did. It has no
	// foreign key: a run pruned by retention must not take the record of what
	// it did with it (ADR-0078 § Migration).
	SourceRunID *string
	// ConversationID is the agent conversation the work came from. Decision
	// replies are posted here, which is why it is stored rather than derived.
	ConversationID *string
	// GroupKey is the identity of the PIECE OF WORK rather than of one run:
	// every run that names the same issue (or the same PR) in the same
	// repository rewrites the one item this key names, while source_run_id
	// stays "the run that moved it last". domain.CatchUpGroupKey derives it;
	// "" means the item is keyed by its run alone, exactly as before grouping
	// (ADR-0078 § Grouping).
	GroupKey  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (w CatchUpWorkItem) Validate() error {
	if err := w.Shape.Validate(); err != nil {
		return err
	}
	if err := w.Resolution.Validate(); err != nil {
		return err
	}
	if n := len(strings.TrimSpace(w.Title)); n == 0 || n > CatchUpTitleMaxChars {
		return fmt.Errorf("%w: catchup work item title must be 1..%d characters",
			ErrCatchUpValidation, CatchUpTitleMaxChars)
	}
	if n := len(strings.TrimSpace(w.Summary)); n == 0 || n > CatchUpSummaryMaxChars {
		return fmt.Errorf("%w: catchup work item summary must be 1..%d characters",
			ErrCatchUpValidation, CatchUpSummaryMaxChars)
	}
	if strings.TrimSpace(w.ProjectID) == "" {
		return fmt.Errorf("%w: catchup work item needs a project", ErrCatchUpValidation)
	}
	if !ValidCatchUpGroupKey(w.GroupKey) {
		return fmt.Errorf("%w: catchup work item group key %q is not issue:/pr:/run:-shaped",
			ErrCatchUpValidation, w.GroupKey)
	}
	return nil
}

// CatchUpTourVersionHeader is one version of a tour without its stops: what
// the surface needs to say "this story was rewritten, and here is why".
type CatchUpTourVersionHeader struct {
	Version   int       `json:"version"`
	Reason    string    `json:"reason"`
	StopCount int       `json:"stop_count"`
	CreatedAt time.Time `json:"created_at"`
}

// CatchUpTourVersion is one full version of a tour: a reason, a time, and the
// ordered stops as of that version.
type CatchUpTourVersion struct {
	WorkItemID string
	Version    int
	Reason     string
	Stops      []CatchUpStop
	CreatedAt  time.Time
}

func (v CatchUpTourVersion) Validate() error {
	if v.Version < 1 {
		return fmt.Errorf("%w: catchup tour version %d, want 1 or higher",
			ErrCatchUpValidation, v.Version)
	}
	if n := len(strings.TrimSpace(v.Reason)); n == 0 || n > CatchUpReasonMaxChars {
		return fmt.Errorf("%w: catchup tour reason must be 1..%d characters",
			ErrCatchUpValidation, CatchUpReasonMaxChars)
	}
	return ValidateCatchUpStops(v.Stops, v.Version)
}

// CatchUpWorkItemView is one work item as the surface reads it: the item, its
// latest tour, and the headers of every older version.
type CatchUpWorkItemView struct {
	CatchUpWorkItem
	Latest  *CatchUpTourVersion
	History []CatchUpTourVersionHeader
	// LatestVersion is 0 when the item has no tour yet — it exists but has no
	// story to read, so it appears in no unseen list (ADR-0078 § Decision 2).
	LatestVersion int
}

// CatchUpListItem is one row of "what this person has not read".
type CatchUpListItem struct {
	CatchUpWorkItem
	LatestVersion int
	// UnseenStops counts the stops of the LATEST version this user has not
	// viewed. Zero means the item is seen.
	UnseenStops int
	// Updated is true when the user saw an OLDER version: the story moved
	// after they read it, so the surface badges it UPDATED rather than NEW.
	Updated bool
}

// CatchUpSeenBy is one reader who has finished the latest version.
type CatchUpSeenBy struct {
	UserID      string
	DisplayName string
	SeenAt      time.Time
}

// CatchUpRecap is one cached per-visit summary.
type CatchUpRecap struct {
	ID         string
	UserID     string
	Text       string
	Window     string
	ProjectIDs []string
	WrittenAt  time.Time
}

func (r CatchUpRecap) Validate() error {
	if n := len(strings.TrimSpace(r.Text)); n == 0 || n > CatchUpRecapMaxChars {
		return fmt.Errorf("%w: catchup recap must be 1..%d characters",
			ErrCatchUpValidation, CatchUpRecapMaxChars)
	}
	if n := len(strings.TrimSpace(r.Window)); n == 0 || n > CatchUpWindowMaxChars {
		return fmt.Errorf("%w: catchup recap window must be 1..%d characters",
			ErrCatchUpValidation, CatchUpWindowMaxChars)
	}
	return nil
}

// CatchUpDecisionReply is one answer to a stop's question. The API posts
// Text, unchanged, to ConversationID when that id exists (ADR-0078 § Decision
// 4) — this struct is the store's record of the reply, not the delivery.
type CatchUpDecisionReply struct {
	ID             string
	WorkItemID     string
	StopID         string
	UserID         string
	Text           string
	ConversationID *string
	CreatedAt      time.Time
}

func (r CatchUpDecisionReply) Validate() error {
	if n := len(strings.TrimSpace(r.Text)); n == 0 || n > CatchUpReplyMaxChars {
		return fmt.Errorf("%w: catchup decision reply must be 1..%d characters",
			ErrCatchUpValidation, CatchUpReplyMaxChars)
	}
	if n := len(strings.TrimSpace(r.StopID)); n == 0 || n > CatchUpStopIDMaxChars {
		return fmt.Errorf("%w: catchup decision reply needs a stop id of 1..%d characters",
			ErrCatchUpValidation, CatchUpStopIDMaxChars)
	}
	return nil
}

// CatchUpProjectPalette is the fixed set a project's `color` may hold
// (migration 00028 CHECKs it). These are the muted hues the design picked
// because they are none of the state colours the same screen draws for
// resolutions — a chip that is both a project and "merged green" reads as one
// of those two things, wrongly.
var CatchUpProjectPalette = []string{
	"#6a4bc4", "#1f8077", "#4a5a78", "#a0527a", "#7a6a2a", "#2f6f9a", "#8a4b2a", "#5a7a3a",
}

// CatchUpProjectColor is the palette entry a project falls back to when its
// `color` column is NULL. The pick is by project id and never by name or
// creation order, so it is stable across replicas and across re-reads, and it
// needs no state: two engineers loading the same project see the same chip.
func CatchUpProjectColor(projectID string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(strings.ToLower(strings.TrimSpace(projectID))))
	// len is a constant here, but a modulo against a palette someone could
	// extend keeps the function honest if the set ever grows.
	return CatchUpProjectPalette[int(h.Sum32())%len(CatchUpProjectPalette)]
}

// CatchUpProjectColorOr returns the project's own colour when it has one, and
// the deterministic fallback when the column is NULL.
func CatchUpProjectColorOr(projectID, stored string) string {
	if s := strings.TrimSpace(stored); s != "" {
		return s
	}
	return CatchUpProjectColor(projectID)
}

// ValidCatchUpProjectColor reports whether a colour is in the palette. "" is
// valid: it is what "unset" means, and the column is nullable.
func ValidCatchUpProjectColor(color string) bool {
	if color == "" {
		return true
	}
	for _, c := range CatchUpProjectPalette {
		if strings.EqualFold(c, color) {
			return true
		}
	}
	return false
}
