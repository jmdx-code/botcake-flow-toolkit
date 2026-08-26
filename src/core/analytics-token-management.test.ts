import { describe, expect, it } from "vitest";
import { mergeManagedTokenPages } from "./analytics-token-management";

describe("analytics token management", () => {
  it("keeps a page while another token still grants access", () => {
    const first = { id: "first", pages: [{ id: "12345678", name: "Shared" }, { id: "87654321", name: "First only" }] };
    const second = { id: "second", pages: [{ id: "12345678", name: "Shared" }] };
    expect(mergeManagedTokenPages([first, second]).map((page) => page.id)).toEqual(["87654321", "12345678"]);
    expect(mergeManagedTokenPages([second]).map((page) => page.id)).toEqual(["12345678"]);
  });
});
