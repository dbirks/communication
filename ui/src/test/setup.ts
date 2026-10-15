import { beforeEach, vi } from "vitest";
import { FakeEventSource } from "./fakes";

// jsdom implements neither EventSource nor a useful `fetch`: every test gets
// the fake EventSource, and `mockFetch()` installs the fetch stub per test.
beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
