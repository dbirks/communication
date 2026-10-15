package authz

import "testing"

func TestCanView(t *testing.T) {
	tests := []struct {
		name       string
		isOrgAdmin bool
		role       Role
		want       bool
	}{
		{"maintainer", false, RoleMaintainer, true},
		{"contributor", false, RoleContributor, true},
		{"viewer", false, RoleViewer, true},
		{"no membership", false, RoleNone, false},
		{"unknown role", false, Role("owner"), false},
		{"org admin without membership", true, RoleNone, true},
		{"org admin as viewer", true, RoleViewer, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanView(tt.isOrgAdmin, tt.role); got != tt.want {
				t.Errorf("CanView(%v, %q) = %v, want %v", tt.isOrgAdmin, tt.role, got, tt.want)
			}
		})
	}
}

func TestCanManage(t *testing.T) {
	tests := []struct {
		name       string
		isOrgAdmin bool
		role       Role
		want       bool
	}{
		{"maintainer manages everything", false, RoleMaintainer, true},
		{"contributor is read-only", false, RoleContributor, false},
		{"viewer is read-only", false, RoleViewer, false},
		{"stranger manages nothing", false, RoleNone, false},
		{"unknown role manages nothing", false, Role("admin"), false},
		{"org admin without membership", true, RoleNone, true},
		{"org admin outranks viewer", true, RoleViewer, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanManage(tt.isOrgAdmin, tt.role); got != tt.want {
				t.Errorf("CanManage(%v, %q) = %v, want %v", tt.isOrgAdmin, tt.role, got, tt.want)
			}
		})
	}
}

func TestManageImpliesView(t *testing.T) {
	for _, admin := range []bool{false, true} {
		for _, r := range []Role{RoleNone, RoleViewer, RoleContributor, RoleMaintainer, Role("bogus")} {
			if CanManage(admin, r) && !CanView(admin, r) {
				t.Errorf("CanManage(%v, %q) true while CanView false", admin, r)
			}
		}
	}
}

func TestValidRole(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"maintainer", true},
		{"contributor", true},
		{"viewer", true},
		{"", false},
		{"owner", false},
		{"admin", false},
		{"Maintainer", false},
		{" maintainer", false},
	}
	for _, tt := range tests {
		if got := ValidRole(tt.in); got != tt.want {
			t.Errorf("ValidRole(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestRoleValuesMatchStoredStrings(t *testing.T) {
	// These strings are the memberships.role check constraint and the
	// Project.my_role enum in api/openapi.yaml; changing one is a schema
	// change, so they are pinned literally here.
	for _, tt := range []struct {
		role Role
		want string
	}{
		{RoleMaintainer, "maintainer"},
		{RoleContributor, "contributor"},
		{RoleViewer, "viewer"},
		{RoleNone, ""},
	} {
		if string(tt.role) != tt.want {
			t.Errorf("role = %q, want %q", tt.role, tt.want)
		}
		if tt.want != "" && !ValidRole(tt.want) {
			t.Errorf("ValidRole(%q) = false, want true", tt.want)
		}
	}
}
