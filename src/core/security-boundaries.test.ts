import { describe, expect, it } from "vitest";
import { getByPath, parsePath, setByPath } from "../shared/utils";
import { readBoundedResponse } from "./remote-download";
import { redactCredential } from "./security-errors";
import { isAllowedBackgroundSender } from "./message-source";

it("allows extension pages and Botcake top frames while rejecting foreign senders", () => {
  const tab = { id: 1 } as chrome.tabs.Tab;
  expect(isAllowedBackgroundSender({ id: "test", url: "chrome-extension://test/options.html", tab }, "test")).toBe(true);
  expect(isAllowedBackgroundSender({ id: "test", url: "https://botcake.io/dashboard", frameId: 0, tab }, "test")).toBe(true);
  for (const sender of [
    { id: "foreign", url: "chrome-extension://test/options.html" },
    { id: "test", url: "https://botcake.io.evil.test/", frameId: 0, tab },
    { id: "test", url: "https://botcake.io/", frameId: 1, tab },
    { id: "test", url: "https://botcake.io/", frameId: 0 },
    { id: "test" },
  ]) expect(isAllowedBackgroundSender(sender, "test")).toBe(false);
});

it("redacts reflected tokens and bounds API error details", () => {
  const token = "fake/token+credential";
  const detail = `access_token=${encodeURIComponent(token)} raw ${token} token_jwt=other-secret ${"x".repeat(1000)}`;
  const result = redactCredential(detail, token);
  expect(result).not.toContain(token);
  expect(result).not.toContain(encodeURIComponent(token));
  expect(result).not.toContain("other-secret");
  expect(result.length).toBeLessThanOrEqual(500);
  expect(redactCredential('"authorization": "Bearer another-secret", "token":"third-secret"', "")).not.toMatch(/another-secret|third-secret/);
});

describe("untrusted template paths", () => {
  it("blocks prototype writes, including quoted keys", () => {
    for (const path of ['$.constructor.prototype.polluted', '$["__proto__"].polluted', '$.safe.__proto__']) {
      expect(() => setByPath({ safe: {} }, path, true)).toThrow();
    }
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it("rejects partially parsed paths and inherited traversal", () => {
    expect(() => parsePath('$.safe ignored[0]')).toThrow();
    const root = Object.create({ inherited: {} });
    expect(getByPath(root, "$.inherited")).toBeUndefined();
    expect(() => setByPath(root, "$.inherited.value", 1)).toThrow();
  });
  it("preserves array and escaped-key access", () => {
    const root = { items: [{ 'a.b': 0 }] };
    setByPath(root, '$.items[0]["a.b"]', 7);
    expect(getByPath(root, '$.items[0]["a.b"]')).toBe(7);
  });
});

describe("remote response limits", () => {
  it("stops and cancels chunked bodies without Content-Length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedResponse(new Response(stream), 5)).rejects.toThrow("超过");
    expect(cancelled).toBe(true);
  });
  it("accepts a response exactly at the boundary", async () => {
    expect(await readBoundedResponse(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
