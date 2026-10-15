// Package authz holds Communication's authorization policy as pure functions
// over plain values (communication-spec/01-domain-model.md "Authorization
// matrix", communication-spec/06-collaboration-identity.md).
//
// It deliberately imports nothing but the standard library: the same rules are
// evaluated by HTTP handlers, by the worker and by tests, and a policy that
// needed a database handle would be re-implemented (and drift) at each of
// those call sites. Callers resolve the role themselves — typically from a
// project membership lookup, with organization admins treated as maintainers
// of every project in their organization — and then ask this package whether
// the role is enough.
package authz

// Role is a project membership role. The string values are the ones stored in
// memberships.role and exposed as Project.my_role.
type Role string

const (
	// RoleMaintainer may do everything in M1: read the project and manage
	// its repositories and members.
	RoleMaintainer Role = "maintainer"
	// RoleContributor may read the project. M2 gives it run-creating powers.
	RoleContributor Role = "contributor"
	// RoleViewer may read the project.
	RoleViewer Role = "viewer"
	// RoleNone is the absence of a membership. It is the zero value so that a
	// failed membership lookup cannot accidentally grant anything.
	RoleNone Role = ""
)

// CanView reports whether the caller may read a project's non-sensitive
// state. Organization admins see every project in their organization; any
// explicit membership grants read.
func CanView(isOrgAdmin bool, r Role) bool {
	if isOrgAdmin {
		return true
	}
	switch r {
	case RoleMaintainer, RoleContributor, RoleViewer:
		return true
	default:
		return false
	}
}

// CanManage reports whether the caller may mutate a project (add
// repositories, change members). Maintainers and organization admins only:
// contributor and viewer are read-only in M1.
func CanManage(isOrgAdmin bool, r Role) bool {
	if isOrgAdmin {
		return true
	}
	return r == RoleMaintainer
}

// ValidRole reports whether s is a role that may be assigned to a
// membership. RoleNone is not assignable — it means "no membership".
func ValidRole(s string) bool {
	switch Role(s) {
	case RoleMaintainer, RoleContributor, RoleViewer:
		return true
	default:
		return false
	}
}
