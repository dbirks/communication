package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunModes(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		wantCode   int
		wantStdout string
		wantStderr string
	}{
		{
			name:       "version",
			args:       []string{"version"},
			wantCode:   0,
			wantStdout: "communication dev",
		},
		{name: "serve", args: []string{"serve"}, wantCode: 2, wantStderr: "not implemented"},
		{name: "worker", args: []string{"worker"}, wantCode: 2, wantStderr: "not implemented"},
		{name: "dev", args: []string{"dev"}, wantCode: 2, wantStderr: "not implemented"},
		{name: "migrate", args: []string{"migrate"}, wantCode: 2, wantStderr: "usage"},
		{name: "unknown mode", args: []string{"frobnicate"}, wantCode: 2, wantStderr: `unknown mode "frobnicate"`},
		{name: "no args", args: nil, wantCode: 2, wantStderr: "usage"},
		{name: "help", args: []string{"help"}, wantCode: 0, wantStdout: "usage"},
		{name: "-h", args: []string{"-h"}, wantCode: 0, wantStdout: "usage"},
		{name: "--help", args: []string{"--help"}, wantCode: 0, wantStdout: "usage"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			got := run(tt.args, &stdout, &stderr)
			if got != tt.wantCode {
				t.Errorf("run(%v) = %d, want %d", tt.args, got, tt.wantCode)
			}
			if tt.wantStdout != "" && !strings.Contains(stdout.String(), tt.wantStdout) {
				t.Errorf("stdout = %q, want substring %q", stdout.String(), tt.wantStdout)
			}
			if tt.wantStderr != "" && !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Errorf("stderr = %q, want substring %q", stderr.String(), tt.wantStderr)
			}
		})
	}
}
