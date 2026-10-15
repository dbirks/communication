import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(cleanup);

function renderAt(path: string) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("routes", () => {
  it.each([
    ["/login", "Sign in"],
    ["/", "Projects"],
    ["/projects/p-1", "Project"],
    ["/ops", "Operations"],
    ["/does-not-exist", "Not found"],
  ])("%s renders the %s heading", (path, heading) => {
    renderAt(path);
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("nav contains links to the projects index and operations", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = nav.querySelectorAll("a");
    const hrefs = Array.from(links).map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/ops");
  });
});
