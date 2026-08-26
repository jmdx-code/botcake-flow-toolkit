import type { FlowTemplateV1, MediaKind } from "../shared/types";
import { getByPath, walkJson } from "../shared/utils";

const PLACEHOLDER_RE = /\[\[([A-Za-z0-9_.-]+)]]/g;
const BOT_FIELD_RE = /\{\{\d+\/\|([^}]+)}}/g;

export function templateContractIssues(template: FlowTemplateV1): string[] {
  const issues: string[] = [];
  const inputs = new Map(template.inputs.map((input) => [input.key, input]));
  const mediaByPath = new Map(template.dependencies.media.map((media) => [media.configPath, media]));
  const botNames = new Set(template.dependencies.botFields.map((field) => field.name.trim().toLocaleLowerCase()));
  const tagIds = new Set((template.dependencies.tags ?? []).flatMap((tag) => tag.sourceId ? [tag.sourceId] : []));

  walkJson(template.flow.post, (value, path) => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      const input = inputs.get(match[1]);
      if (!input) issues.push(`${path} 使用了未定义变量 [[${match[1]}]]`);
      else if (isMediaKind(input.kind)) issues.push(`${path} 把素材变量 [[${match[1]}]] 当作文字使用`);
    }
    for (const match of value.matchAll(BOT_FIELD_RE)) {
      const name = match[1].trim();
      if (!botNames.has(name.toLocaleLowerCase())) issues.push(`${path} 使用了未登记的机器人变量“${name}”`);
    }
  });

  walkJson(template.flow.post, (value, path, parent, key) => {
    if (key === "tag_id" && (typeof value === "string" || typeof value === "number") && !tagIds.has(String(value))) {
      issues.push(`${path} 使用了未登记的标签 ID ${String(value)}`);
    }
    if (key !== "action_id" || !parent || Array.isArray(parent) || typeof parent !== "object") return;
    const action = (parent as Record<string, unknown>).action;
    if (action !== "add_tag" && action !== "remove_tag") return;
    const ids = Array.isArray(value) ? value : [value];
    ids.forEach((id) => {
      if ((typeof id === "string" || typeof id === "number") && !tagIds.has(String(id))) {
        issues.push(`${path} 使用了未登记的标签 ID ${String(id)}`);
      }
    });
  });

  for (const dependency of template.dependencies.media) {
    const config = getByPath(template.flow.post, dependency.configPath);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      issues.push(`素材位置不存在：${dependency.configPath}`);
      continue;
    }
    const input = inputs.get(dependency.key);
    if (!input) continue;
    if (!isMediaKind(input.kind) || input.kind !== dependency.kind) {
      issues.push(`素材 ${dependency.configPath} 与变量 [[${dependency.key}]] 类型不一致`);
      continue;
    }
    if (!(input.bindings ?? []).includes(dependency.configPath)) {
      issues.push(`素材变量 [[${dependency.key}]] 缺少位置绑定：${dependency.configPath}`);
    }
  }

  for (const input of template.inputs) {
    if (!isMediaKind(input.kind)) continue;
    for (const path of input.bindings ?? []) {
      const dependency = mediaByPath.get(path);
      if (!dependency || dependency.key !== input.key || dependency.kind !== input.kind) {
        issues.push(`素材变量 [[${input.key}]] 的绑定与素材依赖不一致：${path}`);
      }
    }
  }

  return [...new Set(issues)];
}

export function assertTemplateContract(template: FlowTemplateV1): void {
  const issues = templateContractIssues(template);
  if (!issues.length) return;
  throw new Error(`模板结构与依赖不一致：${issues.slice(0, 3).join("；")}${issues.length > 3 ? `；另有 ${issues.length - 3} 项` : ""}`);
}

function isMediaKind(kind: FlowTemplateV1["inputs"][number]["kind"]): kind is MediaKind {
  return kind === "image" || kind === "audio" || kind === "video";
}
