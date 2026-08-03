import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TokenSet, TokenStore } from "./auth.js";

/**
 * Persists tokens under Homebridge's storage directory so a restart does not
 * trigger a fresh login (and a fresh Cognito round-trip) every time.
 *
 * The file is keyed by a hash of the account email rather than the email
 * itself, and written 0600 — it holds a refresh token, which is a long-lived
 * credential for the whole account.
 */
export class FileTokenStore implements TokenStore {
  readonly #path: string;

  constructor(storagePath: string, username: string) {
    const key = createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 16);
    this.#path = join(storagePath, "melcloud-home", `${key}.json`);
  }

  async load(): Promise<TokenSet | undefined> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<TokenSet>;
      if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") {
        return undefined;
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
        expiresAt: parsed.expiresAt,
      };
    } catch {
      // Missing or corrupt cache is not an error — we just log in again.
      return undefined;
    }
  }

  async save(tokens: TokenSet): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await writeFile(this.#path, JSON.stringify(tokens), { encoding: "utf8", mode: 0o600 });
  }

  async clear(): Promise<void> {
    await unlink(this.#path).catch(() => undefined);
  }
}
