import { setupServer } from "msw/node";

/** Shared interception server; handlers are added per test. */
export const server = setupServer();
