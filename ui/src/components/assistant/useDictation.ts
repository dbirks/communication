/**
 * Dictation (handoff §5, CONTRACT §4) — the mic's whole state.
 *
 * The browser records; `serve` forwards the audio to the speech endpoint, so
 * the key never reaches the browser. Tap the mic to record, tap again to stop
 * and transcribe; the finished text comes back for the CALLER to append to its
 * own draft (the box stays editable and nothing is sent from here).
 *
 * `phase` is the composer's whole view of the mic:
 *   idle         — a tap starts a recording
 *   recording    — audio is being captured; a tap stops it
 *   transcribing — the clip is on its way to the server; the controls wait
 *
 * Degradation, in order: no `MediaRecorder`/`getUserMedia`, a blocked mic, or
 * a 503 (`speech_not_configured`) / 502 (`speech_unavailable`) from the server
 * falls back to the browser's Web Speech API while `speech_browser_fallback`
 * is not off. Where neither path is usable the failure is reported honestly
 * instead of the tap being swallowed.
 *
 * The two speech preferences and the speech model's name come from the same
 * documents the rest of the app already reads: `GET /api/v1/me/preferences`
 * (its `assistant` section, where `lib/prefs.ts` still names only the trust
 * level) and `GET /api/v1/assistant/status`. Absent values are the contract's
 * defaults — auto-send off, browser fallback on (CONTRACT §4).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, apiFetch, getCsrfToken } from "../../api/client";
import { isSpeechRecognitionSupported, useSpeechToText } from "../../lib/speech";

/** The one route this hook posts to (CONTRACT §4). */
export const TRANSCRIPTIONS_PATH = "/api/v1/assistant/transcriptions";

/** The status route the speech model's name is read from (CONTRACT §1). */
export const ASSISTANT_STATUS_PATH = "/api/v1/assistant/status";

const PREFERENCES_PATH = "/api/v1/me/preferences";

export type DictationPhase = "idle" | "recording" | "transcribing";

/** Who produced the transcript: the server's speech model, or the browser's. */
export type DictationSource = "server" | "browser";

export interface UseDictationOptions {
  /** A finished transcript — the caller owns appending it to the draft. */
  onTranscript: (text: string, source: DictationSource) => void;
  /** A short honest line for a dictation that produced nothing. */
  onError?: (message: string) => void;
  /** `speech_browser_fallback`: may the browser's own speech service take over? */
  browserFallback?: boolean;
  /** False when the server said it has no speech model: record nothing, ask
   * the browser instead (handoff §5's fallback, taken up front). */
  serverSpeech?: boolean;
}

