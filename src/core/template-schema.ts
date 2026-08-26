import { z } from "zod";
import { TEMPLATE_FORMAT, TEMPLATE_VERSION } from "../shared/constants";

const inputOptionSchema = z.object({
  label: z.string().min(1),
  value: z.string().optional(),
  asset: z.string().optional(),
  url: z.string().url().optional(),
});

const templateInputSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  label: z.string().min(1),
  kind: z.enum(["text", "number", "random", "image", "audio", "video"]),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number()]).optional(),
  description: z.string().optional(),
  options: z.array(inputOptionSchema).optional(),
  bindings: z.array(z.string()).optional(),
  accept: z.string().optional(),
  retainWhenUnused: z.boolean().optional(),
}).superRefine((input, context) => {
  const media = input.kind === "image" || input.kind === "audio" || input.kind === "video";
  if (input.kind === "random" && !input.options?.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "随机选项至少需要配置一个预置选项" });
  }
  if (input.kind === "number" && input.default !== undefined && !isFiniteNumber(input.default)) {
    context.addIssue({ code: "custom", path: ["default"], message: "数字变量的默认值必须是有效数字" });
  }
  input.options?.forEach((option, index) => {
    if (media && !option.asset?.trim() && !option.url) {
      context.addIssue({ code: "custom", path: ["options", index], message: "素材选项必须填写资源包路径或 URL" });
    }
    if (!media && !option.value?.trim() && !option.url) {
      context.addIssue({ code: "custom", path: ["options", index], message: "文字、数字或随机选项必须填写实际内容或远程文本 URL" });
    }
    if (input.kind === "number" && option.value !== undefined && !isFiniteNumber(option.value)) {
      context.addIssue({ code: "custom", path: ["options", index, "value"], message: "数字选项的实际内容必须是有效数字" });
    }
  });
});

export const flowTemplateSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  version: z.literal(TEMPLATE_VERSION),
  meta: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    createdAt: z.string(),
    sourcePageId: z.string().optional(),
    sourceFlowId: z.string().optional(),
  }),
  flow: z.object({
    name: z.string(),
    post: z.record(z.string(), z.unknown()),
    entryBlockKey: z.string().min(1),
    selectedTab: z.union([z.string(), z.number()]).optional(),
    isPreview: z.boolean().optional(),
    isPreviewPublished: z.boolean().optional(),
  }),
  inputs: z.array(templateInputSchema),
  dependencies: z.object({
    botFields: z.array(z.object({
      name: z.string().min(1),
      sourceId: z.string().optional(),
      fieldType: z.string().optional(),
      defaultValue: z.unknown().optional(),
      description: z.string().optional(),
    })),
    tags: z.array(z.object({
      name: z.string().min(1),
      sourceId: z.string().optional(),
    })).optional(),
    media: z.array(z.object({
      key: z.string().min(1),
      kind: z.enum(["image", "audio", "video"]),
      configPath: z.string().min(1),
      sourceUrl: z.string().optional(),
      asset: z.string().optional(),
      name: z.string().optional(),
      mime: z.string().optional(),
    })),
    unsupported: z.array(z.object({
      path: z.string(),
      key: z.string(),
      value: z.unknown(),
      reason: z.string(),
    })),
  }),
}).superRefine((template, context) => {
  const seen = new Set<string>();
  template.inputs.forEach((input, index) => {
    if (seen.has(input.key)) context.addIssue({ code: "custom", path: ["inputs", index, "key"], message: `变量标识重复：${input.key}` });
    seen.add(input.key);
  });
  const mediaPaths = new Set<string>();
  template.dependencies.media.forEach((media, index) => {
    if (mediaPaths.has(media.configPath)) context.addIssue({ code: "custom", path: ["dependencies", "media", index, "configPath"], message: `素材位置重复：${media.configPath}` });
    mediaPaths.add(media.configPath);
  });
});

function isFiniteNumber(value: string | number): boolean {
  return String(value).trim() !== "" && Number.isFinite(Number(value));
}
