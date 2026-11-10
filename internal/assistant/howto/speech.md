# Set up speech (dictation)

The mic in the assistant's composer dictates into the message box. With a
speech endpoint configured, `serve` forwards the recording to it, so the key
never reaches the browser.

Configure it on the `serve` process (restart to apply):

- `COMMUNICATION_SPEECH_BASE_URL` — an OpenAI-compatible server root.
- `COMMUNICATION_SPEECH_API_KEY` — optional, or
  `COMMUNICATION_SPEECH_API_KEY_FILE`.
- `COMMUNICATION_SPEECH_MODEL` — the model id (e.g. `qwen3-asr-1-7b`).

Base URL **and** model together are what count as configured. Then:

- Tap the mic to record, tap again to stop; the transcript is appended to
  whatever is already in the box.
- The recording goes up as webm / ogg / wav / mp4, at most 10 MiB. Audio is
  never stored, logged or written to disk — it is dropped after forwarding.
- **Settings → Assistant** holds the two speech choices: send the dictation
  straight away (off by default) and fall back to the browser's own speech
  service when the endpoint is missing or down (on by default).
- A dictated message gets a small `spoken` tag in the thread.
