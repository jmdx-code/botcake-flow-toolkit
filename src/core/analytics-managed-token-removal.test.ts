import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsPage } from "../shared/types";

type RecordStub = { id: string; token: string; label: string; pages: AnalyticsPage[]; addedAt: number };

const vault = vi.hoisted(() => ({
  records: [] as RecordStub[],
}));

vi.mock("../scopes/background/analytics-token-vault", () => ({
  readAnalyticsManagedTokens: vi.fn(async () => vault.records),
  writeAnalyticsManagedTokens: vi.fn(async (records: RecordStub[]) => { vault.records = records; }),
  createAnalyticsManagedToken: vi.fn(),
  mergeAnalyticsExternalTokens: vi.fn(),
  readAnalyticsExternalTokenCandidates: vi.fn(async () => ({})),
}));

import { AnalyticsBackgroundService } from "../scopes/background/analytics";

describe("managed Token removal", () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    vault.records = [];
    storage = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.map((key) => [key, storage[key]]));
          }),
          set: vi.fn(async (updates: Record<string, unknown>) => { Object.assign(storage, updates); }),
        },
      },
    });
  });

  it("returns an empty directory after deleting the last Token even when primary directory refresh fails", async () => {
    vault.records = [{
      id: "only",
      token: "managed-token-value-long-enough",
      label: "Token ••••ough",
      pages: [{ id: "12345678", name: "Token only" }],
      addedAt: 1,
    }];
    const service = new AnalyticsBackgroundService(
      async () => { throw new Error("primary token unavailable"); },
      async () => { throw new Error("page bridge unavailable"); },
    );

    const result = await service.removeManagedToken("only");

    expect(result.tokens).toEqual([]);
    expect(result.pages).toEqual([]);
  });

  it("clears an already stale directory when Token management is reopened with no saved Tokens", async () => {
    const service = new AnalyticsBackgroundService(
      async () => { throw new Error("primary token unavailable"); },
      async () => { throw new Error("page bridge unavailable"); },
    );

    const result = await service.getManagedTokens();

    expect(result.tokens).toEqual([]);
    expect(result.pages).toEqual([]);
  });

  it("keeps pages still granted by another Token when primary directory refresh fails", async () => {
    const shared = { id: "12345678", name: "Shared" };
    vault.records = [
      { id: "remove", token: "first-managed-token-value", label: "first", pages: [shared, { id: "87654321", name: "Removed" }], addedAt: 1 },
      { id: "keep", token: "second-managed-token-value", label: "second", pages: [shared], addedAt: 2 },
    ];
    const service = new AnalyticsBackgroundService(
      async () => { throw new Error("primary token unavailable"); },
      async () => { throw new Error("page bridge unavailable"); },
    );

    const result = await service.removeManagedToken("remove");

    expect(result.tokens.map((token) => token.id)).toEqual(["keep"]);
    expect(result.pages.map((page) => page.id)).toEqual(["12345678"]);
  });

  it("does not let an older directory request restore a page after its Token is deleted", async () => {
    const removedPage = { id: "12345678", name: "Removed" };
    vault.records = [{ id: "remove", token: "managed-token-value", label: "remove", pages: [removedPage], addedAt: 1 }];
    storage.analyticsExtraPageIds = [removedPage.id];
    storage.analyticsExtraPages = [removedPage];
    let resolveFirstDiscovery!: (pages: AnalyticsPage[]) => void;
    let discoveryCount = 0;
    const service = new AnalyticsBackgroundService(
      async () => { throw new Error("primary token unavailable"); },
      async () => {
        discoveryCount += 1;
        if (discoveryCount === 1) return new Promise<AnalyticsPage[]>((resolve) => { resolveFirstDiscovery = resolve; });
        throw new Error("page bridge unavailable");
      },
    );

    const staleRequest = service.getDirectory(true);
    await Promise.resolve();
    await Promise.resolve();
    const removal = await service.removeManagedToken("remove");
    resolveFirstDiscovery([removedPage]);
    await staleRequest.catch(() => undefined);

    expect(removal.pages).toEqual([]);
    expect((await service.getDirectory()).pages).toEqual([]);
  });
});
