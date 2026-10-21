/**
 * Web Speech API hook — client-side input modality only (spec 08:
 * speech-to-text is a client input, not an assistant backend contract).
 *
 * Uses `window.SpeechRecognition || window.webkitSpeechRecognition` in
 * continuous mode with interim results. `supported` is false where the
 * API is absent (e.g. Firefox) — callers hide the mic and never surface
 * a dead button. The transcript is delivered to the caller as editable
 * text; nothing is ever sent automatically.
 *
 * Minimal local typings: the DOM lib does not include the Speech
 * Recognition interfaces, and we must not depend on an @types package.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when the browser exposes a usable SpeechRecognition constructor. */
export function isSpeechRecognitionSupported(): boolean {
  return typeof window !== "undefined" && recognitionCtor() !== null;
}

/** Short user-facing messages for the error codes callers care about. */
const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access is blocked — allow the mic and try again.",
  "service-not-allowed": "Microphone access is blocked — allow the mic and try again.",
  "no-speech": "Didn't catch that — try again.",
  network: "The speech service is unreachable.",
  "audio-capture": "No microphone is available.",
};

function errorMessageFor(code: string): string | null {
  if (code === "aborted" || code === "invalid-argument" || code === "syntax-error") {
    return null;
  }
  return ERROR_MESSAGES[code] ?? `Speech input failed (${code}).`;
}

export interface UseSpeechToTextOptions {
  /** BCP-47 locale hint for the recognizer; defaults to "en-US". */
  lang?: string;
}

export interface SpeechToText {
  /** False when the browser has no SpeechRecognition — hide the mic. */
  supported: boolean;
  listening: boolean;
  /** Latest in-progress (interim) transcript fragment. */
  interim: string;
  /** Accumulated final transcript, words separated by spaces. */
  final: string;
  /** Short message for the latest actionable error, or null. */
  error: string | null;
  start: () => void;
  stop: () => void;
  /** Clears interim, final and error (the recognizer keeps running). */
  reset: () => void;
}

export function useSpeechToText(options: UseSpeechToTextOptions = {}): SpeechToText {
  const { lang = "en-US" } = options;
  const [supported] = useState(isSpeechRecognitionSupported);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [final, setFinal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const start = useCallback(() => {
    if (recognitionRef.current) return;
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;
    rec.onresult = (event) => {
      let newInterim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          setFinal((prev) => (prev ? `${prev} ${text}` : text));
        } else {
          newInterim += text;
        }
      }
      setInterim(newInterim);
    };
    rec.onerror = (event) => {
      const message = errorMessageFor(event.error);
      if (message) setError(message);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setError(null);
      setListening(true);
    } catch {
      // Chrome throws InvalidStateError if start() raced another start.
      recognitionRef.current = null;
      setListening(false);
    }
  }, [lang]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const reset = useCallback(() => {
    setInterim("");
    setFinal("");
    setError(null);
  }, []);

  // Never leave a live recognizer behind when the caller unmounts.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return { supported, listening, interim, final, error, start, stop, reset };
}
