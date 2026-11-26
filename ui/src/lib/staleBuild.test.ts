import { describe, expect, it } from "vitest";
import {
  STALE_RELOAD_WINDOW_MS,
  installStaleBuildReload,
  shouldReloadForStaleBuild,
} from "./staleBuild";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe("stale build reload", () => {
  it("reloads on the first chunk failure and not again inside the window", () => {
    const storage = memoryStorage();
    expect(shouldReloadForStaleBuild(storage, 1_000_000)).toBe(true);
    expect(shouldReloadForStaleBuild(storage, 1_000_000 + 5_000)).toBe(false);
    expect(shouldReloadForStaleBuild(storage, 1_000_000 + STALE_RELOAD_WINDOW_MS + 1)).toBe(true);
  });

  it("does not reload when storage is unavailable (no loop guard)", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(shouldReloadForStaleBuild(broken, 1)).toBe(false);
  });

  it("answers vite:preloadError with one reload and prevents the default", () => {
    const listeners: Record<string, (event: Event) => void> = {};
    let reloads = 0;
    const fakeWindow = {
      addEventListener: (name: string, fn: (event: Event) => void) => void (listeners[name] = fn),
      sessionStorage: memoryStorage(),
      location: { reload: () => void (reloads += 1) },
    } as unknown as Window;
    installStaleBuildReload(fakeWindow);
    const first = new Event("vite:preloadError", { cancelable: true });
    listeners["vite:preloadError"]!(first);
    expect(reloads).toBe(1);
    expect(first.defaultPrevented).toBe(true);
    const second = new Event("vite:preloadError", { cancelable: true });
    listeners["vite:preloadError"]!(second);
    expect(reloads).toBe(1);
    expect(second.defaultPrevented).toBe(false);
  });
});
