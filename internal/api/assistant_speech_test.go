package api

// Route tests for ADR-0080's transcription proxy (CONTRACT § 4): the forwarded
// multipart (model + file + Bearer key), the honest 503 when the deployment has
// no speech endpoint, the 502 when upstream fails or is slow, the 415/413 input
// refusals, the session rule, and the rule that audio never reaches disk.

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// speechRecorder is the scripted speech endpoint: it parses the forwarded
// multipart, remembers what arrived, and answers with a scripted status/body.
type speechRecorder struct {
	t        *testing.T
	mu       sync.Mutex
	calls    int
	path     string
	auth     string
	model    string
	filename string
	fileType string
	fileBody []byte
	status   int
	body     string
	delay    time.Duration
}

func (s *speechRecorder) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.delay > 0 {
			time.Sleep(s.delay)
		}
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "multipart/form-data" {
			s.t.Errorf("upstream content-type = %q (err %v), want multipart/form-data",
				r.Header.Get("Content-Type"), err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var model, filename, fileType string
		var fileBody []byte
		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				s.t.Errorf("upstream multipart: %v", err)
				return
			}
			data, err := io.ReadAll(part)
			if err != nil {
				s.t.Errorf("upstream part %s: %v", part.FormName(), err)
				return
			}
			switch part.FormName() {
			case "model":
				model = string(data)
			case "file":
				filename, fileType, fileBody = part.FileName(), part.Header.Get("Content-Type"), data
			}
			_ = part.Close()
		}
		s.mu.Lock()
		s.calls++
		s.path, s.auth = r.URL.Path, r.Header.Get("Authorization")
		s.model, s.filename, s.fileType, s.fileBody = model, filename, fileType, fileBody
		status, body := s.status, s.body
		s.mu.Unlock()
		if status == 0 {
			status = http.StatusOK
		}
		if body == "" {
			body = `{"text":"  hello world  "}`
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	})
}

func (s *speechRecorder) seen() (int, string, string, string, string, string, []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls, s.path, s.auth, s.model, s.filename, s.fileType, append([]byte(nil), s.fileBody...)
}

// speechMount builds the server with the route registered and the given speech
// config; a nil client gets a short deadline so a hung upstream cannot hang the
// test.
func speechMount(t *testing.T, cfg SpeechConfig, auth Authenticator, client *http.Client) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{PublicURL: "http://localhost:8080", Logger: discardLogger()},
		nil, fakeReadiness{expected: 1}, auth)
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	registerAssistantSpeech(s, cfg, client)
	return s
}

// speechUpload builds a multipart body with one `file` part carrying the given
// media type. CreateFormFile would force application/octet-stream, so the part
// is written with explicit headers the way a browser sends it.
func speechUpload(t *testing.T, filename, mediaType string, audio []byte) (string, io.Reader) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := make(map[string][]string, 2)
	h["Content-Disposition"] = []string{`form-data; name="file"; filename="` + filename + `"`}
	if mediaType != "" {
		h["Content-Type"] = []string{mediaType}
	}
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if _, err := part.Write(audio); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return mw.FormDataContentType(), &body
}

func speechPost(t *testing.T, s *Server, csrf bool, contentType string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		"http://localhost:8080/api/v1/assistant/transcriptions", body)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Origin", "http://localhost:8080")
	if csrf {
		req.Header.Set(HeaderCSRFToken, "csrf-token-value")
	}
	return do(t, s, req)
}

