package api

// ADR-0080's server-side dictation proxy: POST /api/v1/assistant/transcriptions
// (handoff § 5, CONTRACT § 4).
//
// The browser records; this route is the only thing that ever sees the speech
// endpoint's key. Three rules shape the implementation:
//
//   - Nothing is stored. The audio is held in memory only long enough to be
//     re-sent upstream and dropped: the upload is read with MultipartReader
//     (ParseMultipartForm would spool a large file to a temp file on disk) and
//     the outbound body is built in a bytes.Buffer. No temp file, no table row,
//     no artifact.
//   - Nothing is logged. Neither the audio bytes nor the transcript — nor any
//     upstream body — reaches a log line or a problem `detail`; the only thing
//     echoed is the caller's own filename, and even that is bounded.
//   - The failure answers are the contract's: unset endpoint is 503
//     `speech_not_configured`, an upstream error/deadline/malformed answer is
//     502 `speech_unavailable`. The client falls back to the browser's own
//     speech service on either.
//
// Session auth, CSRF and the assistant rate limiter come from HandleAuthed +
// ThrottleAssistant at registration, the same contract /assistant/ask has.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"strings"
	"time"
)

// The speech contract's bounds (CONTRACT § 4).
const (
	// SpeechMaxAudioBytes is the audio ceiling: at most 10 MiB of recording.
	SpeechMaxAudioBytes int64 = 10 << 20
	// speechFormMargin is the room allowed around the audio for the multipart
	// envelope itself (boundary lines, part headers, the model field).
	speechFormMargin int64 = 64 << 10
	// speechMaxTranscriptChars bounds the transcript this route will hand back.
	speechMaxTranscriptChars = 4000
	// speechUpstreamTimeout is the whole-call deadline on the speech endpoint.
	speechUpstreamTimeout = 30 * time.Second
	// speechUpstreamResponseBytes bounds how much of an upstream body is read;
	// a transcription answer is small, and a runaway gateway must not be able
	// to make this replica hold a large response.
	speechUpstreamResponseBytes = 64 << 10
	// speechMaxFilenameChars bounds the caller-supplied filename.
	speechMaxFilenameChars = 200
)

// speechProblemCodeNotConfigured and friends are the stable codes the UI
// branches on (CONTRACT § 4).
const (
	speechCodeNotConfigured = "speech_not_configured"
	speechCodeUnavailable   = "speech_unavailable"
	speechCodeAudioType     = "audio_type_not_allowed"
	speechCodeAudioTooLarge = "audio_too_large"
	speechCodeAudioMissing  = "audio_missing"
	speechCodeAudioEmpty    = "audio_empty"
)

// speechMediaTypes is the closed allow list of audio types the route accepts
// (CONTRACT § 4). Parameters are stripped before the lookup, so
// `audio/webm;codecs=opus` — what MediaRecorder actually sends — is allowed.
var speechMediaTypes = map[string]bool{
	"audio/webm":  true,
	"audio/ogg":   true,
	"audio/wav":   true,
	"audio/x-wav": true,
	"audio/mp4":   true,
	"audio/mpeg":  true,
}

// SpeechConfig is the resolved COMMUNICATION_SPEECH_* triple (ADR-0080). Like
// the assistant's own egress it is read by cmd/communication/serve.go and
// handed in: internal/api never touches os.Getenv. The key only ever reaches a
// request header — never a log line, a response body or an error detail.
type SpeechConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

// Configured reports whether the deployment has a speech endpoint at all:
// base URL plus model, the contract's rule. The key is optional — some
// self-hosted gateways sit behind no token.
func (c SpeechConfig) Configured() bool {
	return strings.TrimSpace(c.BaseURL) != "" && strings.TrimSpace(c.Model) != ""
}

// AssistantTranscription is the 200 answer: the transcript, trimmed and
// bounded, for the composer to drop into the draft.
type AssistantTranscription struct {
	Text string `json:"text"`
}

// RegisterAssistantSpeech mounts POST /api/v1/assistant/transcriptions with
// the production egress client. The route is mounted unconditionally and is
// honest about being unconfigured (503), like the assistant's own routes.
func RegisterAssistantSpeech(s *Server, cfg SpeechConfig) {
	registerAssistantSpeech(s, cfg, &http.Client{Timeout: speechUpstreamTimeout})
}

