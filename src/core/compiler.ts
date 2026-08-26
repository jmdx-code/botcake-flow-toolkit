import type {
  BotField,
  BotcakeTag,
  CompileReport,
  FlowTemplateV1,
  FlowSnapshot,
  ImportInputValue,
  LoadedTemplate,
  MediaDependency,
  MediaKind,
  SaveFlowPayload,
} from "../shared/types";
import { bytesToBase64, deepClone, getByPath, setByPath, walkJson } from "../shared/utils";
import { normalizePublicDriveUrl } from "./catalog";
import { MAX_REMOTE_FILE_BYTES } from "../shared/constants";
import { assertTemplateContract } from "./template-contract";
import { inferMediaMime } from "./media";

type CompileServices = {
  getBotFields: () => Promise<BotField[]>;
  createBotField: (name: string, type?: string, value?: unknown, description?: string) => Promise<BotField>;
  getTags?: () => Promise<BotcakeTag[]>;
  createTag?: (name: string) => Promise<BotcakeTag>;
  uploadMedia: (data: { kind: MediaKind; name: string; mime: string; bytes: Uint8Array }) => Promise<Record<string, unknown>>;
  fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; contentType?: string; fileName?: string }>;
  fetchText?: (url: string) => Promise<string>;
};

export async function compileTemplate(
  loaded: LoadedTemplate,
  inputValues: Record<string, ImportInputValue>,
  services: CompileServices,
  target?: FlowSnapshot,
): Promise<{ payload: SaveFlowPayload; report: CompileReport }> {
  const { template, assets } = loaded;
  assertTemplateContract(template);
  if (template.dependencies.unsupported.length) {
    const summary = template.dependencies.unsupported.slice(0, 3).map((item) => `${item.path}：${item.reason}`).join("；");
    throw new Error(`模板包含尚未支持的专页绑定对象：${summary}`);
  }

  const post = deepClone(template.flow.post);
  restoreEntryBlock(post, template.flow.entryBlockKey);
  if (target) preserveTargetFlowEnvelope(post, target);
  const report: CompileReport = { warnings: [], createdBotFields: [], mappedBotFields: [], createdTags: [], mappedTags: [], uploadedMedia: [] };
  await applyTextInputs(post, template, inputValues, services);
  await mapBotFields(post, template, services, report);
  await mapTags(post, template, services, report);

  for (const input of template.inputs.filter((item) => isMediaKind(item.kind) && item.required)) {
    if (!hasMediaValue(inputValues[input.key])) throw new Error(`请选择“${input.label}”`);
  }

  const mediaDependencies = [...template.dependencies.media];
  for (const input of template.inputs.filter((item) => isMediaKind(item.kind))) {
    for (const path of input.bindings ?? []) {
      if (!mediaDependencies.some((item) => item.configPath === path)) {
        mediaDependencies.push({ key: input.key, kind: input.kind as MediaKind, configPath: path });
      }
    }
  }
  const sharedUploads = new Map<string, Record<string, unknown>>();
  for (const media of mediaDependencies) {
    const explicitInput = inputValues[media.key];
    const canShareUpload = Boolean(explicitInput?.bytes || explicitInput?.asset || explicitInput?.url);
    let result = canShareUpload ? sharedUploads.get(media.key) : undefined;
    const source = result ? undefined : await resolveMedia(media, explicitInput, assets, services);
    if (!result && !source) {
      report.warnings.push(`素材 ${media.key} 未替换，保留模板原值`);
      continue;
    }
    if (!result && source) {
      validateMedia(source.bytes, media.kind, source.mime);
      result = await services.uploadMedia({
        kind: media.kind,
        name: source.name,
        mime: source.mime,
        bytes: source.bytes,
      });
      if (canShareUpload) sharedUploads.set(media.key, result);
      if (!report.uploadedMedia.includes(media.key)) report.uploadedMedia.push(media.key);
    }
    if (!result) throw new Error(`素材 ${media.key} 上传结果为空`);
    patchMediaConfig(post, media.configPath, result);
  }

  return {
    payload: {
      name: target?.name ?? template.flow.name,
      post,
      selectedTab: target?.selectedTab ?? template.flow.selectedTab,
      isPreview: target?.isPreview ?? template.flow.isPreview,
      isPreviewPublished: target?.isPreviewPublished ?? template.flow.isPreviewPublished,
    },
    report,
  };
}

