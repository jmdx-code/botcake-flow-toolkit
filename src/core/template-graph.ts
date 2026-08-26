import type { FlowTemplateV1, MediaKind } from "../shared/types";
import { walkJson } from "../shared/utils";

export type TemplateGraphNode = {
  id: string;
  blockIndex: number;
  title: string;
  type: string;
  kind: TemplateNodeKind;
  x: number;
  y: number;
  entry: boolean;
  preview: string;
  media: TemplateMediaField[];
  buttons: string[];
};

export type TemplateNodeKind = "message" | "condition" | "delay" | "action" | "unknown";

export type TemplateGraphEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  paths: string[];
};

export type TemplateTextField = {
  path: string;
  label: string;
  value: string;
  multiline: boolean;
  rawTextPath?: string;
};

export type TemplateMediaField = {
  key: string;
  path: string;
  label: string;
  kind: MediaKind;
  name?: string;
  url?: string;
  asset?: string;
};

export type TemplateContentItem =
  | { kind: "text"; field: TemplateTextField }
  | { kind: "button"; label: string; title: TemplateTextField; link: TemplateTextField }
  | { kind: "link"; field: TemplateTextField };

export type TemplateGraph = {
  nodes: TemplateGraphNode[];
  edges: TemplateGraphEdge[];
  missingTargets: string[];
};

type JsonRecord = Record<string, unknown>;

const TEXT_KEYS = new Set(["text", "title", "label", "message", "subtitle", "description"]);
const SKIPPED_TEXT_PARENTS = new Set(["rawText", "coordinate", "gotos", "defaultGotos"]);
const MEDIA_ONLY_PLUGINS = new Set(["image", "audio", "video", "file"]);
const EMPTY_TEXT_PLUGINS = /(?:^|_)(?:text|gallery|carousel|template|generic|multiple(?:_image)?)(?:$|_)/i;
const BUTTON_TEXT_PLUGINS = new Set(["text", "image", "multi_image", "gallery", "video"]);
const BODY_TEXT_PLUGINS = new Set(["text", "gallery"]);

export function buildTemplateGraph(template: FlowTemplateV1): TemplateGraph {
  const blocks = getBlocks(template);
  const nodeIds = new Set<string>();
  const nodes = blocks.map((block, blockIndex) => {
    const id = stringValue(block.key) || `block-${blockIndex + 1}`;
    nodeIds.add(id);
    const coordinate = recordValue(block.coordinate);
    return {
      id,
      blockIndex,
      title: stringValue(block.title) || `节点 ${blockIndex + 1}`,
      type: inferBlockType(block),
      kind: inferNodeKind(block),
      x: numberValue(coordinate.coordinateX, blockIndex * 320),
      y: numberValue(coordinate.coordinateY, 0),
      entry: id === template.flow.entryBlockKey,
      preview: blockPreview(block),
      media: getBlockMediaFields(template, blockIndex),
      buttons: blockButtons(block),
    };
  });

  const grouped = new Map<string, TemplateGraphEdge>();
  blocks.forEach((block, blockIndex) => {
    const source = stringValue(block.key) || `block-${blockIndex + 1}`;
    walkJson(block, (value, path) => {
      const record = recordValue(value);
      const target = stringValue(record.block_key);
      if (!target || target === source) return;
      const label = connectionLabel(record, path);
      const groupKey = `${source}->${target}`;
      const existing = grouped.get(groupKey);
      if (existing) {
        if (label && !existing.label.split(" / ").includes(label)) {
          existing.label = existing.label ? `${existing.label} / ${label}` : label;
        }
        existing.paths.push(`$.blocks[${blockIndex}]${path.slice(1)}`);
      } else {
        grouped.set(groupKey, {
          id: `${source}-${target}`,
          source,
          target,
          label,
          paths: [`$.blocks[${blockIndex}]${path.slice(1)}`],
        });
      }
    });
  });

  const edges = [...grouped.values()].filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const missingTargets = [...new Set([...grouped.values()]
    .filter((edge) => !nodeIds.has(edge.target))
    .map((edge) => edge.target))];
  return { nodes, edges, missingTargets };
}