// registerAssistantSpeech is the seam tests use to carry a short deadline.
func registerAssistantSpeech(s *Server, cfg SpeechConfig, client *http.Client) {
	h := &speechHandlers{srv: s, cfg: cfg, client: client}
	s.HandleAuthed("POST /api/v1/assistant/transcriptions",
		s.ThrottleAssistant(http.HandlerFunc(h.transcribe)))
}

type speechHandlers struct {
	srv    *Server
	cfg    SpeechConfig
	client *http.Client
}

// transcribe forwards one recording to the speech endpoint and answers with its
// text. The request body is read here and dropped on return; nothing else
// observes it.
func (h *speechHandlers) transcribe(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.Configured() {
		assistantCodeProblem(w, http.StatusServiceUnavailable, speechCodeNotConfigured,
			"This deployment has no speech endpoint (set COMMUNICATION_SPEECH_BASE_URL and COMMUNICATION_SPEECH_MODEL).")
		return
	}

	// Hard ceiling on everything this handler will read off the wire: the audio
	// plus its multipart framing.
	r.Body = http.MaxBytesReader(w, r.Body, SpeechMaxAudioBytes+speechFormMargin)

	audio, filename, mediaType, err := h.readUpload(r)
	var maxBytesErr *http.MaxBytesError
	switch {
	case errors.As(err, &maxBytesErr) || errors.Is(err, errSpeechTooLarge):
		// Either the wire ceiling (MaxBytesReader) or the handler's own count of
		// the audio bytes refused it; the answer is the same.
		assistantCodeProblem(w, http.StatusRequestEntityTooLarge, speechCodeAudioTooLarge,
			"Audio is limited to 10 MiB.")
		return
	case errors.Is(err, errSpeechType):
		assistantCodeProblem(w, http.StatusUnsupportedMediaType, speechCodeAudioType,
			"Audio must be webm, ogg, wav, mp4 or mp3.")
		return
	case errors.Is(err, errSpeechMissing):
		assistantCodeProblem(w, http.StatusBadRequest, speechCodeAudioMissing,
			"The upload must carry a `file` field.")
		return
	case errors.Is(err, errSpeechEmpty):
		assistantCodeProblem(w, http.StatusBadRequest, speechCodeAudioEmpty,
			"That recording is empty.")
		return
	case err != nil:
		assistantCodeProblem(w, http.StatusBadRequest, speechCodeAudioMissing,
			"The upload could not be read.")
		return
	}

	text, err := h.forward(r, audio, filename, mediaType)
	if err != nil {
		// The upstream's own message is never repeated: it can quote the audio
		// endpoint's internals, and none of it helps the caller.
		h.srv.logger.Warn("assistant.speech: transcription failed", "cause", speechFailCause(err))
		assistantCodeProblem(w, http.StatusBadGateway, speechCodeUnavailable,
			"The speech service did not answer.")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, AssistantTranscription{Text: text})
}

// The upload reader's stable refusals. None of them carries audio content.
var (
	errSpeechType    = errors.New("speech: audio media type not allowed")
	errSpeechMissing = errors.New("speech: no file field")
	errSpeechEmpty   = errors.New("speech: empty audio")
)

// readUpload pulls the `file` part into memory. MultipartReader is deliberate:
// ParseMultipartForm would spool anything over its in-memory budget to a temp
// file, and audio must never touch disk.
func (h *speechHandlers) readUpload(r *http.Request) (audio []byte, filename, mediaType string, err error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, "", "", err
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, "", "", errSpeechMissing
		}
		if err != nil {
			return nil, "", "", err
		}
		if part.FormName() != "file" || part.FileName() == "" {
			_ = part.Close()
			continue
		}
		name := part.FileName()
		mediaType, err = speechAudioType(part)
		if err != nil {
			_ = part.Close()
			return nil, "", "", err
		}
		// +1 byte: one over the ceiling is the signal to refuse, not data to keep.
		data, err := io.ReadAll(io.LimitReader(part, SpeechMaxAudioBytes+1))
		closeErr := part.Close()
		if err != nil {
			return nil, "", "", err
		}
		if closeErr != nil {
			return nil, "", "", closeErr
		}
		if int64(len(data)) > SpeechMaxAudioBytes {
			return nil, "", "", errSpeechTooLarge
		}
		if len(data) == 0 {
			return nil, "", "", errSpeechEmpty
		}
		return data, speechFilename(name), mediaType, nil
	}
}

