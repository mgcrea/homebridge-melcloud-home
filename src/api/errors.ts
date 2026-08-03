/** Credentials rejected, or the token chain is unrecoverable. Requires user action. */
export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}

/** The upstream returned 5xx. Transient — back off and retry. */
export class ServiceUnavailableError extends Error {
  override readonly name = "ServiceUnavailableError";
  constructor(readonly status: number) {
    super(`MELCloud Home is unavailable (HTTP ${status})`);
  }
}

/** Any other non-2xx from the API. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly path: string,
    body?: string,
  ) {
    super(`${path} failed with HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}