async function mapTags(
  post: Record<string, unknown>,
  template: FlowTemplateV1,
  services: CompileServices,
  report: CompileReport,
): Promise<void> {
  const dependencies = template.dependencies.tags ?? [];
  if (!dependencies.length) return;
  if (!services.getTags || !services.createTag) throw new Error("当前页面助手版本不支持标签映射，请重新加载扩展和 Botcake 页面");
  const targetTags = await services.getTags();
  const byName = new Map(targetTags.map((tag) => [tag.name.trim().toLocaleLowerCase(), tag]));
  const bySourceId = new Map<string, BotcakeTag>();
  for (const dependency of dependencies) {
    const normalized = dependency.name.trim().toLocaleLowerCase();
    let target = byName.get(normalized);
    if (!target) {
      target = await services.createTag(dependency.name);
      byName.set(normalized, target);
      report.createdTags.push(dependency.name);
    }
    if (dependency.sourceId) bySourceId.set(dependency.sourceId, target);
    report.mappedTags.push({ name: dependency.name, from: dependency.sourceId, to: String(target.id) });
  }

  const blocks = Array.isArray(post.blocks) ? post.blocks : [];
  for (const blockValue of blocks) {
    if (!blockValue || typeof blockValue !== "object" || Array.isArray(blockValue)) continue;
    const block = blockValue as Record<string, unknown>;
    if (String(block.type ?? "").toLocaleLowerCase() === "action" && Array.isArray(block.action)) {
      for (const actionValue of block.action) {
        if (!actionValue || typeof actionValue !== "object" || Array.isArray(actionValue)) continue;
        const action = actionValue as Record<string, unknown>;
        if (!new Set(["add_tag", "remove_tag"]).has(String(action.action ?? ""))) continue;
        const ids = Array.isArray(action.action_id) ? action.action_id : [action.action_id];
        action.action_id = ids.map((id) => bySourceId.get(String(id))?.id ?? id);
      }
    }
    walkJson(block, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const rule = value as Record<string, unknown>;
      if (rule.type !== "tags" || !Array.isArray(rule.tags)) return;
      rule.tags.forEach((tagValue) => {
        if (!tagValue || typeof tagValue !== "object" || Array.isArray(tagValue)) return;
        const tag = tagValue as Record<string, unknown>;
        const target = bySourceId.get(String(tag.tag_id ?? ""));
        if (!target) return;
        tag.tag_id = target.id;
        tag.label = target.name;
      });
    });
  }
}

function restoreEntryBlock(post: Record<string, unknown>, entryBlockKey: string): void {
  const blocks = post.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("模板没有可作为入口的节点");

  const entryIndex = blocks.findIndex((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    return (block as Record<string, unknown>).key === entryBlockKey;
  });
  if (entryIndex < 0) throw new Error(`模板入口节点不存在：${entryBlockKey}`);
  if (entryIndex === 0) return;

  post.blocks = [blocks[entryIndex], ...blocks.slice(0, entryIndex), ...blocks.slice(entryIndex + 1)];
}

function preserveTargetFlowEnvelope(post: Record<string, unknown>, target: FlowSnapshot): void {
  const targetPost = target.post;
  for (const key of ["id", "name", "path", "is_published", "is_locked", "published_at", "drafted_at", "status"] as const) {
    if (targetPost[key] !== undefined) post[key] = deepClone(targetPost[key]);
    else delete post[key];
  }
  post.id = typeof targetPost.id === "number" ? Number(target.identity.flowId) : target.identity.flowId;
  post.name = target.name;
}

async function applyTextInputs(
  post: Record<string, unknown>,
  template: FlowTemplateV1,
  values: Record<string, ImportInputValue>,
  services: CompileServices,
): Promise<void> {
  const definitions = new Map(template.inputs.map((input) => [input.key, input]));
  const resolvedValues = new Map<string, string>();
  for (const definition of template.inputs) {
    if (isMediaKind(definition.kind)) continue;
    const supplied = values[definition.key]?.text;
    let resolved = supplied ?? (definition.default == null ? "" : String(definition.default));
    if (definition.kind === "random" && !supplied) {
      const options = definition.options ?? [];
      if (!options.length) throw new Error(`随机变量“${definition.label}”没有可用选项`);
      const option = options[Math.floor(Math.random() * options.length)];
      if (option.url) {
        if (!services.fetchText) throw new Error(`随机变量“${definition.label}”的远程选项无法读取`);
        resolved = await services.fetchText(normalizePublicDriveUrl(option.url));
      } else {
        resolved = option.value ?? "";
      }
    }
    if (definition.required && !resolved.trim()) throw new Error(`请填写“${definition.label}”`);
    if (definition.kind === "number" && resolved.trim() && !Number.isFinite(Number(resolved))) {
      throw new Error(`“${definition.label}”必须填写有效数字`);
    }
    resolvedValues.set(definition.key, resolved);
  }
  walkJson(post, (value, _path, parent, key) => {
    if (typeof value !== "string" || parent == null || key == null) return;
    const replaced = value.replace(/\[\[([A-Za-z0-9_.-]+)\]\]/g, (_all, inputKey: string) => {
      const definition = definitions.get(inputKey);
      if (definition && isMediaKind(definition.kind)) return _all;
      return resolvedValues.get(inputKey) ?? "";
    });
    (parent as Record<string | number, unknown>)[key] = replaced;
  });
}