// errSpeechTooLarge is the in-budget oversize signal (the MaxBytesReader fires
// first on a real request; this catches a body that padded itself inside the
// envelope's margin).
var errSpeechTooLarge = errors.New("speech: audio over the ceiling")

// speechAudioType strips the media-type parameters and checks the bare type
// against the closed allow list.
func speechAudioType(part *multipart.Part) (string, error) {
	raw := part.Header.Get("Content-Type")
	base, _, err := mime.ParseMediaType(raw)
	if err != nil {
		base = strings.TrimSpace(strings.SplitN(raw, ";", 2)[0])
	}
	base = strings.ToLower(base)
	if !speechMediaTypes[base] {
		return "", errSpeechType
	}
	return base, nil
}

// speechFilename reduces the caller's filename to a bare, bounded base name:
// it is re-sent upstream as part of a header, so no path and no control
// characters may survive it.
func speechFilename(name string) string {
	name = filepath.Base(name)
	// A browser on Windows can hand over a backslashed path; filepath.Base does
	// not split on it here, so do it explicitly before the name goes into a
	// header.
	if i := strings.LastIndexByte(name, '\\'); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '_'
		}
		return r
	}, name)
	name = strings.ReplaceAll(name, "\"", "'")
	if name == "." || name == string(filepath.Separator) || name == "/" {
		return "audio"
	}
	if len(name) > speechMaxFilenameChars {
		ext := filepath.Ext(name)
		if len(ext) > 8 {
			ext = ""
		}
		name = name[:speechMaxFilenameChars-len(ext)] + ext
	}
	return name
}

// forward re-sends the recording as a fresh multipart body — `file` with the
// caller's filename and type plus the configured `model` — and returns the
// endpoint's trimmed text. The whole call carries the client's deadline.
func (h *speechHandlers) forward(r *http.Request, audio []byte, filename, mediaType string) (string, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("model", h.cfg.Model); err != nil {
		return "", err
	}
	hdr := make(textproto.MIMEHeader, 2)
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
	hdr.Set("Content-Type", mediaType)
	part, err := mw.CreatePart(hdr)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(audio); err != nil {
		return "", err
	}
	if err := mw.Close(); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(r.Context(), speechUpstreamTimeout)
	defer cancel()
	client := h.client
	if client == nil {
		client = &http.Client{Timeout: speechUpstreamTimeout}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(h.cfg.BaseURL, "/")+"/audio/transcriptions", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if key := strings.TrimSpace(h.cfg.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, speechUpstreamResponseBytes))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", errSpeechUpstreamStatus
	}
	var out struct {
		Text *string `json:"text"`
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, speechUpstreamResponseBytes))
	if err := dec.Decode(&out); err != nil {
		return "", errSpeechUpstreamBody
	}
	// An answer that is not an object with a string `text` (a gateway error
	// page, a bare array, trailing garbage) is not a transcript.
	if out.Text == nil || dec.More() {
		return "", errSpeechUpstreamBody
	}
	return speechBoundedText(*out.Text), nil
}

var (
	errSpeechUpstreamStatus = errors.New("speech: upstream returned an error")
	errSpeechUpstreamBody   = errors.New("speech: upstream returned no transcript")
)

// speechFailCause reduces an upstream error to one stable word for the log: the
// operator needs to know which way it failed, and nothing else.
func speechFailCause(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, errSpeechUpstreamStatus):
		return "upstream_status"
	case errors.Is(err, errSpeechUpstreamBody):
		return "upstream_body"
	default:
		return "unreachable"
	}
}

// speechBoundedText trims the transcript and clips it to the contract's bound
// on a rune boundary, so a client never renders half a character.
func speechBoundedText(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= speechMaxTranscriptChars {
		return s
	}
	cut := speechMaxTranscriptChars
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}
