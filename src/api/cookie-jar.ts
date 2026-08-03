type Cookie = {
  value: string;
  domain: string;
  path: string;
  /** Host-only cookies are sent to the exact host; domain cookies to subdomains too. */
  hostOnly: boolean;
  expires: number | undefined;
};

/**
 * A deliberately small cookie jar.
 *
 * `fetch` has no cookie support, and the login flow bounces across
 * IdentityServer and the Cognito hosted UI carrying antiforgery and session
 * cookies the whole way. Rather than pull in a full RFC 6265 implementation for
 * a handful of first-party cookies, this covers what the flow actually uses:
 * domain/path matching, host-only cookies and expiry. Secure/SameSite are
 * irrelevant here — every hop is HTTPS and server-to-server.
 */
export class CookieJar {
  readonly #cookies = new Map<string, Cookie>();

  /** Absorb every `Set-Cookie` on a response, resolved against its URL. */
  storeFrom(response: Response, url: string): void {
    const headers = response.headers.getSetCookie?.() ?? [];
    for (const header of headers) {
      this.#store(header, new URL(url));
    }
  }

  #store(header: string, url: URL): void {
    const [pair, ...attributes] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator < 1) {
      return;
    }

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();

    let domain = url.hostname;
    let hostOnly = true;
    let path = "/";
    let expires: number | undefined;

    for (const attribute of attributes) {
      const index = attribute.indexOf("=");
      const key = (index === -1 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const attributeValue = index === -1 ? "" : attribute.slice(index + 1).trim();

      switch (key) {
        case "domain":
          if (attributeValue) {
            domain = attributeValue.replace(/^\./, "").toLowerCase();
            hostOnly = false;
          }
          break;
        case "path":
          if (attributeValue.startsWith("/")) {
            path = attributeValue;
          }
          break;
        case "max-age": {
          const seconds = Number(attributeValue);
          if (Number.isFinite(seconds)) {
            expires = Date.now() + seconds * 1000;
          }
          break;
        }
        case "expires": {
          // Max-Age wins per RFC 6265, so never let Expires clobber it.
          const parsed = Date.parse(attributeValue);
          if (!Number.isNaN(parsed) && expires === undefined) {
            expires = parsed;
          }
          break;
        }
        default:
          break;
      }
    }

    const key = `${domain}|${path}|${name}`;
    // An expired cookie is a deletion instruction, not a value to keep.
    if (expires !== undefined && expires <= Date.now()) {
      this.#cookies.delete(key);
      return;
    }
    this.#cookies.set(key, { value, domain, path, hostOnly, expires });
  }

  /** The `Cookie` header for a URL, or `undefined` when nothing matches. */
  headerFor(url: string): string | undefined {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const now = Date.now();
    const parts: string[] = [];

    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        this.#cookies.delete(key);
        continue;
      }
      if (!domainMatches(host, cookie.domain, cookie.hostOnly)) {
        continue;
      }
      if (!pathMatches(target.pathname, cookie.path)) {
        continue;
      }
      const name = key.slice(key.lastIndexOf("|") + 1);
      parts.push(`${name}=${cookie.value}`);
    }

    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  clear(): void {
    this.#cookies.clear();
  }
}

const domainMatches = (host: string, domain: string, hostOnly: boolean): boolean =>
  hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);

const pathMatches = (requestPath: string, cookiePath: string): boolean => {
  if (requestPath === cookiePath || cookiePath === "/") {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
};