export function getBlockTextFields(template: FlowTemplateV1, blockIndex: number): TemplateTextField[] {
  const block = getBlocks(template)[blockIndex];
  if (!block) return [];
  if (inferNodeKind(block) !== "message") return [];
  const fields: TemplateTextField[] = [];
  const basePath = `$.blocks[${blockIndex}]`;
  walkJson(block, (value, path, parent, key) => {
    if (typeof value !== "string" || typeof key !== "string" || !TEXT_KEYS.has(key)) return;
    if (path === "$.title") return;
    if (isInsideSkippedParent(path)) return;
    const pluginId = cardPluginId(block, path);
    if (!isSupportedTextField(pluginId, path, key)) return;
    if (isTechnicalMediaText(pluginId, path, key)) return;
    if (!value.trim() && !keepsEmptyTextField(pluginId, path, key)) return;
    const fullPath = `${basePath}${path.slice(1)}`;
    fields.push({
      path: fullPath,
      label: fieldLabel(path, parent),
      value,
      multiline: key === "text" || key === "message" || value.length > 80 || value.includes("\n"),
      rawTextPath: path.match(/^\$\.cards\[(\d+)]\.config\.text$/)
        ? `${basePath}.cards[${path.match(/^\$\.cards\[(\d+)]/)?.[1]}].config.rawText`
        : undefined,
    });
  });
  return dedupeFields(fields);
}

function cardPluginId(block: JsonRecord, path: string): string {
  const cardIndex = Number(path.match(/^\$\.cards\[(\d+)]/)?.[1]);
  if (!Number.isInteger(cardIndex)) return "";
  const cards = Array.isArray(block.cards) ? block.cards : [];
  return stringValue(recordValue(cards[cardIndex]).plugin_id).toLocaleLowerCase();
}

function isTechnicalMediaText(pluginId: string, path: string, key: string): boolean {
  return MEDIA_ONLY_PLUGINS.has(pluginId) && key === "text" && /\.config\.text$/.test(path);
}

function isSupportedTextField(pluginId: string, path: string, key: string): boolean {
  if (/\.buttons\[\d+]\.title$/.test(path)) return BUTTON_TEXT_PLUGINS.has(pluginId);
  if (!BODY_TEXT_PLUGINS.has(pluginId)) return false;
  if (pluginId === "text") return key === "text" && /\.config\.text$/.test(path);
  return ["text", "title", "subtitle", "description", "label"].includes(key);
}

function keepsEmptyTextField(pluginId: string, path: string, key: string): boolean {
  if (/\.buttons\[\d+]\.title$/.test(path)) return true;
  if (!path.includes(".config.")) return false;
  if (pluginId === "text" && key === "text") return true;
  return EMPTY_TEXT_PLUGINS.test(pluginId);
}

export function getBlockMediaFields(template: FlowTemplateV1, blockIndex: number): TemplateMediaField[] {
  // The trailing path separator is intentional: without it, block 1 also
  // matches paths such as `$.blocks[10]...` and leaks that node's media into
  // the current node when a flow has ten or more blocks.
  const prefix = `$.blocks[${blockIndex}].`;
  return template.dependencies.media.flatMap((media) => {
    if (!media.configPath.startsWith(prefix)) return [];
    return [{
      key: media.key,
      path: media.configPath,
      label: media.kind === "image" ? "图片" : media.kind === "audio" ? "音频" : "视频",
      kind: media.kind,
      name: media.name,
      url: media.sourceUrl,
      asset: media.asset,
    }];
  });
}

