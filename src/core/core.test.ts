import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createTemplateArchive, loadTemplateArchive } from "./archive";
import { analyzeSnapshot } from "./template-analyzer";
import { normalizePublicDriveUrl, parseCatalogCsv, sheetUrlToCsv } from "./catalog";
import { compileTemplate } from "./compiler";
import { inferMediaMime } from "./media";
import { flowTemplateSchema } from "./template-schema";
import type { FlowSnapshot, LoadedTemplate } from "../shared/types";
import { MAX_UNZIPPED_BYTES } from "../shared/constants";

const snapshot: FlowSnapshot = {
  identity: { pageId: "100", flowId: "200" },
  name: "示例流程",
  capturedAt: "2026-08-16T00:00:00.000Z",
  selectedTab: "flows",
  botFields: [{ id: 123, name: "fish_link", type: "string", value: "https://source.example" }],
  post: {
    id: 200,
    name: "示例流程",
    blocks: [{
      key: "block-a",
      cards: [
        { plugin_id: "text", config: { text: "欢迎 [[title]]，{{123/|fish_link}}", buttons: [{ flow_id: null }] } },
        { plugin_id: "audio", config: { url: "https://cdn.example/audio/abc", name: "voice.mp3", content_id: 8, page_id: "100" } },
      ],
      gotos: {},
    }],
  },
};

