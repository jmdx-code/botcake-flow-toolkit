import { describe, expect, it } from "vitest";
import { groupManagedTokenCandidates, mergeManagedTokenPages, runWithTokenFallback } from "./analytics-token-management";

describe("analytics token management", () => {
  it("keeps a page while another token still grants access", () => {
    const first = { id: "first", pages: [{ id: "12345678", name: "Shared" }, { id: "87654321", name: "First only" }] };
    const second = { id: "second", pages: [{ id: "12345678", name: "Shared" }] };
    expect(mergeManagedTokenPages([first, second]).map((page) => page.id)).toEqual(["87654321", "12345678"]);
    expect(mergeManagedTokenPages([second]).map((page) => page.id)).toEqual(["12345678"]);
  });

  it("keeps every distinct token candidate for an overlapping page", () => {
    const page = { id: "12345678", name: "Shared" };
    expect(groupManagedTokenCandidates([
      { id: "first", token: "token-a", pages: [page] },
      { id: "duplicate", token: "token-a", pages: [page] },
      { id: "second", token: "token-b", pages: [page] },
    ])).toEqual({ "12345678": ["token-a", "token-b"] });
  });

  it("falls back to the next token after an access error", async () => {
    const attempted: string[] = [];
    const result = await runWithTokenFallback(["expired", "working"], async (token) => {
      attempted.push(token);
      if (token === "expired") throw new Error("401");
      return "ok";
    }, () => true);
    expect(result).toBe("ok");
    expect(attempted).toEqual(["expired", "working"]);
  });

  it("does not switch tokens for a non-access failure", async () => {
    const attempted: string[] = [];
    await expect(runWithTokenFallback(["first", "second"], async (token) => {
      attempted.push(token);
      throw new Error("server unavailable");
    }, () => false)).rejects.toThrow("server unavailable");
    expect(attempted).toEqual(["first"]);
  });
});
