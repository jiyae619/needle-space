// The admin pages write to the live catalog, so the login must turn away a
// wrong username once one is set, and keep working for anyone who has only
// set ADMIN_PASSWORD (otherwise deploying this would lock the owner out).
import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const login = (user: string, pass: string) =>
  proxy(new NextRequest("https://x.test/admin", {
    headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
  })).status;

afterEach(() => { delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD; });

describe("admin login", () => {
  it("needs both the right username and password once ADMIN_USERNAME is set", () => {
    process.env.ADMIN_USERNAME = "barista";
    process.env.ADMIN_PASSWORD = "pour-over";
    expect(login("barista", "pour-over")).toBe(200);
    expect(login("admin", "pour-over")).toBe(401);
    expect(login("barista", "wrong")).toBe(401);
    expect(login("", "pour-over")).toBe(401);
  });

  it("accepts any username when only ADMIN_PASSWORD is set, as before", () => {
    process.env.ADMIN_PASSWORD = "pour-over";
    expect(login("anyone", "pour-over")).toBe(200);
    expect(login("anyone", "nope")).toBe(401);
  });

  it("asks the browser for a login when there is none", () => {
    process.env.ADMIN_PASSWORD = "pour-over";
    const res = proxy(new NextRequest("https://x.test/admin"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("hides the admin pages outside dev when no password is set", () => {
    expect(login("barista", "pour-over")).toBe(404);
  });
});