async function mapBotFields(
  post: Record<string, unknown>,
  template: FlowTemplateV1,
  services: CompileServices,
  report: CompileReport,
): Promise<void> {
  const fields = await services.getBotFields();
  const byName = new Map(fields.map((field) => [field.name.trim().toLocaleLowerCase(), field]));
  const mappings = new Map<string, string>();
  for (const dependency of template.dependencies.botFields) {
    const normalized = dependency.name.trim().toLocaleLowerCase();
    let target = byName.get(normalized);
    if (!target) {
      target = await services.createBotField(
        dependency.name,
        dependency.fieldType,
        dependency.defaultValue,
        dependency.description,
      );
      byName.set(normalized, target);
      report.createdBotFields.push(dependency.name);
    }
    mappings.set(normalized, String(target.id));
    report.mappedBotFields.push({ name: dependency.name, from: dependency.sourceId, to: String(target.id) });
  }
  walkJson(post, (value, _path, parent, key) => {
    if (typeof value !== "string" || parent == null || key == null) return;
    const replaced = value.replace(/\{\{(\d+)\/\|([^}]+)\}\}/g, (whole, _id: string, name: string) => {
      const targetId = mappings.get(name.trim().toLocaleLowerCase());
      return targetId ? `{{${targetId}/|${name.trim()}}}` : whole;
    });
    (parent as Record<string | number, unknown>)[key] = replaced;
  });
}

async function resolveMedia(
  media: MediaDependency,
  input: ImportInputValue | undefined,
  assets: Map<string, Uint8Array>,
  services: CompileServices,
): Promise<{ bytes: Uint8Array; name: string; mime: string } | undefined> {
  if (input?.bytes) return {
    bytes: input.bytes,
    name: input.fileName ?? media.name ?? `${media.key}.${defaultExtension(media.kind)}`,
    mime: inferMediaMime(media.kind, input.bytes, input.mime ?? media.mime, input.fileName ?? media.name),
  };
  const explicit = Boolean(input?.bytes || input?.asset || input?.url);
  const assetName = input?.asset ?? media.asset;
  if (assetName && assets.has(assetName)) return {
    bytes: assets.get(assetName)!,
    name: media.name ?? assetName.split("/").at(-1)!,
    mime: inferMediaMime(media.kind, assets.get(assetName)!, input?.mime ?? media.mime, assetName),
  };
  if (input?.asset && !input.url) throw new Error(`素材变量“${media.key}”引用的资源包文件不存在：${input.asset}`);
  const url = input?.url ?? media.sourceUrl;
  if (url) {
    const result = await services.fetchBytes(normalizePublicDriveUrl(url));
    return {
      bytes: result.bytes,
      name: input?.fileName ?? result.fileName ?? media.name ?? `${media.key}.${defaultExtension(media.kind)}`,
      mime: inferMediaMime(media.kind, result.bytes, input?.mime ?? result.contentType ?? media.mime, result.fileName ?? media.name ?? url),
    };
  }
  if (explicit) throw new Error(`素材变量“${media.key}”没有可用文件或 URL`);
  return undefined;
}

function patchMediaConfig(post: Record<string, unknown>, path: string, upload: Record<string, unknown>): void {
  const current = getByPath(post, path);
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error(`素材位置不存在：${path}`);
  const config = { ...(current as Record<string, unknown>) };
  const contentUrl = upload.content_url ?? upload.url;
  const previewUrl = upload.content_preview_url ?? upload.preview_url ?? contentUrl;
  if (contentUrl) {
    config.url = contentUrl;
    config.content_url = contentUrl;
  }
  if (previewUrl) config.preview_url = previewUrl;
  for (const key of ["content_id", "fb_id", "name", "page_id"] as const) {
    if (upload[key] !== undefined) config[key] = upload[key];
  }
  config.insert_url = false;
  setByPath(post, path, config);
}

function validateMedia(bytes: Uint8Array, kind: MediaKind, mime: string): void {
  if (!bytes.byteLength) throw new Error("素材文件为空");
  if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) throw new Error("单个素材超过 30MB");
  if (!mime.startsWith(`${kind}/`)) throw new Error(`${kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频"} MIME 类型不正确：${mime}`);
}

function defaultMime(kind: MediaKind): string {
  return kind === "image" ? "image/jpeg" : kind === "audio" ? "audio/mpeg" : "video/mp4";
}

export function uploadServiceAdapter(
  fn: (data: { kind: MediaKind; name: string; mime: string; base64: string }) => Promise<Record<string, unknown>>,
): CompileServices["uploadMedia"] {
  return (data) => fn({ ...data, base64: bytesToBase64(data.bytes) });
}

function isMediaKind(kind: FlowTemplateV1["inputs"][number]["kind"]): kind is MediaKind {
  return kind === "image" || kind === "audio" || kind === "video";
}

function defaultExtension(kind: MediaKind): string {
  return kind === "image" ? "jpg" : kind === "audio" ? "mp3" : "mp4";
}

function hasMediaValue(value: ImportInputValue | undefined): boolean {
  return Boolean(value?.bytes?.byteLength || value?.asset?.trim() || value?.url?.trim());
}
