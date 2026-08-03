import type { AuthLogger } from "../src/api/auth.js";

/** A logger that records instead of printing, so tests can assert on it. */
export const createTestLogger = (): AuthLogger & { messages: string[] } => {
  const messages: string[] = [];
  return {
    messages,
    debug: (message) => messages.push(`debug: ${message}`),
    info: (message) => messages.push(`info: ${message}`),
    warn: (message) => messages.push(`warn: ${message}`),
  };
};

/** A signed-looking JWT. Structure only — never a real token. */
export const fakeJwt = (): string =>
  ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "c2lnbmF0dXJl"].join(".");
