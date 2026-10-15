import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ApiError } from "./api/client";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Auth/authz answers (401/403/404) will not improve on retry; only retry
      // transport failures and 5xx a couple of times.
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status > 0 && error.status < 500
          ? false
          : failureCount < 2,
    },
    mutations: { retry: false },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