describe("template archive", () => {
  it("round-trips template and packaged assets", () => {
    const template = analyzeSnapshot(snapshot);
    const bytes = createTemplateArchive(template, new Map([["assets/media_1.mp3", new Uint8Array([1, 2, 3])]]));
    const loaded = loadTemplateArchive(bytes, "sample.zip");
    expect(loaded.template.meta.name).toBe("示例流程");
    expect(loaded.assets.get("assets/media_1.mp3")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects a declared oversized ZIP entry before inflating it", () => {
    const bytes = zipSync({ "template.json": strToU8("{}") });
    const centralHeader = findSignature(bytes, [0x50, 0x4b, 0x01, 0x02]);
    expect(centralHeader).toBeGreaterThanOrEqual(0);
    const forged = bytes.slice();
    new DataView(forged.buffer, forged.byteOffset, forged.byteLength)
      .setUint32(centralHeader + 24, MAX_UNZIPPED_BYTES + 1, true);

    expect(() => loadTemplateArchive(forged, "oversized.zip")).toThrow("解压后体积过大");
  });

  it("extracts placeholders, bot fields, and plugin media", () => {
    const template = analyzeSnapshot(snapshot);
    expect(template.flow.entryBlockKey).toBe("block-a");
    expect(template.inputs.map((input) => input.key)).toEqual(["title"]);
    expect(template.dependencies.botFields[0]).toMatchObject({ name: "fish_link", sourceId: "123", defaultValue: "https://source.example" });
    expect(template.dependencies.media[0]).toMatchObject({ kind: "audio", configPath: "$.blocks[0].cards[1].config" });
    expect(template.dependencies.unsupported).toEqual([]);
  });

  it("does not export a card preview or an image URL used by a normal button as media", () => {
    const thumbnailUrl = "https://content.pancake.vn/2-2602/2026/2/2/0ae990a90aa7d02668efa972158f500f8165a3d3_thumb.jpg";
    const withThumbnail = analyzeSnapshot({
      ...snapshot,
      post: {
        id: 201,
        name: "缩略图不应导出",
        blocks: [{
          key: "block-a",
          cards: [{
            plugin_id: "text",
            config: {
              text: "普通文本",
              preview_url: thumbnailUrl,
              buttons: [{ title: "打开图片", type: "link", url: thumbnailUrl }],
            },
          }, {
            plugin_id: "image",
            config: { name: "real.png", content_url: "https://cdn.example/real.png", preview_url: thumbnailUrl },
          }],
          gotos: {},
        }],
      },
    });

    expect(withThumbnail.dependencies.media).toEqual([
      expect.objectContaining({ kind: "image", sourceUrl: "https://cdn.example/real.png", name: "real.png" }),
    ]);
  });

  it("rejects templates that do not declare an entry block", () => {
    const template = analyzeSnapshot(snapshot);
    const withoutEntry = JSON.parse(JSON.stringify(template));
    delete withoutEntry.flow.entryBlockKey;
    expect(() => flowTemplateSchema.parse(withoutEntry)).toThrow();
  });

  it("rejects removed legacy input kinds", () => {
    const template = analyzeSnapshot(snapshot);
    const legacy = JSON.parse(JSON.stringify(template));
    legacy.inputs[0].kind = "textarea";
    expect(() => flowTemplateSchema.parse(legacy)).toThrow();
  });

  it("rejects incomplete options, invalid numbers, and duplicate variable keys", () => {
    const incomplete = analyzeSnapshot(snapshot);
    incomplete.inputs[0].options = [{ label: "只有标题" }];
    expect(() => flowTemplateSchema.parse(incomplete)).toThrow("实际内容");

    const invalidNumber = analyzeSnapshot(snapshot);
    Object.assign(invalidNumber.inputs[0], { kind: "number", default: "abc" });
    expect(() => flowTemplateSchema.parse(invalidNumber)).toThrow("有效数字");

    const duplicate = analyzeSnapshot(snapshot);
    duplicate.inputs.push({ ...duplicate.inputs[0] });
    expect(() => flowTemplateSchema.parse(duplicate)).toThrow("变量标识重复");
  });

  it("rejects a missing asset referenced only by a preset option", () => {
    const template = analyzeSnapshot(snapshot);
    const media = template.dependencies.media[0];
    template.inputs.push({ key: media.key, label: "语音", kind: "audio", bindings: [media.configPath], options: [{ label: "缺失语音", asset: "assets/missing.mp3" }] });
    expect(() => createTemplateArchive(template, new Map())).toThrow("缺少素材");
  });

  it("upgrades an old tag warning when the condition still contains its label", () => {
    const template = analyzeSnapshot({
      ...snapshot,
      tags: [{ id: 1065210892, name: "B" }],
      post: {
        id: 200,
        name: "旧标签模板",
        blocks: [{
          key: "condition",
          type: "condition",
          cards: [{ condition: [{ type: "tags", tags: [{ label: "B", tag_id: 1065210892 }] }] }],
        }],
      },
    });
    delete template.dependencies.tags;
    template.dependencies.unsupported = [{
      path: "$.blocks[0].cards[0].condition[0].tags[0].tag_id",
      key: "tag_id",
      value: 1065210892,
      reason: "标签属于专页对象，当前版本不能可靠迁移",
    }];
    const bytes = zipSync({ "template.json": strToU8(JSON.stringify(template)) });

    const loaded = loadTemplateArchive(bytes, "legacy-tags.zip");

    expect(loaded.template.dependencies.tags).toEqual([{ name: "B", sourceId: "1065210892" }]);
    expect(loaded.template.dependencies.unsupported).toEqual([]);
  });
});

function findSignature(bytes: Uint8Array, signature: number[]): number {
  for (let index = 0; index <= bytes.length - signature.length; index += 1) {
    if (signature.every((value, offset) => bytes[index + offset] === value)) return index;
  }
  return -1;
}

describe("public catalog", () => {
  it("converts a gid sheet URL and reads Chinese headers", () => {
    expect(sheetUrlToCsv("https://docs.google.com/spreadsheets/d/abc/edit?gid=42"))
      .toBe("https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=42");
    expect(parseCatalogCsv("名称,版本,资源网盘链接,启用\n流程A,2,https://drive.google.com/file/d/xyz/view,是"))
      .toEqual([{ name: "流程A", kind: "flow", version: "2", url: "https://drive.google.com/file/d/xyz/view", description: undefined, enabled: true }]);
    expect(parseCatalogCsv("名称,资源网盘链接\n设置-默认,https://example.com/settings.json\n说明,https://example.com/ignored"))
      .toEqual([{ name: "设置-默认", kind: "settings", version: undefined, url: "https://example.com/settings.json", description: undefined, enabled: true }]);
  });

  it("accepts the simple 选项/流程 two-column console", () => {
    expect(parseCatalogCsv("选项,流程\n设置-默认,https://example.com/settings.json\n流程-一号,https://example.com/flow.zip\n默认回复-通用,https://example.com/default.zip"))
      .toEqual([
        { name: "设置-默认", kind: "settings", version: undefined, url: "https://example.com/settings.json", description: undefined, enabled: true },
        { name: "流程-一号", kind: "flow", version: undefined, url: "https://example.com/flow.zip", description: undefined, enabled: true },
        { name: "默认回复-通用", kind: "defaultReply", version: undefined, url: "https://example.com/default.zip", description: undefined, enabled: true },
      ]);
  });

  it("normalizes public Google Drive files and Google Docs text", () => {
    expect(normalizePublicDriveUrl("https://drive.google.com/file/d/file123/view?usp=sharing"))
      .toBe("https://drive.usercontent.google.com/download?id=file123&export=download&confirm=t");
    expect(normalizePublicDriveUrl("https://docs.google.com/document/d/doc123/edit?usp=sharing"))
      .toBe("https://docs.google.com/document/d/doc123/export?format=txt");
    expect(normalizePublicDriveUrl("https://cdn.example.com/photo.jpg"))
      .toBe("https://cdn.example.com/photo.jpg");
  });
});

describe("media type detection", () => {
  it("recognizes a Google Drive image returned as generic binary", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(inferMediaMime("image", png, "application/octet-stream", "download")).toBe("image/png");
  });

  it("rejects a Google permission page instead of treating it as an image", () => {
    const html = new TextEncoder().encode("<html>Sign in to Google Drive</html>");
    expect(() => inferMediaMime("image", html, "text/html", "download")).toThrow("不是有效图片");
  });
});

