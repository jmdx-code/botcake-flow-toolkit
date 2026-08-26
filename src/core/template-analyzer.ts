import { TEMPLATE_FORMAT, TEMPLATE_VERSION } from "../shared/constants";
import type {
  BotFieldDependency,
  FlowSnapshot,
  FlowTemplateV1,
  MediaDependency,
  MediaKind,
  TemplateInput,
  TagDependency,
  UnsupportedDependency,
} from "../shared/types";
import { deepClone, randomId, walkJson } from "../shared/utils";

const PLACEHOLDER_RE = /\[\[([A-Za-z0-9_.-]+)\]\]/g;
const BOT_FIELD_RE = /\{\{(\d+)\/\|([^}]+)\}\}/g;

const UNSUPPORTED_KEYS: Record<string, string> = {
  custom_field_id: "自定义字段属于专页对象，当前版本不能可靠迁移",
  sequence_id: "序列属于专页对象，当前版本不能可靠迁移",
  product_id: "商品属于专页对象，当前版本不能可靠迁移",
  warehouse_id: "仓库属于专页对象，当前版本不能可靠迁移",
};

const TAG_ACTIONS = new Set(["add_tag", "remove_tag"]);
const PORTABLE_ACTIONS = new Set([
  "block_customer", "active_bot", "deactivate_bot", "sign_follow_bot", "cancel_sign_follow_bot",
  "mark_acc_seeding", "unmark_acc_seeding", "handover_to_page_inbox", "pass_control_back_to_bot",
  "report_spam", "mark_unread", "mark_read", "clear_chat_history_ai", "deactivate_gpt", "active_gpt",
  "active_biz_ai", "deactivate_biz_ai", "hide_comment", "delete_comment", "confirm_latest_order",
  "cancel_latest_order", "new_subscriber",
]);

export function analyzeSnapshot(snapshot: FlowSnapshot): FlowTemplateV1 {
  const post = deepClone(snapshot.post);
  const entryBlockKey = getEntryBlockKey(post);
  if (!entryBlockKey) throw new Error("当前流程没有可识别的入口节点");
  const inputKeys = new Set<string>();
  const botFields = new Map<string, BotFieldDependency>();
  const media = new Map<string, MediaDependency>();
  const unsupported: UnsupportedDependency[] = [];
  const tags = collectTagDependencies(post, snapshot.tags ?? [], unsupported);

  walkJson(post, (value, path, parent, key) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(PLACEHOLDER_RE)) inputKeys.add(match[1]);
      for (const match of value.matchAll(BOT_FIELD_RE)) {
        const sourceId = match[1];
        const name = match[2].trim();
        const sourceField = snapshot.botFields.find((field) => String(field.id) === sourceId);
        botFields.set(name.toLocaleLowerCase(), {
          name,
          sourceId,
          fieldType: sourceField?.type,
          defaultValue: sourceField?.value,
          description: typeof sourceField?.description === "string" ? sourceField.description : undefined,
        });
      }
    }

    if (parent && !Array.isArray(parent) && typeof key === "string") {
      const reason = UNSUPPORTED_KEYS[key];
      if (reason && value !== null && value !== undefined && value !== "") {
        unsupported.push({ path, key, value, reason });
      }
      if (key === "flow_id" && value !== null && value !== undefined && value !== "" && String(value) !== snapshot.identity.flowId) {
        unsupported.push({ path, key, value, reason: "引用了另一个 Flow，目标专页不一定存在" });
      }
      if (key === "add_actions" && Array.isArray(value) && value.length > 0) {
        unsupported.push({ path, key, value, reason: "动作可能绑定专页对象，需要人工检查" });
      }
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const cardPluginId = getCardPluginId(post, path);
      const pluginKind = record.plugin_id === "image" || record.plugin_id === "audio" || record.plugin_id === "video" ? record.plugin_id : undefined;
      const pluginConfig = record.config && typeof record.config === "object" && !Array.isArray(record.config)
        ? record.config as Record<string, unknown>
        : undefined;
      const url = pluginConfig
        ? firstString(pluginConfig.content_url, pluginConfig.url)
        : firstString(record.content_url, record.url);
      const kind = pluginKind ?? (isNestedCardMedia(path, cardPluginId) && hasMediaIdentity(record)
        ? inferMediaKind(record, url)
        : undefined);
      const configPath = pluginConfig ? `${path}.config` : path;
      if (url && kind && !media.has(configPath)) {
        const extension = extensionFor(kind, url);
        const mediaKey = `media_${media.size + 1}`;
        media.set(configPath, {
          key: mediaKey,
          kind,
          configPath,
          sourceUrl: url,
          asset: `assets/${mediaKey}.${extension}`,
          name: firstString(pluginConfig?.name, record.name) || `${mediaKey}.${extension}`,
          mime: mimeFor(kind, extension),
        });
      }
    }
  });

  const inputs: TemplateInput[] = [...inputKeys].map((key) => ({
    key,
    label: key,
    kind: "text",
    required: true,
  }));

  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    meta: {
      id: randomId("template"),
      name: snapshot.name || "未命名流程模板",
      createdAt: new Date().toISOString(),
      sourcePageId: snapshot.identity.pageId,
      sourceFlowId: snapshot.identity.flowId,
    },
    flow: {
      name: snapshot.name,
      post,
      entryBlockKey,
      selectedTab: snapshot.selectedTab,
      isPreview: snapshot.isPreview,
      isPreviewPublished: snapshot.isPreviewPublished,
    },
    inputs,
    dependencies: {
      botFields: [...botFields.values()],
      tags: [...tags.values()],
      media: [...media.values()],
      unsupported,
    },
  };
}