export function getBlockLinkFields(template: FlowTemplateV1, blockIndex: number): TemplateTextField[] {
  const block = getBlocks(template)[blockIndex];
  if (!block) return [];
  if (inferNodeKind(block) !== "message") return [];
  const fields: TemplateTextField[] = [];
  const basePath = `$.blocks[${blockIndex}]`;
  walkJson(block, (value, path, parent, key) => {
    if (typeof value !== "string" || key !== "url") return;
    const pluginId = cardPluginId(block, path);
    if (!BUTTON_TEXT_PLUGINS.has(pluginId)) return;
    const record = recordValue(parent);
    if (record.type !== "link") return;
    const cardIndex = Number(path.match(/^\$\.cards\[(\d+)]/)?.[1] ?? 0) + 1;
    const buttonIndex = Number(path.match(/\.buttons\[(\d+)]/)?.[1] ?? 0) + 1;
    const buttonTitle = stringValue(record.title);
    fields.push({
      path: `${basePath}${path.slice(1)}`,
      label: `卡片 ${cardIndex} · 按钮 ${buttonIndex} · 链接${buttonTitle ? `（${shorten(buttonTitle, 18)}）` : ""}`,
      value,
      multiline: false,
    });
  });
  return fields;
}

export function getBlockContentItems(template: FlowTemplateV1, blockIndex: number): TemplateContentItem[] {
  const block = getBlocks(template)[blockIndex];
  if (!block) return [];
  const basePath = `$.blocks[${blockIndex}]`;
  const order = new Map<string, number>();
  let position = 0;
  walkJson(block, (_value, path) => order.set(`${basePath}${path.slice(1)}`, position++));

  const textFields = getBlockTextFields(template, blockIndex);
  const linkFields = getBlockLinkFields(template, blockIndex);
  const linksByParent = new Map(linkFields.map((field) => [field.path.replace(/\.url$/, ""), field]));
  const usedLinks = new Set<string>();
  const items: TemplateContentItem[] = textFields.map((field) => {
    const parentPath = field.path.replace(/\.title$/, "");
    const link = field.path.endsWith(".title") ? linksByParent.get(parentPath) : undefined;
    if (link) {
      usedLinks.add(link.path);
      return { kind: "button", label: field.label, title: field, link };
    }
    return { kind: "text", field };
  });
  for (const field of linkFields) {
    if (!usedLinks.has(field.path)) items.push({ kind: "link", field });
  }
  return items.sort((left, right) => {
    const leftPath = left.kind === "button" ? left.title.path : left.field.path;
    const rightPath = right.kind === "button" ? right.title.path : right.field.path;
    return (order.get(leftPath) ?? Number.MAX_SAFE_INTEGER) - (order.get(rightPath) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function getBlocks(template: FlowTemplateV1): JsonRecord[] {
  return Array.isArray(template.flow.post.blocks)
    ? template.flow.post.blocks.filter((block): block is JsonRecord => Boolean(block && typeof block === "object" && !Array.isArray(block)))
    : [];
}

function inferBlockType(block: JsonRecord): string {
  const type = stringValue(block.type);
  if (type === "condition") return "条件";
  if (type === "smart_delay") return "延迟";
  if (type === "action") return "动作";
  const cards = Array.isArray(block.cards) ? block.cards : [];
  const plugins = cards.map((card) => stringValue(recordValue(card).plugin_id));
  if (plugins.includes("multi_image")) return "多图消息";
  if (plugins.some((plugin) => /gallery|carousel|multiple.*image/i.test(plugin))) return "图集消息";
  if (plugins.some((plugin) => /template/i.test(plugin))) return "模板消息";
  if (plugins.includes("video")) return "视频消息";
  if (plugins.includes("image")) return "图片消息";
  if (plugins.includes("audio")) return "音频消息";
  if (plugins.includes("file")) return "文件消息";
  if (plugins.includes("text")) return "文字消息";
  return type || "流程节点";
}

export function inferNodeKind(block: JsonRecord): TemplateNodeKind {
  const type = stringValue(block.type).toLocaleLowerCase();
  if (type === "condition") return "condition";
  if (type === "smart_delay" || type === "delay") return "delay";
  if (type === "action") return "action";
  const cards = Array.isArray(block.cards) ? block.cards : [];
  if (cards.some((card) => Boolean(stringValue(recordValue(card).plugin_id)))) return "message";
  return "unknown";
}

function blockPreview(block: JsonRecord): string {
  if (stringValue(block.type).toLocaleLowerCase() === "action") {
    const labels: Record<string, string> = {
      add_tag: "添加标签", remove_tag: "移除标签", block_customer: "拉黑客户",
      active_bot: "开启机器人", deactivate_bot: "暂停机器人", sign_follow_bot: "订阅机器人",
      cancel_sign_follow_bot: "取消订阅机器人", handover_to_page_inbox: "转交专页收件箱",
      pass_control_back_to_bot: "交还 Botcake", report_spam: "标记垃圾信息",
    };
    const actions = Array.isArray(block.action) ? block.action : [];
    const summary = actions.flatMap((value) => {
      const action = stringValue(recordValue(value).action);
      return action ? [labels[action] ?? action] : [];
    }).join(" · ");
    return shorten(summary || "动作", 92);
  }
  let mediaName = "";
  let text = "";
  walkJson(block.cards, (value, path, parent, key) => {
    if (!text && typeof value === "string" && key === "text" && !path.includes("rawText") && value.trim()) text = value.trim();
    if (!mediaName && typeof value === "string" && key === "name" && /\.(?:png|jpe?g|webp|gif|mp3|wav|m4a|ogg)$/i.test(value)) mediaName = value;
  });
  return shorten(text || mediaName || inferBlockType(block), 92);
}

function blockButtons(block: JsonRecord): string[] {
  const buttons: string[] = [];
  walkJson(block.cards, (value, path) => {
    const record = recordValue(value);
    if (!/\.buttons\[\d+]$/.test(path)) return;
    const title = stringValue(record.title);
    if (title) buttons.push(shorten(title, 34));
  });
  return buttons;
}

function connectionLabel(record: JsonRecord, path: string): string {
  const title = stringValue(record.title) || stringValue(record.label) || stringValue(record.name);
  if (title) return shorten(title, 28);
  const cardMatch = path.match(/\.cards\[(\d+)]/);
  if (record.type === "blocks" && cardMatch) return `分支 ${Number(cardMatch[1]) + 1}`;
  return "下一步";
}

function fieldLabel(path: string, parent: unknown): string {
  const cardIndex = Number(path.match(/^\$\.cards\[(\d+)]/)?.[1] ?? 0) + 1;
  const buttonMatch = path.match(/\.buttons\[(\d+)]\.title$/);
  if (buttonMatch) return `卡片 ${cardIndex} · 按钮 ${Number(buttonMatch[1]) + 1}`;
  const key = path.split(".").at(-1);
  if (key === "text" || key === "message") return `卡片 ${cardIndex} · 正文`;
  if (key === "title") return `卡片 ${cardIndex} · 标题`;
  if (key === "subtitle") return `卡片 ${cardIndex} · 副标题`;
  if (key === "description") return `卡片 ${cardIndex} · 说明`;
  if (key === "label") return `卡片 ${cardIndex} · 标签`;
  return stringValue(recordValue(parent).plugin_id) || `卡片 ${cardIndex} · 文案`;
}

function isInsideSkippedParent(path: string): boolean {
  return [...SKIPPED_TEXT_PARENTS].some((part) => path.includes(`.${part}.`) || path.includes(`.${part}[`) || path.endsWith(`.${part}`));
}

function dedupeFields(fields: TemplateTextField[]): TemplateTextField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.path)) return false;
    seen.add(field.path);
    return true;
  });
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shorten(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
