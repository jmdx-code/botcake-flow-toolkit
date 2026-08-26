import { describe, expect, it } from "vitest";
import { buildTemplateGraph, getBlockContentItems, getBlockLinkFields, getBlockMediaFields, getBlockTextFields } from "./template-graph";
import type { FlowTemplateV1 } from "../shared/types";

const template: FlowTemplateV1 = {
  format: "botcake-flow-template",
  version: 1,
  meta: { id: "test", name: "图测试", createdAt: "2026-08-17T00:00:00.000Z" },
  flow: {
    name: "图测试",
    entryBlockKey: "start",
    post: {
      blocks: [
        {
          key: "start",
          title: "Content",
          coordinate: { coordinateX: -120, coordinateY: 40 },
          cards: [{
            plugin_id: "text",
            config: {
              text: "欢迎来到测试流程",
              rawText: [{ children: [{ text: "欢迎来到测试流程" }] }],
              buttons: [
                { title: "继续", block_key: "finish", type: "blocks" },
                { title: "打开网站", type: "link", url: "https://example.com/welcome" },
              ],
            },
          }],
        },
        {
          key: "finish",
          title: "Audio",
          coordinate: { coordinateX: 420, coordinateY: 40 },
          cards: [{ plugin_id: "audio", config: { name: "voice.mp3", url: "https://example.com/voice.mp3" } }],
        },
      ],
    },
  },
  inputs: [],
  dependencies: {
    botFields: [],
    media: [{
      key: "media_1",
      kind: "audio",
      configPath: "$.blocks[1].cards[0].config",
      sourceUrl: "https://example.com/voice.mp3",
      asset: "assets/media_1.mp3",
      name: "voice.mp3",
    }],
    unsupported: [],
  },
};

