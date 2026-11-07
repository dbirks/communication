package main

import (
	"os"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/api"
)

// Audit F6: both halves of the worker's file:// gate — the environment it
// parses at startup, and the dev mode that defaults it open.

func TestWorkerOptionsAllowFileGitURLs(t *testing.T) {
	env := func(kv map[string]string) func(string) string {
		base := map[string]string{
			"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
			"COMMUNICATION_SANDBOX_ENFORCEMENT": "disabled",
		}
		for k, v := range kv {
			base[k] = v
		}
		return func(k string) string { return base[k] }
	}
	t.Run("default false", func(t *testing.T) {
		o, err := workerOptionsFromEnv(env(nil))
		if err != nil {
			t.Fatalf("workerOptionsFromEnv: %v", err)
		}
		if o.allowFileGitURLs {
			t.Error("allowFileGitURLs = true, want the false default")
		}
	})
	t.Run("true", func(t *testing.T) {
		o, err := workerOptionsFromEnv(env(map[string]string{
			"COMMUNICATION_DATABASE_URL":        "postgres://communication@postgres:5432/communication",
			"COMMUNICATION_ALLOW_FILE_GIT_URLS": " true ",
		}))
		if err != nil {
			t.Fatalf("workerOptionsFromEnv: %v", err)
		}
		if !o.allowFileGitURLs {
			t.Error("allowFileGitURLs = false, want true")
		}
	})
	t.Run("unparseable refuses startup", func(t *testing.T) {
		_, err := workerOptionsFromEnv(env(map[string]string{
			"COMMUNICATION_ALLOW_FILE_GIT_URLS": "please",
		}))
		if err == nil || !strings.Contains(err.Error(), api.EnvAllowFileGitURLs) {
			t.Fatalf("err = %v, want it to name %s", err, api.EnvAllowFileGitURLs)
		}
	})
}

func TestDevDefaultAllowFileGitURLs(t *testing.T) {
	t.Run("unset becomes true and is cleaned up", func(t *testing.T) {
		if v, ok := os.LookupEnv(api.EnvAllowFileGitURLs); ok {
			t.Setenv(api.EnvAllowFileGitURLs, v) // arrange: the case needs it unset
			if err := os.Unsetenv(api.EnvAllowFileGitURLs); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if got := os.Getenv(api.EnvAllowFileGitURLs); got != v {
					t.Errorf("left %q, want the saved %q", got, v)
				}
			}()
		}
		restore := devDefaultAllowFileGitURLs()
		if got := os.Getenv(api.EnvAllowFileGitURLs); got != "true" {
			t.Errorf("env during dev = %q, want true", got)
		}
		restore()
		if _, ok := os.LookupEnv(api.EnvAllowFileGitURLs); ok {
			t.Error("restore must unset what the default set")
		}
	})
	t.Run("explicit false survives", func(t *testing.T) {
		t.Setenv(api.EnvAllowFileGitURLs, "false")
		restore := devDefaultAllowFileGitURLs()
		defer restore()
		if got := os.Getenv(api.EnvAllowFileGitURLs); got != "false" {
			t.Errorf("env = %q, want the explicit false to win", got)
		}
	})
}
