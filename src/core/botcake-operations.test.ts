import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scopes/background/analytics-token-vault", () => ({
  readAnalyticsExternalTokenCandidates: vi.fn(async () => ({ "1189673984225873": ["managed-token"] })),
}));

import { BotcakeOperationsService } from "../scopes/background/botcake-operations";

const pageId = "1189673984225873";

describe("Token-only Botcake operations", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads page settings and configured flows without a Botcake page bridge", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/settings/comment")) return json({ success: true, private_replies: [{ id: 447301350, name: "评论", blocks: [], drafts: { blocks: [] } }] });
      if (url.includes("get_contents?type=default")) return json({ success: true });
      if (url.includes("get_contents?type=welcome")) return json({ success: true, flow: { id: 447301350, name: "评论", blocks: [] } });
      if (url.includes("/bot_field")) return json({ success: true, result: [{ id: 1, name: "姓名", type: "string" }] });
      if (url.includes("/settings")) return json({ success: true, settings: { time_zone: "8.0", webform_setting: { country: ["HK"] }, inbox_from_comment: true, auto_reply_comment: true, data_comments: [] } });
      throw new Error(`unexpected URL ${url}`);
    }));
    const service = new BotcakeOperationsService(async () => { throw new Error("no primary token"); });

    const state = await service.getPageState(pageId);

    expect(state.pageId).toBe(pageId);
    expect(state.defaultPrivateReply?.id).toBe("447301350");
    expect(state.welcome?.flow?.id).toBe("447301350");
    expect(state.botFields).toHaveLength(1);
  });

  it("discovers the comment Flow and keeps its full post as the replacement envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/settings/comment")) return json({ success: true, private_replies: [{ id: 447301350, name: "评论", blocks: [{ key: "entry" }], drafts: { blocks: [] } }] });
      if (url.includes("/settings")) return json({ success: true, settings: { inbox_from_comment: true } });
      throw new Error(`unexpected URL ${url}`);
    }));
    const service = new BotcakeOperationsService(async () => { throw new Error("no primary token"); });

    const prepared = await service.prepareFlow(pageId, "comment", "评论");

    expect(prepared.createdFlow).toBe(false);
    expect(prepared.snapshot.identity).toMatchObject({ pageId, flowId: "447301350" });
    expect(prepared.snapshot.post.blocks).toEqual([{ key: "entry" }]);
  });

  it("saves a Flow with Token authentication and explicitly omits cookies", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect(init?.body).toBeInstanceOf(FormData);
      return json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new BotcakeOperationsService(async () => { throw new Error("no primary token"); });

    const result = await service.saveFlow(pageId, { name: "评论", post: { id: 447301350, blocks: [] } });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("access_token=managed-token");
  });

  it("falls back to another Token when the first Token has no page permission", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("access_token=managed-token")) return json({ errors: { detail: "Forbidden" } }, 403);
      if (url.includes("access_token=fallback-token")) return json({ success: true, result: [] });
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new BotcakeOperationsService(async () => "fallback-token");

    await expect(service.getBotFields(pageId)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed write that could create duplicate side effects", async () => {
    const fetchMock = vi.fn(async () => json({ errors: { detail: "Internal Server Error" } }, 500));
    vi.stubGlobal("fetch", fetchMock);
    const service = new BotcakeOperationsService(async () => { throw new Error("no primary token"); });

    await expect(service.saveFlow(pageId, { name: "评论", post: { id: 447301350, blocks: [] } }))
      .rejects.toThrow("Botcake 接口 500");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