describe("template graph", () => {
  it("keeps Botcake coordinates and nested button edges", () => {
    const graph = buildTemplateGraph(template);
    expect(graph.nodes[0]).toMatchObject({ id: "start", x: -120, y: 40, entry: true, type: "文字消息", buttons: ["继续", "打开网站"] });
    expect(graph.nodes[1]).toMatchObject({ id: "finish", x: 420, y: 40, type: "音频消息", media: [expect.objectContaining({ kind: "audio", name: "voice.mp3" })] });
    expect(graph.edges).toEqual([expect.objectContaining({ source: "start", target: "finish", label: "继续" })]);
    expect(graph.missingTargets).toEqual([]);
  });

  it("returns canonical text fields without duplicating rawText", () => {
    expect(getBlockTextFields(template, 0)).toEqual([
      expect.objectContaining({ label: "卡片 1 · 正文", value: "欢迎来到测试流程", rawTextPath: "$.blocks[0].cards[0].config.rawText" }),
      expect.objectContaining({ label: "卡片 1 · 按钮 1", value: "继续" }),
      expect.objectContaining({ label: "卡片 1 · 按钮 2", value: "打开网站" }),
    ]);
  });

  it("keeps existing text and link fields editable after their values become empty", () => {
    const emptyValues = structuredClone(template);
    const config = (emptyValues.flow.post.blocks as Array<{ cards: Array<{ config: { text: string; buttons: Array<{ title: string; url?: string }> } }> }>)[0].cards[0].config;
    config.text = "";
    config.buttons[1].title = "";
    config.buttons[1].url = "";
    expect(getBlockTextFields(emptyValues, 0)).toContainEqual(expect.objectContaining({ path: "$.blocks[0].cards[0].config.text", value: "" }));
    expect(getBlockLinkFields(emptyValues, 0)).toContainEqual(expect.objectContaining({ path: "$.blocks[0].cards[0].config.buttons[1].url", value: "" }));
    expect(getBlockContentItems(emptyValues, 0)).toContainEqual(expect.objectContaining({
      kind: "button",
      title: expect.objectContaining({ value: "" }),
      link: expect.objectContaining({ value: "" }),
    }));
  });

  it("does not expose the technical empty text field of image and audio plugins", () => {
    const mediaTemplate = structuredClone(template);
    mediaTemplate.flow.post.blocks = [{
      key: "media-block",
      cards: [
        { plugin_id: "image", config: { text: "", name: "photo.png", url: "https://example.com/photo.png", buttons: [] } },
        { plugin_id: "audio", config: { text: "", name: "voice.mp3", url: "https://example.com/voice.mp3", buttons: [] } },
        { plugin_id: "text", config: { text: "", rawText: [{ children: [{ text: "" }] }], buttons: [] } },
      ],
    }];
    expect(getBlockTextFields(mediaTemplate, 0)).toEqual([
      expect.objectContaining({ label: "卡片 3 · 正文", value: "" }),
    ]);
  });

  it("finds website button URLs without treating media URLs as links", () => {
    expect(getBlockLinkFields(template, 0)).toEqual([
      expect.objectContaining({ label: "卡片 1 · 按钮 2 · 链接（打开网站）", value: "https://example.com/welcome" }),
    ]);
    expect(getBlockLinkFields(template, 1)).toEqual([]);
  });

  it("shows a link whose URL is a Botcake bot-field token", () => {
    const withBotField = structuredClone(template);
    const config = (withBotField.flow.post.blocks as Array<{ cards: Array<{ config: { buttons: unknown[] } }> }>)[0].cards[0].config;
    config.buttons.push({ title: "机器人链接", type: "link", url: "{{123/|fish_link}}" });
    expect(getBlockLinkFields(withBotField, 0)).toContainEqual(expect.objectContaining({ value: "{{123/|fish_link}}" }));
    expect(getBlockContentItems(withBotField, 0).at(-1)).toMatchObject({
      kind: "button",
      title: { value: "机器人链接" },
      link: { value: "{{123/|fish_link}}" },
    });
  });

  it("keeps content order and groups a website button with its URL", () => {
    const items = getBlockContentItems(template, 0);
    expect(items.map((item) => item.kind)).toEqual(["text", "text", "button"]);
    expect(items[2]).toMatchObject({
      kind: "button",
      label: "卡片 1 · 按钮 2",
      title: { value: "打开网站" },
      link: { value: "https://example.com/welcome" },
    });
  });

  it("groups media dependencies by node", () => {
    expect(getBlockMediaFields(template, 1)).toEqual([
      expect.objectContaining({ kind: "audio", name: "voice.mp3", asset: "assets/media_1.mp3" }),
    ]);
  });

  it("does not leak media from double-digit block indexes into earlier nodes", () => {
    const withDoubleDigitBlock = structuredClone(template);
    const blocks = withDoubleDigitBlock.flow.post.blocks as Array<Record<string, unknown>>;
    while (blocks.length < 11) blocks.push({ key: `empty-${blocks.length}`, cards: [] });
    withDoubleDigitBlock.dependencies.media.push({
      key: "media_10",
      kind: "image",
      configPath: "$.blocks[10].cards[0].config",
      sourceUrl: "https://example.com/photo.png",
      asset: "assets/media_10.png",
      name: "photo.png",
    });

    expect(getBlockMediaFields(withDoubleDigitBlock, 1)).toEqual([
      expect.objectContaining({ key: "media_1" }),
    ]);
    expect(getBlockMediaFields(withDoubleDigitBlock, 10)).toEqual([
      expect.objectContaining({ key: "media_10" }),
    ]);
  });

  it("classifies structural nodes before looking for editable text", () => {
    const structural = structuredClone(template);
    structural.flow.post.blocks = [
      { key: "condition", type: "condition", title: "Condition", cards: [{ condition: [{ title: "Current Time", type: "current_time" }], gotos: { block_key: "delay" } }] },
      { key: "delay", type: "smart_delay", title: "Delay", cards: [], config: { delayValue: 1, delayUnits: "minutes" } },
      { key: "action", type: "action", title: "Action", action: [{ action: "block_customer" }], cards: [] },
      { key: "unknown", type: "custom_action", title: "Custom", cards: [] },
    ];
    expect(buildTemplateGraph(structural).nodes.map((node) => node.kind)).toEqual(["condition", "delay", "action", "unknown"]);
    expect(getBlockTextFields(structural, 0)).toEqual([]);
    expect(getBlockContentItems(structural, 0)).toEqual([]);
  });

  it("uses the verified Botcake card whitelist instead of guessing unknown fields", () => {
    const cards = structuredClone(template);
    cards.flow.post.blocks = [{
      key: "cards",
      cards: [
        { plugin_id: "multi_image", config: [{ name: "one.png", url: "https://example.com/one.png" }] },
        { plugin_id: "gallery", config: [{ title: "商品标题", subtitle: "商品说明", buttons: [{ title: "查看", type: "link", url: "https://example.com/item" }] }] },
        { plugin_id: "structured_information_template", config: { title: "不应猜测编辑" } },
      ],
    }];
    expect(buildTemplateGraph(cards).nodes[0]).toMatchObject({ kind: "message", type: "多图消息" });
    expect(getBlockTextFields(cards, 0).map((field) => field.value)).toEqual(["商品标题", "商品说明", "查看"]);
    expect(getBlockLinkFields(cards, 0).map((field) => field.value)).toEqual(["https://example.com/item"]);
  });
});