function collectTagDependencies(
  post: Record<string, unknown>,
  sourceTags: Array<{ id: string | number; name: string }>,
  unsupported: UnsupportedDependency[],
): Map<string, TagDependency> {
  const dependencies = new Map<string, TagDependency>();
  const namesById = new Map(sourceTags.map((tag) => [String(tag.id), tag.name.trim()]));
  walkJson(post, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const tag = value as Record<string, unknown>;
    if ((typeof tag.tag_id !== "string" && typeof tag.tag_id !== "number") || typeof tag.label !== "string" || !tag.label.trim()) return;
    namesById.set(String(tag.tag_id), tag.label.trim());
  });
  const blocks = Array.isArray(post.blocks) ? post.blocks : [];
  blocks.forEach((value, blockIndex) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const block = value as Record<string, unknown>;
    if (String(block.type ?? "").toLocaleLowerCase() === "action") {
      const actions = Array.isArray(block.action) ? block.action : [];
      actions.forEach((item, actionIndex) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const action = item as Record<string, unknown>;
        const actionName = String(action.action ?? "");
        const path = `$.blocks[${blockIndex}].action[${actionIndex}]`;
        if (TAG_ACTIONS.has(actionName)) {
          const ids = Array.isArray(action.action_id) ? action.action_id : [action.action_id];
          ids.filter((id) => typeof id === "string" || typeof id === "number").forEach((id) => {
            const sourceId = String(id);
            const name = namesById.get(sourceId);
            if (!name) {
              unsupported.push({ path: `${path}.action_id`, key: "action_id", value: id, reason: "标签动作未能根据源专页标签 ID 识别名称" });
              return;
            }
            dependencies.set(sourceId, { name, sourceId });
          });
        } else if (!PORTABLE_ACTIONS.has(actionName)) {
          unsupported.push({ path, key: "action", value: actionName || action, reason: `动作“${actionName || "未知动作"}”可能绑定专页对象，尚未适配` });
        }
      });
    }
    walkJson(block, (nested, nestedPath) => {
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) return;
      const rule = nested as Record<string, unknown>;
      if (rule.type !== "tags" || !Array.isArray(rule.tags)) return;
      rule.tags.forEach((tagValue, tagIndex) => {
        if (!tagValue || typeof tagValue !== "object" || Array.isArray(tagValue)) return;
        const tag = tagValue as Record<string, unknown>;
        const rawId = tag.tag_id;
        const sourceId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : undefined;
        const name = (typeof tag.label === "string" ? tag.label.trim() : "") || (sourceId ? namesById.get(sourceId) ?? "" : "");
        const path = `$.blocks[${blockIndex}]${nestedPath.slice(1)}.tags[${tagIndex}].tag_id`;
        if (!sourceId || !name) {
          unsupported.push({ path, key: "tag_id", value: rawId, reason: "标签条件未能识别标签名称" });
          return;
        }
        dependencies.set(sourceId, { name, sourceId });
      });
    });
  });
  return dependencies;
}

