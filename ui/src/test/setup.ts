import { beforeEach, vi } from "vitest";
import { configure } from "@testing-library/dom";
import { FakeEventSource } from "./fakes";

// Under a full parallel suite run a single render + query cycle can exceed
// the 1s `findBy*` default; give async queries headroom so machine load does
// not turn a rendered page into an "Unable to find" failure.
configure({ asyncUtilTimeout: 5000 });

// jsdom implements neither EventSource nor a useful `fetch`: every test gets
// the fake EventSource, and `mockFetch()` installs the fetch stub per test.
beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
