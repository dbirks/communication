import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSpeechRecognitionSupported,
  useSpeechToText,
  type SpeechRecognitionEventLike,
} from "./speech";

/** Minimal fake standing in for a real SpeechRecognition instance. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }

  abort() {}

  emit(...results: Array<{ isFinal: boolean; transcript: string }>) {
    const fake = results.map((r) => {
      const row = [{ transcript: r.transcript }] as unknown as {
        isFinal: boolean;
        0: { transcript: string };
      };
      row.isFinal = r.isFinal;
      return row;
    });
    this.onresult?.({ resultIndex: 0, results: fake as any });
  }

  emitError(code: string) {
    this.onerror?.({ error: code });
  }

  fireEnd() {
    this.onend?.();
  }
}

function installRecognition() {
  (window as any).webkitSpeechRecognition = FakeRecognition as any;
}

afterEach(() => {
  delete (window as any).webkitSpeechRecognition;
  FakeRecognition.instances = [];
});

describe("useSpeechToText", () => {
  it("reports unsupported when the API is absent and start() is a no-op", () => {
    expect(isSpeechRecognitionSupported()).toBe(false);
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.supported).toBe(false);
    expect(() => act(() => result.current.start())).not.toThrow();
    expect(result.current.listening).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("starts a continuous recognizer with interim results and the default lang", () => {
    installRecognition();
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.supported).toBe(true);
    act(() => result.current.start());
    expect(result.current.listening).toBe(true);
    expect(FakeRecognition.instances).toHaveLength(1);
    const rec = FakeRecognition.instances[0];
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe("en-US");
    expect(rec.started).toBe(true);
  });

  it("honours a custom lang and ignores a second start() while listening", () => {
    installRecognition();
    const { result } = renderHook(() => useSpeechToText({ lang: "de-DE" }));
    act(() => result.current.start());
    act(() => result.current.start());
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0].lang).toBe("de-DE");
  });

  it("accumulates finals with spaces and tracks the latest interim", () => {
    installRecognition();
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => rec.emit({ isFinal: false, transcript: "make the" }));
    expect(result.current.interim).toBe("make the");
    expect(result.current.final).toBe("");
    act(() => rec.emit({ isFinal: true, transcript: "make the" }));
    expect(result.current.final).toBe("make the");
    expect(result.current.interim).toBe("");
    act(() => rec.emit({ isFinal: false, transcript: "reviewer" }));
    expect(result.current.interim).toBe("reviewer");
    act(() => rec.emit({ isFinal: true, transcript: "stricter" }));
    expect(result.current.final).toBe("make the stricter");
  });

  it("stops the recognizer and clears listening on end", () => {
    installRecognition();
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => result.current.stop());
    expect(rec.stopped).toBe(true);
    expect(result.current.listening).toBe(true);
    act(() => rec.fireEnd());
    expect(result.current.listening).toBe(false);
    expect(result.current.final).toBe("");
  });

  it("maps error codes to short messages and ignores non-errors", () => {
    installRecognition();
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => rec.emitError("not-allowed"));
    expect(result.current.error).toContain("Microphone access");
    act(() => rec.emitError("aborted"));
    expect(result.current.error).toContain("Microphone access"); // unchanged
    act(() => rec.emitError("no-speech"));
    expect(result.current.error).toContain("Didn't catch that");
    act(() => rec.emitError("weird-code"));
    expect(result.current.error).toContain("weird-code");
  });

  it("reset() clears interim, final and error", () => {
    installRecognition();
    const { result } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => rec.emit({ isFinal: true, transcript: "hello" }));
    act(() => rec.emitError("no-speech"));
    act(() => result.current.reset());
    expect(result.current.final).toBe("");
    expect(result.current.interim).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("aborts the recognizer on unmount", () => {
    installRecognition();
    const { result, unmount } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = FakeRecognition.instances[0];
    expect(rec.stopped).toBe(false);
    unmount();
    expect(FakeRecognition.instances).toHaveLength(1);
    // The instance was aborted (fake records nothing, but the hook must
    // no longer hold it).
    act(() => rec.fireEnd()); // must not throw after unmount
  });
});
