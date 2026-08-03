import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/api/cookie-jar.js";

const respondWith = (...cookies: string[]): Response =>
  new Response(null, { headers: cookies.map((value) => ["set-cookie", value]) });

describe("CookieJar", () => {
  it("stores a cookie and replays it to the same host", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("session=abc; path=/"), "https://auth.example.com/login");

    expect(jar.headerFor("https://auth.example.com/next")).toBe("session=abc");
  });

  it("keeps host-only cookies away from other hosts", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("session=abc"), "https://auth.example.com/login");

    expect(jar.headerFor("https://other.example.com/")).toBeUndefined();
  });

  it("sends domain cookies to subdomains", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("shared=1; Domain=.example.com"), "https://auth.example.com/");

    expect(jar.headerFor("https://api.example.com/")).toBe("shared=1");
  });

  it("carries several cookies through one request", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("a=1; path=/", "b=2; path=/"), "https://auth.example.com/");

    expect(jar.headerFor("https://auth.example.com/")).toBe("a=1; b=2");
  });

  it("respects the path attribute", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("scoped=1; path=/connect"), "https://auth.example.com/connect/par");

    expect(jar.headerFor("https://auth.example.com/connect/token")).toBe("scoped=1");
    expect(jar.headerFor("https://auth.example.com/account")).toBeUndefined();
  });

  it("overwrites a cookie of the same name, domain and path", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("session=old; path=/"), "https://auth.example.com/");
    jar.storeFrom(respondWith("session=new; path=/"), "https://auth.example.com/");

    expect(jar.headerFor("https://auth.example.com/")).toBe("session=new");
  });

  it("treats an expired cookie as a deletion", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("session=abc; path=/"), "https://auth.example.com/");
    jar.storeFrom(
      respondWith("session=; path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
      "https://auth.example.com/",
    );

    expect(jar.headerFor("https://auth.example.com/")).toBeUndefined();
  });

  it("honours Max-Age over Expires", () => {
    const jar = new CookieJar();
    jar.storeFrom(
      respondWith("session=abc; path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600"),
      "https://auth.example.com/",
    );

    expect(jar.headerFor("https://auth.example.com/")).toBe("session=abc");
  });

  it("ignores malformed Set-Cookie headers", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("nonsense", "=novalue"), "https://auth.example.com/");

    expect(jar.headerFor("https://auth.example.com/")).toBeUndefined();
  });

  it("clears everything on demand", () => {
    const jar = new CookieJar();
    jar.storeFrom(respondWith("session=abc; path=/"), "https://auth.example.com/");
    jar.clear();

    expect(jar.headerFor("https://auth.example.com/")).toBeUndefined();
  });
});