// speechCode decodes the problem body and checks that its `status` member
// matches the wire status, returning the stable `code`.
func speechCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Code   string `json:"code"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode problem %s: %v", rec.Body, err)
	}
	if out.Status != rec.Code {
		t.Fatalf("problem status = %d, body status %d", rec.Code, out.Status)
	}
	return out.Code
}

func TestSpeechTranscriptionForwardsToUpstream(t *testing.T) {
	t.Parallel()
	up := &speechRecorder{t: t, body: `{"text":"  ship it  "}`}
	srv := httptest.NewServer(up.handler())
	defer srv.Close()

	oks := testPrincipal()
	s := speechMount(t, SpeechConfig{BaseURL: srv.URL, APIKey: "sk-test", Model: "qwen3-asr-1-7b"},
		principalAuth(oks, nil), nil)
	audio := []byte("webm-bytes-\x00\xf0\x9f\x8e\xa4")
	ct, body := speechUpload(t, "dictation.webm", "audio/webm;codecs=opus", audio)
	rec := speechPost(t, s, true, ct, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out AssistantTranscription
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode answer %s: %v", rec.Body, err)
	}
	if out.Text != "ship it" {
		t.Fatalf("text = %q, want the upstream's trimmed text", out.Text)
	}
	calls, path, auth, model, filename, fileType, fileBody := up.seen()
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", calls)
	}
	if path != "/audio/transcriptions" {
		t.Fatalf("upstream path = %q, want /audio/transcriptions", path)
	}
	if auth != "Bearer sk-test" {
		t.Fatalf("upstream auth = %q, want the Bearer key", auth)
	}
	if model != "qwen3-asr-1-7b" {
		t.Fatalf("upstream model = %q, want the configured model", model)
	}
	if filename != "dictation.webm" || fileType != "audio/webm" {
		t.Fatalf("upstream file = %q/%q, want the caller's name and bare type", filename, fileType)
	}
	if !bytes.Equal(fileBody, audio) {
		t.Fatalf("upstream audio = %d bytes, want the caller's bytes", len(fileBody))
	}
	if ct := rec.Header().Get("Cache-Control"); ct != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", ct)
	}
}

func TestSpeechTranscriptionWithoutKeySendsNoAuth(t *testing.T) {
	t.Parallel()
	up := &speechRecorder{t: t}
	srv := httptest.NewServer(up.handler())
	defer srv.Close()

	s := speechMount(t, SpeechConfig{BaseURL: srv.URL, Model: "asr"},
		principalAuth(testPrincipal(), nil), nil)
	ct, body := speechUpload(t, "a.wav", "audio/wav", []byte("RIFF...."))
	rec := speechPost(t, s, true, ct, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if _, _, auth, _, _, _, _ := up.seen(); auth != "" {
		t.Fatalf("upstream auth = %q, want no header at all with no key", auth)
	}
}

func TestSpeechTranscriptionRefusesWhileUnconfigured(t *testing.T) {
	t.Parallel()
	for name, cfg := range map[string]SpeechConfig{
		"nothing set": {},
		"base only":   {BaseURL: "http://127.0.0.1:1"},
		"model only":  {Model: "asr"},
		"key only":    {APIKey: "sk"},
	} {
		t.Run(name, func(t *testing.T) {
			s := speechMount(t, cfg, principalAuth(testPrincipal(), nil), nil)
			ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
			rec := speechPost(t, s, true, ct, body)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503 (%s)", rec.Code, rec.Body)
			}
			if code := speechCode(t, rec); code != "speech_not_configured" {
				t.Fatalf("code = %q", code)
			}
		})
	}
}

func TestSpeechTranscriptionUpstreamFailuresAre502(t *testing.T) {
	t.Parallel()
	t.Run("upstream 500", func(t *testing.T) {
		up := &speechRecorder{t: t, status: http.StatusInternalServerError, body: "boom"}
		srv := httptest.NewServer(up.handler())
		defer srv.Close()
		s := speechMount(t, SpeechConfig{BaseURL: srv.URL, Model: "asr"},
			principalAuth(testPrincipal(), nil), nil)
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502 (%s)", rec.Code, rec.Body)
		}
		if code := speechCode(t, rec); code != "speech_unavailable" {
			t.Fatalf("code = %q", code)
		}
		if strings.Contains(rec.Body.String(), "boom") {
			t.Fatalf("detail leaked the upstream body: %s", rec.Body)
		}
	})
	t.Run("malformed json", func(t *testing.T) {
		up := &speechRecorder{t: t, body: `{"transcript":[]}!!!`}
		srv := httptest.NewServer(up.handler())
		defer srv.Close()
		s := speechMount(t, SpeechConfig{BaseURL: srv.URL, Model: "asr"},
			principalAuth(testPrincipal(), nil), nil)
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusBadGateway || speechCode(t, rec) != "speech_unavailable" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		up := &speechRecorder{t: t, delay: 400 * time.Millisecond}
		srv := httptest.NewServer(up.handler())
		defer srv.Close()
		s := speechMount(t, SpeechConfig{BaseURL: srv.URL, Model: "asr"},
			principalAuth(testPrincipal(), nil), &http.Client{Timeout: 50 * time.Millisecond})
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusBadGateway || speechCode(t, rec) != "speech_unavailable" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("endpoint unreachable", func(t *testing.T) {
		s := speechMount(t, SpeechConfig{BaseURL: "http://127.0.0.1:1", Model: "asr"},
			principalAuth(testPrincipal(), nil), &http.Client{Timeout: 500 * time.Millisecond})
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusBadGateway || speechCode(t, rec) != "speech_unavailable" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
}

func TestSpeechTranscriptionInputRefusals(t *testing.T) {
	t.Parallel()
	up := &speechRecorder{t: t}
	srv := httptest.NewServer(up.handler())
	defer srv.Close()
	newS := func(t *testing.T) *Server {
		t.Helper()
		return speechMount(t, SpeechConfig{BaseURL: srv.URL, Model: "asr"},
			principalAuth(testPrincipal(), nil), nil)
	}

	t.Run("wrong media type is 415", func(t *testing.T) {
		for _, mt := range []string{"application/octet-stream", "text/plain", "", "video/webm"} {
			s := newS(t)
			ct, body := speechUpload(t, "a.bin", mt, []byte("x"))
			rec := speechPost(t, s, true, ct, body)
			if rec.Code != http.StatusUnsupportedMediaType ||
				speechCode(t, rec) != "audio_type_not_allowed" {
				t.Fatalf("media type %q: status = %d body = %s", mt, rec.Code, rec.Body)
			}
		}
	})
	t.Run("oversize is 413", func(t *testing.T) {
		s := newS(t)
		// Over the 10 MiB ceiling by more than the multipart framing margin, so
		// the MaxBytesReader is what refuses it.
		huge := bytes.Repeat([]byte{0x01}, int(SpeechMaxAudioBytes)+128<<10)
		ct, body := speechUpload(t, "big.wav", "audio/wav", huge)
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusRequestEntityTooLarge ||
			speechCode(t, rec) != "audio_too_large" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("one byte over the ceiling is 413", func(t *testing.T) {
		// This body fits inside the envelope's margin, so it is the handler's own
		// audio ceiling that refuses it — and nothing goes upstream.
		s := newS(t)
		over := bytes.Repeat([]byte{0x02}, int(SpeechMaxAudioBytes)+1)
		ct, body := speechUpload(t, "edge.wav", "audio/wav", over)
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusRequestEntityTooLarge ||
			speechCode(t, rec) != "audio_too_large" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
		if calls, _, _, _, _, _, _ := up.seen(); calls != 0 {
			t.Fatalf("upstream calls = %d, want 0 — an oversize upload never egresses", calls)
		}
	})
	t.Run("no file part is 400", func(t *testing.T) {
		s := newS(t)
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField("model", "attacker-chose-it")
		if err := mw.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
		rec := speechPost(t, s, true, mw.FormDataContentType(), &buf)
		if rec.Code != http.StatusBadRequest || speechCode(t, rec) != "audio_missing" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("empty recording is 400", func(t *testing.T) {
		s := newS(t)
		ct, body := speechUpload(t, "a.webm", "audio/webm", nil)
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusBadRequest || speechCode(t, rec) != "audio_empty" {
			t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("not multipart is refused", func(t *testing.T) {
		s := newS(t)
		rec := speechPost(t, s, true, "application/json", strings.NewReader(`{"file":"nope"}`))
		if rec.Code < 400 || rec.Code > 499 {
			t.Fatalf("status = %d, want a 4xx (%s)", rec.Code, rec.Body)
		}
	})
}

func TestSpeechTranscriptionFollowsSessionAndCSFRules(t *testing.T) {
	t.Parallel()
	up := &speechRecorder{t: t}
	srv := httptest.NewServer(up.handler())
	defer srv.Close()
	cfg := SpeechConfig{BaseURL: srv.URL, Model: "asr"}

	t.Run("no session", func(t *testing.T) {
		s := speechMount(t, cfg, principalAuth(nil, ErrUnauthenticated), nil)
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
	t.Run("no csrf token", func(t *testing.T) {
		s := speechMount(t, cfg, principalAuth(testPrincipal(), nil), nil)
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, false, ct, body)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})
	t.Run("unconfigured still needs a session first", func(t *testing.T) {
		s := speechMount(t, SpeechConfig{}, principalAuth(nil, ErrUnauthenticated), nil)
		ct, body := speechUpload(t, "a.webm", "audio/webm", []byte("x"))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401 before the 503", rec.Code)
		}
	})
}

func TestSpeechTranscriptionNeverWritesAudioToDisk(t *testing.T) {
	t.Parallel()
	up := &speechRecorder{t: t, body: `{"text":"hello"}`}
	srv := httptest.NewServer(up.handler())
	defer srv.Close()

	before := tempDirNames(t)
	s := speechMount(t, SpeechConfig{BaseURL: srv.URL, APIKey: "sk", Model: "asr"},
		principalAuth(testPrincipal(), nil), nil)
	for _, name := range []string{"a.webm", "b.ogg", "c.wav"} {
		ct, body := speechUpload(t, name, "audio/ogg", bytes.Repeat([]byte{7}, 4096))
		rec := speechPost(t, s, true, ct, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (%s)", name, rec.Code, rec.Body)
		}
	}
	for name := range tempDirNames(t) {
		if !before[name] {
			t.Fatalf("temp file %q appeared while transcribing; audio must never touch disk", name)
		}
	}
}

func tempDirNames(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		t.Fatalf("read temp dir: %v", err)
	}
	out := make(map[string]bool, len(entries))
	for _, e := range entries {
		out[e.Name()] = true
	}
	return out
}

func TestSpeechBoundedTextClipsOnRuneBoundary(t *testing.T) {
	t.Parallel()
	got := speechBoundedText("  " + strings.Repeat("é", speechMaxTranscriptChars) + "  ")
	if len(got) > speechMaxTranscriptChars {
		t.Fatalf("len = %d, want at most %d", len(got), speechMaxTranscriptChars)
	}
	if !utf8.ValidString(got) {
		t.Fatal("clipped text is not valid utf-8")
	}
	if speechBoundedText("  hi \n") != "hi" {
		t.Fatalf("trim = %q, want the trimmed text", speechBoundedText("  hi \n"))
	}
}

func TestSpeechFilenameIsReducedToABaseName(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("x", 300) + ".wav"
	for name, want := range map[string]string{
		"dictation.webm":         "dictation.webm",
		"../../etc/passwd":       "passwd",
		`..\windows\win.ini`:     "win.ini",
		"a\x00b.webm":            "a_b.webm",
		`quo"te.webm`:            "quo'te.webm",
		long:                     strings.Repeat("x", 200-len(".wav")) + ".wav",
		".":                      "audio",
		"/":                      "audio",
		strings.Repeat("y", 400): strings.Repeat("y", 200),
	} {
		got := speechFilename(name)
		if got != want {
			t.Fatalf("speechFilename(%q) = %q, want %q", name, got, want)
		}
		if strings.ContainsAny(got, "/\\\r\n\"") {
			t.Fatalf("speechFilename(%q) = %q, want a safe base name", name, got)
		}
	}
}

func TestSpeechTranscriptionAcceptsTheContractMediaTypes(t *testing.T) {
	t.Parallel()
	// The contract's list, including the parameterised form MediaRecorder sends.
	for _, mt := range []string{"audio/webm", "audio/webm;codecs=opus", "audio/ogg",
		"audio/wav", "audio/x-wav", "audio/mp4", "audio/mpeg"} {
		up := &speechRecorder{t: t}
		srv := httptest.NewServer(up.handler())
		s := speechMount(t, SpeechConfig{BaseURL: srv.URL, Model: "asr"},
			principalAuth(testPrincipal(), nil), nil)
		ct, body := speechUpload(t, "clip", mt, []byte("bytes"))
		rec := speechPost(t, s, true, ct, body)
		srv.Close()
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (%s), want 200", mt, rec.Code, rec.Body)
		}
	}
}
