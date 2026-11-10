# ADR-0080 — Assistant speech-to-text runs server-side through an operator-configured transcription endpoint; browser speech becomes the fallback

- **Date:** 2026-11-10
- **Status:** Proposed
- **Owners:** assistant maintainers
- **Related decisions / contracts:** `communication-spec/08-assistant.md` ("Speech-to-text is a client input modality, not a new assistant backend contract" — this ADR supersedes that sentence), ADR-0034 (assistant egress), ADR-0077 (request rate limits), `docs/design/assistant-handoff/HANDOFF.md` §5 and `CONTRACT.md` §4.

## Context

Dictation today uses the browser's Web Speech API. Quality and availability vary by browser (Firefox has none, and Chrome sends audio to Google). The handoff makes the mic the primary input and asks for a self-hosted speech model (Qwen ASR on the operator's OpenAI-compatible gateway). The key for that endpoint must never reach the browser.

## Decision

1. `serve` exposes `POST /api/v1/assistant/transcriptions` (multipart `file`, at most 10 MiB, an audio media type). It forwards the audio to `{COMMUNICATION_SPEECH_BASE_URL}/audio/transcriptions` with `COMMUNICATION_SPEECH_MODEL`, authenticating with `COMMUNICATION_SPEECH_API_KEY[_FILE]`, and returns `{"text": …}`.
2. Audio is never stored. It is streamed to the upstream request and dropped, and neither the audio nor the transcript is logged. The transcript only lands in the composer, where the person edits or sends it like typed text.
3. The route sits behind session auth and the assistant rate limiter. An unconfigured endpoint returns 503 `speech_not_configured`, and an upstream failure returns 502 `speech_unavailable`.
4. The browser's Web Speech API is the fallback when the endpoint is unset or down (a per-user setting, on by default).
5. Messages the person dictated carry `spoken: true` on the stored user row, shown as a small "spoken" tag. That flag is the only server-side trace of speech.

## Consequences

- Dictation works in every browser that can record audio, and speech stays on the operator's infrastructure when it is configured.
- The new egress (audio to the speech endpoint) is operator-chosen, like the chat model's.
- Text-to-speech replies stay out of scope.

## Migration / rollback

There's no schema change. Unsetting the speech env vars returns the client to browser speech only.