export interface Dictation {
  phase: DictationPhase;
  /** Seconds of audio captured so far (the composer prints `m:ss`). */
  seconds: number;
  /** True while the Web Speech path is what is running. */
  usingBrowser: boolean;
  /** True when any dictation path exists at all. */
  supported: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/** --- preferences and the speech model ------------------------------------ */

export interface SpeechPrefs {
  /** Send the moment a dictation finishes (contract default: false). */
  autoSend: boolean;
  /** Fall back to the browser's Web Speech API (contract default: true). */
  browserFallback: boolean;
}

export const DEFAULT_SPEECH_PREFS: SpeechPrefs = { autoSend: false, browserFallback: true };

interface PreferencesWire {
  assistant?: { speech_auto_send?: unknown; speech_browser_fallback?: unknown };
}

/** What `GET /api/v1/assistant/status` says about the speech endpoint. */
export interface SpeechStatus {
  /** The speech model's id, or null when this server names none. */
  model: string | null;
  /** False ONLY when the server said so. An unreadable status (an older
   * `serve` with no status route at all) is not a "no": the recording goes up
   * anyway and the 503/502 path is what falls back to the browser. */
  configured: boolean;
}

const SPEECH_UNKNOWN: SpeechStatus = { model: null, configured: true };

/** One read per page life, shared by every mount (and testable in isolation
 * through `resetAssistantSpeechState`). */
let prefsCache: SpeechPrefs | null = null;
let prefsPromise: Promise<SpeechPrefs> | null = null;
const prefsListeners = new Set<() => void>();

function emitPrefs(): void {
  for (const listener of prefsListeners) listener();
}

function loadSpeechPrefs(): Promise<SpeechPrefs> {
  if (prefsPromise === null) {
    prefsPromise = (async () => {
      try {
        const wire = await apiFetch<PreferencesWire>(PREFERENCES_PATH);
        prefsCache = {
          autoSend: wire?.assistant?.speech_auto_send === true,
          // Absent means the contract default: on.
          browserFallback: wire?.assistant?.speech_browser_fallback !== false,
        };
      } catch {
        // No preferences endpoint, or a failed read: the defaults stand.
        prefsCache = DEFAULT_SPEECH_PREFS;
      }
      emitPrefs();
      return prefsCache;
    })();
  }
  return prefsPromise;
}

/** `useSpeechPrefs()` — the two speech settings, with the contract defaults. */
export function useSpeechPrefs(): SpeechPrefs {
  const read = () => prefsCache ?? DEFAULT_SPEECH_PREFS;
  const prefs = useSyncExternalStore(
    (onChange) => {
      prefsListeners.add(onChange);
      void loadSpeechPrefs();
      return () => prefsListeners.delete(onChange);
    },
    read,
    read,
  );
  return prefs;
}

let statusCache: SpeechStatus | null = null;
let statusPromise: Promise<SpeechStatus> | null = null;
const statusListeners = new Set<() => void>();

/**
 * One status read per page life. It names the speech model for the
 * transcribing row, and it says whether `serve` can transcribe at all — a
 * server with no speech model goes straight to the browser's own speech
 * instead of recording a clip nobody will read (handoff §5).
 */
function loadSpeechStatus(): Promise<SpeechStatus> {
  if (statusPromise === null) {
    statusPromise = (async () => {
      try {
        const status = await apiFetch<{
          speech_model?: { model?: unknown; configured?: unknown };
        }>(ASSISTANT_STATUS_PATH);
        const model = status?.speech_model?.model;
        statusCache = {
          model: typeof model === "string" && model.length > 0 ? model : null,
          configured: status?.speech_model?.configured !== false,
        };
      } catch {
        // No status route (older serve): say nothing, assume nothing.
        statusCache = SPEECH_UNKNOWN;
      }
      for (const listener of statusListeners) listener();
      return statusCache;
    })();
  }
  return statusPromise;
}

/** `useSpeechStatus()` — the speech model's name and whether it is there. */
export function useSpeechStatus(): SpeechStatus {
  const read = () => statusCache ?? SPEECH_UNKNOWN;
  return useSyncExternalStore(
    (onChange) => {
      statusListeners.add(onChange);
      void loadSpeechStatus();
      return () => statusListeners.delete(onChange);
    },
    read,
    read,
  );
}

/** Tests only: await the two page-life reads the composer kicks off. */
export function flushAssistantSpeechReads(): Promise<unknown> {
  return Promise.all([loadSpeechPrefs(), loadSpeechStatus()]);
}

/** Tests only: forget the cached read so the next mount reads again. */
export function resetAssistantSpeechState(): void {
  prefsCache = null;
  prefsPromise = null;
  statusCache = null;
  statusPromise = null;
}

/** --- the recorder --------------------------------------------------------- */

function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined
  );
}

/** The clip's mime, when the browser will take webm (Chrome, Firefox). */
function pickMime(): string {
  if (typeof window.MediaRecorder?.isTypeSupported !== "function") return "audio/webm";
  return window.MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
}

/** A 503/502 means "this server cannot transcribe" — the browser still may. */
function speechEndpointDown(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 503 || error.status === 502;
  // A fetch that never reached the server (offline, DNS, aborted).
  return error instanceof TypeError;
}

/**
 * `useDictation({onTranscript, onError, browserFallback})` — one microphone,
 * with the server's speech model in front and the browser's behind it.
 */