function getEntryBlockKey(post: Record<string, unknown>): string | undefined {
  const blocks = Array.isArray(post.blocks) ? post.blocks : [];
  const first = blocks[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  const key = (first as Record<string, unknown>).key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function getCardPluginId(post: Record<string, unknown>, path: string): string | undefined {
  const match = path.match(/^\$\.blocks\[(\d+)]\.cards\[(\d+)](?:\.|$)/);
  if (!match) return undefined;
  const blocks = Array.isArray(post.blocks) ? post.blocks : [];
  const block = blocks[Number(match[1])];
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const cards = (block as Record<string, unknown>).cards;
  const card = Array.isArray(cards) ? cards[Number(match[2])] : undefined;
  if (!card || typeof card !== "object" || Array.isArray(card)) return undefined;
  const pluginId = (card as Record<string, unknown>).plugin_id;
  return typeof pluginId === "string" ? pluginId.toLowerCase() : undefined;
}

function isNestedCardMedia(path: string, cardPluginId?: string): boolean {
  if (!cardPluginId || !/^\$\.blocks\[\d+]\.cards\[\d+]\.config(?:\.|\[)/.test(path)) return false;
  return /(?:multi_image|multiple(?:_image)?|gallery|carousel|generic|template)/i.test(cardPluginId);
}

function hasMediaIdentity(record: Record<string, unknown>): boolean {
  return firstString(record.content_url, record.name, record.content_id, record.upload_type, record.media_type) !== undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function inferMediaKind(record: Record<string, unknown>, url?: string): MediaKind | undefined {
  const cue = `${record.upload_type ?? ""} ${record.type ?? ""} ${record.card_type ?? ""}`.toLowerCase();
  if (cue.includes("video") || url?.match(/\.(mp4|mov|webm|mkv)(?:[?#]|$)/i)) return "video";
  if (cue.includes("audio") || url?.match(/\.(mp3|m4a|wav|ogg)(?:[?#]|$)/i)) return "audio";
  if (cue.includes("image") || url?.match(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i)) return "image";
  return undefined;
}

function extensionFor(kind: MediaKind, url: string): string {
  const match = url.match(/\.([A-Za-z0-9]{2,5})(?:[?#]|$)/);
  if (match) return match[1].toLowerCase().replace("jpeg", "jpg");
  return kind === "image" ? "jpg" : kind === "audio" ? "mp3" : "mp4";
}

function mimeFor(kind: MediaKind, extension: string): string {
  if (kind === "image") return `image/${extension === "jpg" ? "jpeg" : extension}`;
  if (kind === "audio") return extension === "m4a" ? "audio/mp4" : `audio/${extension === "mp3" ? "mpeg" : extension}`;
  return extension === "mov" ? "video/quicktime" : `video/${extension === "mkv" ? "x-matroska" : extension}`;
}

export function extractPlaceholderKeys(value: unknown): string[] {
  const keys = new Set<string>();
  walkJson(value, (item) => {
    if (typeof item !== "string") return;
    for (const match of item.matchAll(PLACEHOLDER_RE)) keys.add(match[1]);
  });
  return [...keys];
}