describe("compiler", () => {
  it("extracts tag dependencies and maps or creates target-page tags for actions and conditions", async () => {
    const taggedSnapshot: FlowSnapshot = {
      ...snapshot,
      botFields: [],
      tags: [{ id: 1065210892, name: "B" }],
      post: {
        id: 200,
        name: "标签动作",
        blocks: [
          { key: "action", title: "Action", type: "action", action: [
            { action: "add_tag", action_id: [1065210892] },
            { action: "remove_tag", action_id: [1065210892] },
            { action: "block_customer" },
          ], cards: [] },
          { key: "condition", title: "Condition", type: "condition", cards: [{
            type: "and",
            condition: [{ type: "tags", title: "Tag", tags: [{ label: "B", tag_id: 1065210892 }], filter_type: "not_equal" }],
          }] },
        ],
      },
    };
    const template = analyzeSnapshot(taggedSnapshot);
    expect(template.dependencies.tags).toEqual([{ name: "B", sourceId: "1065210892" }]);
    expect(template.dependencies.unsupported).toEqual([]);
    const createTag = vi.fn(async () => ({ id: 9001, name: "B" }));
    const result = await compileTemplate({ template, assets: new Map(), sourceName: "tags.zip" }, {}, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create bot field"); },
      getTags: async () => [],
      createTag,
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch"); },
    });
    expect(createTag).toHaveBeenCalledWith("B");
    expect(result.report.createdTags).toEqual(["B"]);
    const json = JSON.stringify(result.payload.post);
    expect(json).toContain('"action_id":[9001]');
    expect(json).toContain('"tag_id":9001');
    expect(json).toContain('"action":"block_customer"');
  });

  it("rejects non-numeric values even when they come from import data", async () => {
    const template = analyzeSnapshot({
      ...snapshot,
      botFields: [],
      post: { id: 200, name: "数字", blocks: [{ key: "block-a", cards: [{ plugin_id: "text", config: { text: "[[count]]" } }] }] },
    });
    template.inputs[0].kind = "number";
    await expect(compileTemplate({ template, assets: new Map(), sourceName: "number.zip" }, { count: { text: "abc" } }, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch"); },
    })).rejects.toThrow("有效数字");
  });

  it("enforces required media and reports a missing selected asset", async () => {
    const template = analyzeSnapshot({
      ...snapshot,
      botFields: [],
      post: { id: 200, name: "必填图片", blocks: [{ key: "block-a", cards: [{ plugin_id: "image", config: { url: "https://source.example/a.png", name: "a.png" } }] }] },
    });
    const media = template.dependencies.media[0];
    media.key = "main_image";
    template.inputs.push({ key: "main_image", label: "主图", kind: "image", required: true, bindings: [media.configPath] });
    const services = {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch"); },
    };
    await expect(compileTemplate({ template, assets: new Map(), sourceName: "required-image.zip" }, {}, services)).rejects.toThrow("请选择");
    await expect(compileTemplate({ template, assets: new Map(), sourceName: "required-image.zip" }, { main_image: { asset: "assets/missing.png" } }, services)).rejects.toThrow("不存在");
  });

  it("rejects robot tokens missing from the dependency list", async () => {
    const template = analyzeSnapshot(snapshot);
    template.dependencies.botFields = [];
    await expect(compileTemplate({ template, assets: new Map(), sourceName: "bot-field.zip" }, { title: { text: "朋友" } }, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch"); },
    })).rejects.toThrow("未登记的机器人变量");
  });

  it("chooses one random option per variable and reuses it at every binding", async () => {
    const randomSnapshot: FlowSnapshot = {
      ...snapshot,
      botFields: [],
      post: {
        id: 200,
        name: "随机文案",
        blocks: [{ key: "block-a", cards: [{ plugin_id: "text", config: { text: "[[title]] / [[title]]" } }] }],
      },
    };
    const template = analyzeSnapshot(randomSnapshot);
    Object.assign(template.inputs[0], {
      kind: "random",
      options: [{ label: "A", value: "文案 A" }, { label: "B", url: "https://docs.google.com/document/d/example/edit" }],
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    const fetchText = vi.fn(async () => "远程文案 B");
    const result = await compileTemplate({ template, assets: new Map(), sourceName: "random.zip" }, {}, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch bytes"); },
      fetchText,
    });
    expect(JSON.stringify(result.payload.post)).toContain("远程文案 B / 远程文案 B");
    expect(fetchText).toHaveBeenCalledOnce();
    random.mockRestore();
  });

  it("treats placeholders embedded in links or text as required inputs", async () => {
    const requiredSnapshot: FlowSnapshot = {
      ...snapshot,
      botFields: [],
      post: {
        id: 200,
        name: "拼接变量",
        blocks: [{ key: "block-a", cards: [{ plugin_id: "text", config: { text: "固定内容", buttons: [{ title: "打开", type: "link", url: "https://example.com/profile?id=[[id]]" }] } }] }],
      },
    };
    const template = analyzeSnapshot(requiredSnapshot);
    await expect(compileTemplate({ template, assets: new Map(), sourceName: "required.zip" }, {}, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch"); },
    })).rejects.toThrow("请填写");
  });

  it("restores the explicitly recorded entry block before saving", async () => {
    const entrySnapshot: FlowSnapshot = {
      ...snapshot,
      botFields: [],
      post: {
        id: 200,
        name: "入口测试",
        blocks: [
          { key: "entry-block", cards: [], gotos: {} },
          { key: "other-block", cards: [], gotos: {} },
        ],
      },
    };
    const template = analyzeSnapshot(entrySnapshot);
    template.flow.post.blocks = [
      { key: "other-block", cards: [], gotos: {} },
      { key: "entry-block", cards: [], gotos: {} },
    ];
    const result = await compileTemplate({ template, assets: new Map(), sourceName: "entry.zip" }, {}, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => { throw new Error("should not upload"); },
      fetchBytes: async () => { throw new Error("should not fetch"); },
    });
    expect((result.payload.post.blocks as Array<{ key: string }>).map((block) => block.key))
      .toEqual(["entry-block", "other-block"]);
  });

  it("uploads one explicitly selected file once for all media positions sharing a variable", async () => {
    const mediaSnapshot: FlowSnapshot = {
      ...snapshot,
      botFields: [],
      post: {
        id: 200,
        name: "共享图片",
        blocks: [{ key: "block-a", cards: [
          { plugin_id: "image", config: { url: "https://source.example/a.png", name: "a.png" } },
          { plugin_id: "image", config: { url: "https://source.example/b.png", name: "b.png" } },
        ] }],
      },
    };
    const template = analyzeSnapshot(mediaSnapshot);
    template.dependencies.media.forEach((media) => { media.key = "shared_image"; });
    template.inputs.push({ key: "shared_image", label: "共享图片", kind: "image", bindings: template.dependencies.media.map((media) => media.configPath) });
    const uploadMedia = vi.fn(async () => ({ content_url: "https://target.example/shared.png", name: "shared.png" }));
    const result = await compileTemplate({ template, assets: new Map(), sourceName: "shared.zip" }, {
      shared_image: { bytes: new Uint8Array([1, 2, 3]), fileName: "shared.png", mime: "image/png" },
    }, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia,
      fetchBytes: async () => { throw new Error("should not fetch"); },
    });
    expect(uploadMedia).toHaveBeenCalledOnce();
    const cards = (result.payload.post.blocks as Array<{ cards: Array<{ config: { url: string; content_url: string } }> }>)[0].cards;
    expect(cards.map((card) => card.config.url)).toEqual(["https://target.example/shared.png", "https://target.example/shared.png"]);
    expect(cards.map((card) => card.config.content_url)).toEqual(["https://target.example/shared.png", "https://target.example/shared.png"]);
  });

  it("recognizes, uploads, and patches a video variable", async () => {
    const videoSnapshot: FlowSnapshot = {
      ...snapshot,
      botFields: [],
      post: {
        id: 200,
        name: "视频模板",
        blocks: [{ key: "block-a", cards: [{ plugin_id: "video", config: { url: "https://source.example/demo.mp4", name: "demo.mp4" } }] }],
      },
    };
    const template = analyzeSnapshot(videoSnapshot);
    expect(template.dependencies.media[0]).toMatchObject({ kind: "video", asset: "assets/media_1.mp4" });
    template.inputs.push({ key: "video_1", label: "主视频", kind: "video", bindings: [template.dependencies.media[0].configPath] });
    template.dependencies.media[0].key = "video_1";
    const uploadMedia = vi.fn(async () => ({ content_url: "https://target.example/demo.mp4", name: "demo.mp4" }));
    const result = await compileTemplate({ template, assets: new Map(), sourceName: "video.zip" }, {
      video_1: { bytes: new Uint8Array([0, 0, 0, 1]), fileName: "demo.mp4", mime: "video/mp4" },
    }, {
      getBotFields: async () => [],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia,
      fetchBytes: async () => { throw new Error("should not fetch"); },
    });
    expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ kind: "video", mime: "video/mp4", name: "demo.mp4" }));
    expect(JSON.stringify(result.payload.post)).toContain("https://target.example/demo.mp4");
  });

  it("maps fields, uploads media, and preserves graph data", async () => {
    const template = analyzeSnapshot(snapshot);
    const loaded: LoadedTemplate = {
      template,
      assets: new Map([[template.dependencies.media[0].asset!, new Uint8Array([0x49, 0x44, 0x33, 1])]]),
      sourceName: "sample.zip",
    };
    const createBotField = vi.fn(async () => ({ id: 999, name: "fish_link", type: "string" }));
    const uploadMedia = vi.fn(async () => ({
      success: true,
      content_url: "https://target.example/voice",
      content_preview_url: "https://target.example/preview",
      content_id: 777,
      fb_id: "fb-target",
      name: "voice.mp3",
      page_id: "300",
    }));
    const result = await compileTemplate(loaded, { title: { text: "朋友" } }, {
      getBotFields: async () => [],
      createBotField,
      uploadMedia,
      fetchBytes: async () => { throw new Error("should not fetch"); },
    });
    const json = JSON.stringify(result.payload.post);
    expect(json).toContain("欢迎 朋友");
    expect(json).toContain("{{999/|fish_link}}");
    expect(json).toContain("https://target.example/voice");
    expect(json).toContain("\"content_id\":777");
    expect(json).toContain("\"key\":\"block-a\"");
    expect(createBotField).toHaveBeenCalledWith("fish_link", "string", "https://source.example", undefined);
    expect(uploadMedia).toHaveBeenCalledOnce();
  });

  it("keeps the target Flow identity while replacing its graph", async () => {
    const template = analyzeSnapshot(snapshot);
    const loaded: LoadedTemplate = {
      template,
      assets: new Map([[template.dependencies.media[0].asset!, new Uint8Array([0x49, 0x44, 0x33, 1])]]),
      sourceName: "sample.zip",
    };
    const target: FlowSnapshot = {
      ...snapshot,
      identity: { pageId: "300", flowId: "400" },
      name: "评论-copy",
      selectedTab: "flows",
      post: {
        ...snapshot.post,
        id: 400,
        name: "评论-copy",
        published_at: "2026-08-17T00:00:00.000Z",
        blocks: [{ key: "old-target-block" }],
      },
    };
    const result = await compileTemplate(loaded, { title: { text: "朋友" } }, {
      getBotFields: async () => [{ id: 999, name: "fish_link", type: "string" }],
      createBotField: async () => { throw new Error("should not create"); },
      uploadMedia: async () => ({ content_url: "https://target.example/voice" }),
      fetchBytes: async () => { throw new Error("should not fetch"); },
    }, target);
    expect(result.payload.name).toBe("评论-copy");
    expect(result.payload.post).toMatchObject({
      id: 400,
      name: "评论-copy",
      published_at: "2026-08-17T00:00:00.000Z",
    });
    expect(JSON.stringify(result.payload.post)).toContain("block-a");
    expect(JSON.stringify(result.payload.post)).not.toContain("old-target-block");
  });
});