export function useDictation({
  onTranscript,
  onError,
  browserFallback = true,
  serverSpeech = true,
}: UseDictationOptions): Dictation {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [usingBrowser, setUsingBrowser] = useState(false);
  const speech = useSpeechToText();
  const speechTextRef = useRef("");
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const aliveRef = useRef(true);
  const browserModeRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // Never leave the mic open on unmount: the track is the permission.
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // The recording clock runs while the mic is open, whichever path opened it.
  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const stopTracks = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startBrowser = useCallback(() => {
    if (!isSpeechRecognitionSupported()) {
      setPhase("idle");
      onError?.("This browser can neither record audio nor transcribe it locally.");
      return false;
    }
    browserModeRef.current = true;
    speech.reset();
    speechTextRef.current = "";
    setUsingBrowser(true);
    setSeconds(0);
    setPhase("recording");
    speech.start();
    return true;
  }, [onError, speech]);

  /** Hand the clip to `serve` and report what came back. */
  const transcribe = useCallback(
    async (clip: Blob) => {
      try {
        const form = new FormData();
        form.append("file", clip, "dictation.webm");
        const headers = new Headers({ accept: "application/json" });
        const csrf = getCsrfToken();
        if (csrf) headers.set("x-csrf-token", csrf);
        const response = await fetch(TRANSCRIPTIONS_PATH, {
          method: "POST",
          body: form,
          headers,
          credentials: "same-origin",
        });
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          throw new ApiError(
            {
              type: "about:blank",
              title: response.status === 503 ? "speech_not_configured" : "speech_unavailable",
              status: response.status,
              detail: "",
            },
            body,
          );
        }
        const payload = (await response.json()) as { text?: unknown };
        if (!aliveRef.current) return;
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        setPhase("idle");
        if (text) onTranscript(text, "server");
        else onError?.("Nothing came back from that recording.");
      } catch (error) {
        if (!aliveRef.current) return;
        if (browserFallback && speechEndpointDown(error) && startBrowser()) return;
        setPhase("idle");
        onError?.(
          error instanceof ApiError && error.detail
            ? error.detail
            : "The speech service could not hear that — try the mic again.",
        );
      }
    },
    [browserFallback, onTranscript, onError, startBrowser],
  );

  const start = useCallback(() => {
    if (phase !== "idle") return;
    if (!serverSpeech && browserFallback) {
      startBrowser();
      return;
    }
    if (!canRecord()) {
      if (browserFallback) startBrowser();
      else {
        setPhase("idle");
        onError?.("This browser cannot record audio for the server to read.");
      }
      return;
    }
    chunksRef.current = [];
    setSeconds(0);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (!aliveRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const mime = pickMime();
        const recorder = mime
          ? new window.MediaRecorder(stream, { mimeType: mime })
          : new window.MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          recorderRef.current = null;
          const clip = new Blob(chunksRef.current, { type: mime || "audio/webm" });
          chunksRef.current = [];
          if (aliveRef.current) void transcribe(clip);
        };
        setUsingBrowser(false);
        setPhase("recording");
        recorder.start();
      })
      .catch(() => {
        if (!aliveRef.current) return;
        if (browserFallback) startBrowser();
        else onError?.("Microphone access is blocked — allow the mic and try again.");
      });
  }, [browserFallback, onError, phase, serverSpeech, startBrowser, transcribe]);

  const stop = useCallback(() => {
    if (browserModeRef.current) {
      speech.stop();
      browserModeRef.current = false;
      setUsingBrowser(false);
      const text = speechTextRef.current.trim();
      speechTextRef.current = "";
      setPhase("idle");
      if (text) onTranscript(text, "browser");
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setPhase("transcribing");
      recorder.stop();
    } else {
      stopTracks();
      setPhase("idle");
    }
  }, [onTranscript, speech, stopTracks]);

  const toggle = useCallback(() => {
    if (phase === "idle") start();
    else if (phase === "recording") stop();
  }, [phase, start, stop]);

  // A browser-mode recognition that ends on its own (Chrome's silence cut)
  // still owes the caller its transcript.
  useEffect(() => {
    if (speech.listening || !browserModeRef.current) return;
    browserModeRef.current = false;
    setUsingBrowser(false);
    const text = speechTextRef.current.trim();
    speechTextRef.current = "";
    setPhase("idle");
    if (text) onTranscript(text, "browser");
  }, [onTranscript, speech.listening]);

  useEffect(() => {
    if (speech.error && usingBrowser) onError?.(speech.error);
  }, [speech.error, usingBrowser, onError]);

  const supported = canRecord() || isSpeechRecognitionSupported();
  return { phase, seconds, usingBrowser, supported, start, stop, toggle };
}
