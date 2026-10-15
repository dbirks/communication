// Ports for the isolated e2e stack (e2e/compose.e2e.yml). Overridable for CI
// runners; defaults match the compose override file exactly.
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:28080";
export const API_A_URL = process.env.E2E_API_A_URL ?? "http://localhost:28081";
export const API_B_URL = process.env.E2E_API_B_URL ?? "http://localhost:28082";
