import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { decodePendingFlow, encodePendingFlow, validatePendingFlowWire } from "./pending-flow-wire";
import { savePrivatePendingFlow, readPrivatePendingFlow, clearPrivatePendingFlow } from "../scopes/background/pending-flow-store";

const task = {
  sourceName: "sample.zip", archiveBytes: new Uint8Array([0, 128, 255]),
  values: { picture: { bytes: new Uint8Array([255, 0]), mime: "image/png" }, name: { text: "示例" } },
  targetPageId: "123456789", targetFlowId: "123", target: "comment" as const, applyWelcome: false,
};

beforeEach(() => {
  // Minimal event-driven adapter; covers transaction commit and ownership checks.
  const records = new Map<string, unknown>();
  vi.stubGlobal("indexedDB", {
    open: vi.fn((name: string) => {
      expect(name).toBe("botcake-private-pending-flow");
      const db = {
        createObjectStore() {}, close() {},
        transaction: () => {
          const tx: any = {};
          const request = (result: unknown) => {
            const req: any = { result };
            queueMicrotask(() => { req.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
            return req;
          };
          tx.objectStore = () => ({
            put: (value: any) => { records.set(value.id, structuredClone(value)); return request(value.id); },
            get: (id: string) => request(structuredClone(records.get(id))),
            delete: (id: string) => { records.delete(id); return request(undefined); },
          });
          return tx;
        },
      };
      const req: any = { result: db };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("round trips binary values through Chrome's JSON message format", () => {
  const wire = JSON.parse(JSON.stringify(encodePendingFlow(task)));
  expect(decodePendingFlow({ ...wire, id: "sample", createdAt: 1 })).toEqual({ ...task, id: "sample", createdAt: 1 });
});

it("rejects malformed task data at the background boundary", () => {
  expect(() => validatePendingFlowWire({ ...encodePendingFlow(task), targetPageId: "../../other" })).toThrow();
  expect(() => validatePendingFlowWire({ ...encodePendingFlow(task), archiveBase64: "<script>" })).toThrow();
});

it("prevents guessed task ids, cross-tab reads and cross-tab deletion", async () => {
  const id = await savePrivatePendingFlow(encodePendingFlow(task), 10);
  expect(await readPrivatePendingFlow("forged-id", 10)).toBeUndefined();
  expect(await readPrivatePendingFlow(id, 11)).toBeUndefined();
  await clearPrivatePendingFlow(id, 11);
  expect(decodePendingFlow((await readPrivatePendingFlow(id, 10))!)).toMatchObject(task);
  await clearPrivatePendingFlow(id, 10);
  expect(await readPrivatePendingFlow(id, 10)).toBeUndefined();
});

it("does not execute stale tasks", async () => {
  const id = await savePrivatePendingFlow(encodePendingFlow(task), 10);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  try { expect(await readPrivatePendingFlow(id, 10)).toBeUndefined(); } finally { clock.mockRestore(); }
});
