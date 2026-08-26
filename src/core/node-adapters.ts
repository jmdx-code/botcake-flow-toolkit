import type { FlowTemplateV1 } from "../shared/types";
import { getBlocks } from "./template-graph";

type JsonRecord = Record<string, unknown>;

export type ConditionRuleView = {
  path: string;
  type: string;
  title: string;
  label: string;
  beginHour?: number;
  beginMinute?: number;
  endHour?: number;
  endMinute?: number;
  weekDays: number[];
  tags: string[];
  values: Array<{ key: string; value: string | number | boolean }>;
};

export type ConditionBranchView = {
  index: number;
  path: string;
  operator: string;
  targetBlockKey: string;
  rules: ConditionRuleView[];
};

export type ConditionNodeView = {
  branches: ConditionBranchView[];
  defaultTargetBlockKey: string;
};

export type DelayNodeView = {
  path: string;
  delayType: string;
  delayUnits: string;
  delayValue: number;
  useTimeWindow: boolean;
  sendingTimeStart: number;
  sendingTimeEnd: number;
  targetBlockKey: string;
};

export type ActionItemView = {
  path: string;
  action: string;
  label: string;
  tagNames: string[];
  portable: boolean;
};

export type ActionNodeView = {
  actions: ActionItemView[];
  targetBlockKey: string;
};

const ACTION_LABELS: Record<string, string> = {
  add_tag: "添加标签",
  remove_tag: "移除标签",
  block_customer: "拉黑客户",
  active_bot: "开启机器人",
  deactivate_bot: "暂停机器人",
  sign_follow_bot: "订阅机器人",
  cancel_sign_follow_bot: "取消订阅机器人",
  mark_acc_seeding: "标记为养号账号",
  unmark_acc_seeding: "取消养号标记",
  handover_to_page_inbox: "转交专页收件箱",
  pass_control_back_to_bot: "交还 Botcake",
  report_spam: "标记垃圾信息",
  mark_unread: "标记未读",
  mark_read: "标记已读",
  clear_chat_history_ai: "清除 AI 对话记录",
  deactivate_gpt: "暂停 Botcake AI",
  active_gpt: "启用 Botcake AI",
  active_biz_ai: "启用 BizAI",
  deactivate_biz_ai: "停用 BizAI",
  hide_comment: "隐藏评论",
  delete_comment: "删除评论",
  confirm_latest_order: "确认最新订单",
  cancel_latest_order: "取消最新订单",
  new_subscriber: "标记为新订阅者",
};

const CONDITION_TECHNICAL_KEYS = new Set([
  "type", "title", "label", "begin_hour", "begin_min", "end_hour", "end_min",
  "week_days", "start_date", "end_date",
]);

export function getConditionNodeView(template: FlowTemplateV1, blockIndex: number): ConditionNodeView | undefined {
  const block = getBlocks(template)[blockIndex];
  if (!block || stringValue(block.type) !== "condition") return undefined;
  const cards = Array.isArray(block.cards) ? block.cards : [];
  return {
    branches: cards.map((card, index) => {
      const branch = recordValue(card);
      const rules = Array.isArray(branch.condition) ? branch.condition : [];
      return {
        index,
        path: `$.blocks[${blockIndex}].cards[${index}]`,
        operator: stringValue(branch.type) || "and",
        targetBlockKey: stringValue(recordValue(branch.gotos).block_key),
        rules: rules.map((rule, ruleIndex) => conditionRuleView(rule, `$.blocks[${blockIndex}].cards[${index}].condition[${ruleIndex}]`)),
      };
    }),
    defaultTargetBlockKey: stringValue(recordValue(block.defaultGotos).block_key),
  };
}

export function getDelayNodeView(template: FlowTemplateV1, blockIndex: number): DelayNodeView | undefined {
  const block = getBlocks(template)[blockIndex];
  if (!block || !["smart_delay", "delay"].includes(stringValue(block.type))) return undefined;
  const config = recordValue(block.config);
  return {
    path: `$.blocks[${blockIndex}].config`,
    delayType: stringValue(config.delayType) || "duration",
    delayUnits: stringValue(config.delayUnits) || "minutes",
    delayValue: numberValue(config.delayValue, 1),
    useTimeWindow: Boolean(config.useTimeWindow),
    sendingTimeStart: numberValue(config.sendingTimeStart, 8),
    sendingTimeEnd: numberValue(config.sendingTimeEnd, 22),
    targetBlockKey: stringValue(recordValue(block.defaultGotos).block_key),
  };
}

export function getActionNodeView(template: FlowTemplateV1, blockIndex: number): ActionNodeView | undefined {
  const block = getBlocks(template)[blockIndex];
  if (!block || stringValue(block.type) !== "action") return undefined;
  const tagsById = new Map((template.dependencies.tags ?? []).flatMap((tag) => tag.sourceId ? [[tag.sourceId, tag.name] as const] : []));
  const actions = Array.isArray(block.action) ? block.action : [];
  return {
    actions: actions.flatMap((value, index) => {
      const item = recordValue(value);
      const action = stringValue(item.action);
      if (!action) return [];
      const ids = Array.isArray(item.action_id) ? item.action_id : [item.action_id];
      const tagNames = ids.flatMap((id) => {
        const name = tagsById.get(String(id ?? ""));
        return name ? [name] : [];
      });
      return [{
        path: `$.blocks[${blockIndex}].action[${index}]`,
        action,
        label: ACTION_LABELS[action] ?? action,
        tagNames,
        portable: action in ACTION_LABELS,
      }];
    }),
    targetBlockKey: stringValue(recordValue(block.defaultGotos).block_key) || stringValue(recordValue(block.gotos).block_key),
  };
}

function conditionRuleView(value: unknown, path: string): ConditionRuleView {
  const rule = recordValue(value);
  return {
    path,
    type: stringValue(rule.type) || "unknown",
    title: stringValue(rule.title) || stringValue(rule.type) || "未识别条件",
    label: stringValue(rule.label),
    beginHour: optionalNumber(rule.begin_hour),
    beginMinute: optionalNumber(rule.begin_min),
    endHour: optionalNumber(rule.end_hour),
    endMinute: optionalNumber(rule.end_min),
    weekDays: Array.isArray(rule.week_days) ? rule.week_days.filter((item): item is number => typeof item === "number") : [],
    tags: Array.isArray(rule.tags) ? rule.tags.flatMap((item) => {
      const tag = recordValue(item);
      return typeof tag.label === "string" && tag.label.trim() ? [tag.label.trim()] : [];
    }) : [],
    values: Object.entries(rule).flatMap(([key, item]) => {
      if (CONDITION_TECHNICAL_KEYS.has(key) || !["string", "number", "boolean"].includes(typeof item)) return [];
      return [{ key, value: item as string | number | boolean }];
    }),
  };
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return optionalNumber(value) ?? fallback;
}
