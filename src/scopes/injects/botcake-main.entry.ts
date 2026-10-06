import { APP_ID, DEFAULT_REPLY_EDIT_URL_PATTERN } from "../../shared/constants";
import { redactCredential } from "../../core/security-errors";
import { isSameBotcakeTimezone, toBotcakeTimezoneValue } from "../../core/botcake-timezone";
import type {
  BotField,
  BotcakeTag,
  BotFieldSpec,
  CommentAutomationSettings,
  CommentFlowStatus,
  CommentReplyItem,
  EnsureBotFieldsResult,
  EnsureDefaultCommentFlowResult,
  EnsureKeywordFlowResult,
  FinalizeKeywordFlowResult,
  EnsureWelcomeFlowResult,
  FlowSnapshot,
  MainAction,
  MainBridgeRequest,
  MainBridgeResponse,
  MainRequestMap,
  MainResponseMap,
  PageAutomationState,
  SaveFlowPayload,
  UpdatePageAutomationPayload,
  UpdatePageAutomationResult,
  AnalyticsLogEntry,
  AnalyticsPage,
  AnalyticsPageTraffic,
  TrafficDashboardData,
} from "../../shared/types";
import { buildCreateBotcakeTagForm } from "../../core/botcake-tags";
import { base64ToBytes, getFlowIdentity } from "../../shared/utils";
import {
  addAnalyticsDays,
  aggregateCustomerTraffic,
  assertTimezone,
  dateInAnalyticsTimezone,
  enumerateIsoDates,
  parseAnalyticsTimestamp,
} from "../../core/traffic-analytics";

type RuntimeState = {
  accessToken: string;
  selectedPost?: Record<string, unknown>;
  botFields: BotField[];
  tags: BotcakeTag[];
  selectedTab?: string | number;
  currentPageId?: string;
};

type BotcakeReduxState = {
  auth?: { accessToken?: unknown; access_token?: unknown };
  cards?: { selectedPost?: unknown; selectedTabMenu?: unknown; privateReplies?: unknown };
  pages?: { botFields?: unknown; bot_fields?: unknown; tags?: unknown; currentPageId?: unknown; currentSettings?: unknown };
};

declare global {
  interface Window {
    __NEXT_REDUX_STORE__?: { getState?: () => BotcakeReduxState };
    __BOTCAKE_FLOW_TOOLKIT_ROUTE_OBSERVER__?: boolean;
    __BOTCAKE_FLOW_TOOLKIT_BRIDGE__?: boolean;
  }
}

installRouteObserver();
if (!window.__BOTCAKE_FLOW_TOOLKIT_BRIDGE__) {
  window.__BOTCAKE_FLOW_TOOLKIT_BRIDGE__ = true;
  window.addEventListener("message", (event: MessageEvent<MainBridgeRequest>) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || !message || message.app !== APP_ID || message.channel !== "request" || typeof message.requestId !== "string" || typeof message.action !== "string") return;
    void handleRequest(message);
  });
}

async function handleRequest<A extends MainAction>(request: MainBridgeRequest<A>): Promise<void> {
  const response: MainBridgeResponse<A> = {
    app: APP_ID,
    channel: "response",
    requestId: request.requestId,
    action: request.action,
    ok: false,
  };
  try {
    response.result = await dispatch(request.action, request.payload) as MainResponseMap[A];
    response.ok = true;
  } catch (error) {
    response.error = redactCredential(error instanceof Error ? error.message : String(error), "");
  }
  window.postMessage(response, location.origin);
}

async function dispatch<A extends MainAction>(action: A, payload: MainRequestMap[A]): Promise<MainResponseMap[A]> {
  switch (action) {
    case "inspect": return inspectFlow() as MainResponseMap[A];
    case "saveFlow": return saveFlow(payload as SaveFlowPayload) as Promise<MainResponseMap[A]>;
    case "getBotFields": return getBotFields() as Promise<MainResponseMap[A]>;
    case "createBotField": {
      const value = payload as MainRequestMap["createBotField"];
      return createBotField(value.name, value.type, value.value, value.description) as Promise<MainResponseMap[A]>;
    }
    case "getTags": return getTags() as Promise<MainResponseMap[A]>;
    case "createTag": return createTag((payload as MainRequestMap["createTag"]).name) as Promise<MainResponseMap[A]>;
    case "uploadMedia": return uploadMedia(payload as MainRequestMap["uploadMedia"]) as Promise<MainResponseMap[A]>;
    case "getPrivateReplies": return getPrivateReplies() as Promise<MainResponseMap[A]>;
    case "getCommentFlowStatus": return getCommentFlowStatus() as Promise<MainResponseMap[A]>;
    case "getPageAutomationState": return getPageAutomationState() as Promise<MainResponseMap[A]>;
    case "updatePageAutomation": return updatePageAutomation(payload as UpdatePageAutomationPayload) as Promise<MainResponseMap[A]>;
    case "ensureBotFields": return ensureBotFields((payload as MainRequestMap["ensureBotFields"]).fields) as Promise<MainResponseMap[A]>;
    case "ensureDefaultCommentFlow": return ensureDefaultCommentFlow(payload as MainRequestMap["ensureDefaultCommentFlow"]) as Promise<MainResponseMap[A]>;
    case "ensureWelcomeFlowFromComment": return ensureWelcomeFlowFromComment(payload as MainRequestMap["ensureWelcomeFlowFromComment"]) as Promise<MainResponseMap[A]>;
    case "ensureDefaultReplyFlow": return ensureDefaultReplyFlow(payload as MainRequestMap["ensureDefaultReplyFlow"]) as Promise<MainResponseMap[A]>;
    case "ensureKeywordFlow": return ensureKeywordFlow(payload as MainRequestMap["ensureKeywordFlow"]) as Promise<MainResponseMap[A]>;
    case "finalizeKeywordFlow": return finalizeKeywordFlow(payload as MainRequestMap["finalizeKeywordFlow"]) as Promise<MainResponseMap[A]>;
    case "activateDefaultReply": return activateDefaultReply() as Promise<MainResponseMap[A]>;
    case "getAnalyticsPages": return getAnalyticsPages() as Promise<MainResponseMap[A]>;
    case "getTrafficDashboardData": return getTrafficDashboardData(payload as MainRequestMap["getTrafficDashboardData"]) as Promise<MainResponseMap[A]>;
    default: throw new Error(`不支持的页面操作：${String(action)}`);
  }
}

const COMMENT_SIMPLE_SETTING_KEYS = {
  autoReplyComment: "auto_reply_comment",
  autoInbox: "inbox_from_comment",
  prioritizePostSettings: "prioritize_auto_reply_with_setup_of_each_post",
  replyBasedOnSpecificPosts: "only_reply_post_config",
  onlyFirstCommentOnPage: "only_reply_first_comment",
  onlyFirstCommentOnEachPost: "inbox_first_comment_post",
  onlyFirstLevelComments: "only_track_first_level_comment",
  inboxCommentsFromGroupPosts: "auto_comment_in_group",
  autoLikeComments: "auto_like_comment",
  ignoreSeedingAccounts: "no_auto_inb_fr_cmt_seeding",
} as const;

async function getPageAutomationState(): Promise<PageAutomationState> {
  const pageId = getCurrentPageId();
  const settings = getCurrentSettings();
  const replies = await getPrivateRepliesWithRetry(pageId, readRuntime().accessToken);
  const defaultReply = firstRecord(replies[0]);
  const welcome = await getWelcomeState(pageId, readRuntime().accessToken, settings);
  const systemDefault = await getDefaultReplyState(pageId, readRuntime().accessToken);
  return {
    pageId,
    timezone: finiteNumber(settings.time_zone),
    targetCountryCodes: readTargetCountryCodes(settings.webform_setting),
    comment: commentAutomationFromSettings(settings),
    defaultPrivateReply: defaultReply?.id ? {
      id: String(defaultReply.id),
      name: String(defaultReply.name ?? defaultReply.title ?? `Flow ${defaultReply.id}`),
    } : undefined,
    defaultReply: systemDefault,
    welcome,
    botFields: await getBotFields(),
  };
}

async function updatePageAutomation(payload: UpdatePageAutomationPayload): Promise<UpdatePageAutomationResult> {
  const pageId = getCurrentPageId();
  const runtime = readRuntime();
  const settings = getCurrentSettings();
  const changed: string[] = [];

  if (payload.timezone !== undefined && !isSameBotcakeTimezone(settings.time_zone, payload.timezone)) {
    const timezoneValue = toBotcakeTimezoneValue(payload.timezone);
    const form = new FormData();
    form.append("timezone", timezoneValue);
    await botcakeFetch(`/api/v1/pages/${pageId}/change_timezone`, runtime.accessToken, { method: "POST", body: form });
    settings.time_zone = timezoneValue;
    changed.push("timezone");
  }

  if (payload.targetCountryCodes) {
    const countryCodes = uniqueStrings(payload.targetCountryCodes);
    if (!countryCodes.length) throw new Error("目标地区至少保留一个国家/地区");
    if (JSON.stringify(countryCodes) !== JSON.stringify(readTargetCountryCodes(settings.webform_setting))) {
      await saveTargetCountryCodes(pageId, runtime.accessToken, settings, countryCodes);
      settings.webform_setting = { ...readWebformSetting(settings.webform_setting), country: countryCodes };
      changed.push("targetCountryCodes");
    }
  }

  if (payload.comment) {
    if (payload.comment.onlyFirstCommentOnPage === true && payload.comment.onlyFirstCommentOnEachPost === true) {
      throw new Error("“专页首次评论”和“每篇帖子首次评论”不能同时开启");
    }
    if (payload.comment.onlyFirstCommentOnPage === true && booleanValue(settings.inbox_first_comment_post)) {
      await saveSimplePageSetting(pageId, runtime.accessToken, "inbox_first_comment_post", false);
      settings.inbox_first_comment_post = false;
      changed.push("comment.onlyFirstCommentOnEachPost");
    }
    if (payload.comment.onlyFirstCommentOnEachPost === true && booleanValue(settings.only_reply_first_comment)) {
      await saveSimplePageSetting(pageId, runtime.accessToken, "only_reply_first_comment", false);
      settings.only_reply_first_comment = false;
      changed.push("comment.onlyFirstCommentOnPage");
    }
    const simpleEntries = Object.entries(COMMENT_SIMPLE_SETTING_KEYS) as Array<[keyof typeof COMMENT_SIMPLE_SETTING_KEYS, string]>;
    for (const [uiKey, apiKey] of simpleEntries) {
      const value = payload.comment[uiKey];
      if (typeof value !== "boolean" || booleanValue(settings[apiKey]) === value) continue;
      await saveSimplePageSetting(pageId, runtime.accessToken, apiKey, value);
      settings[apiKey] = value;
      changed.push(`comment.${uiKey}`);
    }
    if (payload.comment.replies) {
      const normalized = normalizeCommentReplies(payload.comment.replies);
      if (JSON.stringify(normalized) !== JSON.stringify(normalizeCommentReplies(arrayValue(settings.data_comments)))) {
        await saveCommentReplies(pageId, runtime.accessToken, settings, normalized);
        settings.data_comments = normalized;
        changed.push("comment.replies");
      }
    }
  }

  const replies = await getPrivateRepliesWithRetry(pageId, runtime.accessToken);
  const defaultReply = firstRecord(replies[0]);
  const welcome = await getWelcomeState(pageId, runtime.accessToken, settings);
  const systemDefault = await getDefaultReplyState(pageId, runtime.accessToken);
  return {
    changed,
    state: {
      pageId,
      timezone: finiteNumber(settings.time_zone),
      targetCountryCodes: readTargetCountryCodes(settings.webform_setting),
      comment: commentAutomationFromSettings(settings),
      defaultPrivateReply: defaultReply?.id ? { id: String(defaultReply.id), name: String(defaultReply.name ?? defaultReply.title ?? `Flow ${defaultReply.id}`) } : undefined,
      defaultReply: systemDefault,
      welcome,
      botFields: await getBotFields(),
    },
  };
}

async function getDefaultReplyState(pageId: string, token: string): Promise<PageAutomationState["defaultReply"]> {
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/get_contents?type=default`, token);
  const flow = firstRecord(result?.flow) ?? firstRecord(arrayValue(result?.flow)[0]);
  return flow?.id ? {
    id: String(flow.id),
    name: String(flow.name ?? flow.title ?? "Default message"),
  } : undefined;
}

async function ensureDefaultReplyFlow(payload: MainRequestMap["ensureDefaultReplyFlow"]): Promise<MainResponseMap["ensureDefaultReplyFlow"]> {
  const pageId = getCurrentPageId();
  const runtime = readRuntime();
  const name = payload.name?.trim() || "默认回复";
  const existing = await getDefaultReplyState(pageId, runtime.accessToken);
  if (existing) return { created: false, flow: existing };
  const blocks = createPrivateReplySkeleton(name).blocks;
  const post = { blocks, drafts: { blocks: cloneSerializable(blocks) }, config: {}, name };
  const form = new FormData();
  form.append("post", JSON.stringify(post));
  form.append("type", "default");
  const created = await botcakeFetch(`/api/v1/pages/${pageId}/create_contents`, runtime.accessToken, { method: "POST", body: form });
  const updated = await getDefaultReplyState(pageId, runtime.accessToken);
  if (!updated) throw new Error(`Botcake 未返回新默认回复 ID：${JSON.stringify(created).slice(0, 400)}`);
  return { created: true, flow: updated };
}

async function ensureWelcomeFlowFromComment(payload: MainRequestMap["ensureWelcomeFlowFromComment"]): Promise<EnsureWelcomeFlowResult> {
  const pageId = getCurrentPageId();
  const runtime = readRuntime();
  const settings = getCurrentSettings();
  const replies = await getPrivateRepliesWithRetry(pageId, runtime.accessToken);
  const commentFlow = firstRecord(replies[0]);
  if (!commentFlow?.id) throw new Error("请先创建评论私信流程，再设置欢迎信息");

  const comment = {
    id: String(commentFlow.id),
    name: String(commentFlow.name ?? commentFlow.title ?? `Flow ${commentFlow.id}`),
  };
  const current = await getWelcomeState(pageId, runtime.accessToken, settings);
  let changed = false;
  if (current.flow?.id !== comment.id) {
    const form = new FormData();
    form.append("type", "welcomes");
    form.append("flow_id", comment.id);
    await botcakeFetch(`/api/v1/pages/${pageId}/replace`, runtime.accessToken, { method: "POST", body: form });
    changed = true;
  }
  const enable = payload.enable !== false;
  if (enable && !booleanValue(settings.is_started)) {
    await saveSimplePageSetting(pageId, runtime.accessToken, "is_started", true);
    changed = true;
  }
  return { changed, flow: comment, enabled: enable ? true : booleanValue(settings.is_started) };
}

async function getWelcomeState(
  pageId: string,
  token: string,
  settings: Record<string, any>,
): Promise<NonNullable<PageAutomationState["welcome"]>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await botcakeFetch(`/api/v1/pages/${pageId}/get_contents?type=welcome`, token);
      const flow = firstRecord(result?.flow);
      return {
        enabled: booleanValue(settings.is_started),
        ...(flow?.id ? { flow: { id: String(flow.id), name: String(flow.name ?? flow.title ?? `Flow ${flow.id}`) } } : {}),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function ensureBotFields(specs: BotFieldSpec[]): Promise<EnsureBotFieldsResult> {
  const allFields = await getAllBotFields();
  const activeByName = new Map(allFields
    .filter((field) => !booleanValue(field.is_archive))
    .map((field) => [field.name.trim().toLocaleLowerCase(), field]));
  const archivedByName = new Map(allFields
    .filter((field) => booleanValue(field.is_archive))
    .map((field) => [field.name.trim().toLocaleLowerCase(), field]));
  const created: BotField[] = [];
  const existing: BotField[] = [];
  const restored: BotField[] = [];
  for (const spec of specs) {
    const name = spec.name.trim();
    if (!name) throw new Error("机器人变量名称不能为空");
    const normalizedName = name.toLocaleLowerCase();
    const found = activeByName.get(normalizedName);
    if (found) { existing.push(found); continue; }
    const archived = archivedByName.get(normalizedName);
    if (archived) {
      await restoreBotFields([archived.id]);
      const active = { ...archived, is_archive: false };
      archivedByName.delete(normalizedName);
      activeByName.set(normalizedName, active);
      restored.push(active);
      continue;
    }
    const field = await createBotField(name, spec.type, spec.value, spec.description);
    activeByName.set(normalizedName, field);
    created.push(field);
  }
  return { created, existing, restored };
}

async function ensureDefaultCommentFlow(payload: MainRequestMap["ensureDefaultCommentFlow"]): Promise<EnsureDefaultCommentFlowResult> {
  const pageId = getCurrentPageId();
  const runtime = readRuntime();
  const settings = getCurrentSettings();
  const existingReplies = await getPrivateRepliesWithRetry(pageId, runtime.accessToken);
  const existing = firstRecord(existingReplies[0]);
  const enableAutoInbox = payload.enableAutoInbox !== false;
  if (existing?.id) {
    if (enableAutoInbox && !booleanValue(settings.inbox_from_comment)) {
      await saveSimplePageSetting(pageId, runtime.accessToken, "inbox_from_comment", true);
    }
    return {
      created: false,
      flow: { id: String(existing.id), name: String(existing.name ?? existing.title ?? `Flow ${existing.id}`) },
      autoInboxEnabled: enableAutoInbox ? true : booleanValue(settings.inbox_from_comment),
    };
  }

  const name = payload.name?.trim() || "评论";
  const post = createPrivateReplySkeleton(name);
  let replyId: string | undefined;
  try {
    const createForm = new FormData();
    createForm.append("post", JSON.stringify(post));
    const created = await botcakeFetch(`/api/v1/pages/${pageId}/create_private_reply?for_case=1`, runtime.accessToken, { method: "POST", body: createForm });
    replyId = String(created?.reply_id ?? created?.id ?? "");
    if (!replyId) throw new Error(`Botcake 未返回新评论流程 ID：${JSON.stringify(created).slice(0, 400)}`);

    post.id = Number.isSafeInteger(Number(replyId)) ? Number(replyId) : replyId;
    const saveForm = new FormData();
    saveForm.append("post", JSON.stringify(post));
    saveForm.append("is_preview", "false");
    saveForm.append("name", name);
    saveForm.append("is_preview_published", "false");
    saveForm.append("selected_tab", "content");
    await botcakeFetch(`/api/v1/pages/${pageId}/save_contents`, runtime.accessToken, { method: "POST", body: saveForm });
    if (enableAutoInbox) await saveSimplePageSetting(pageId, runtime.accessToken, "inbox_from_comment", true);
    return { created: true, flow: { id: replyId, name }, autoInboxEnabled: enableAutoInbox || booleanValue(settings.inbox_from_comment) };
  } catch (error) {
    if (replyId) {
      try { await botcakeFetch(`/api/v1/pages/${pageId}/private_replies?for_case=1`, runtime.accessToken, { method: "DELETE" }); }
      catch { /* best-effort rollback */ }
    }
    throw error;
  }
}

type CustomerKeywordRule = {
  id: string | number;
  name?: string;
  flow_id?: string | number | null;
  is_activated?: boolean;
  keyword_type?: number;
  content?: Record<string, unknown>;
};

type FlowSummary = {
  id: string | number;
  name?: string;
};

async function ensureKeywordFlow(payload: MainRequestMap["ensureKeywordFlow"]): Promise<EnsureKeywordFlowResult> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const name = payload.name.trim();
  const keywords = normalizeKeywordTerms(payload.keywords);
  if (!name) throw new Error("关键词流程名称不能为空");
  if (!keywords.length) throw new Error("关键词模板第三列至少需要一个关键词");

  const allRules = await getCustomerKeywords(pageId, accessToken);
  const matches = allRules
    .filter((keyword) => String(keyword.name ?? "").trim() === name);
  if (matches.length > 1) throw new Error(`找到 ${matches.length} 条同名关键词规则“${name}”，请先在 Botcake 中保留一条后重试`);

  let keyword = matches[0];
  let createdKeyword = false;
  if (!keyword) {
    // Repair an unbound rule left by an interrupted/older import instead of
    // creating another invisible duplicate.
    const reusable = allRules.filter((item) => !item.flow_id && sameKeywordTerms(keywordTermsFromRule(item), keywords));
    if (reusable.length > 1) {
      throw new Error(`找到 ${reusable.length} 条相同内容的未绑定关键词规则，请先在 Botcake 中清理后重试`);
    }
    if (reusable[0]) {
      keyword = reusable[0];
    } else {
      keyword = await createCustomerKeyword(pageId, accessToken, keywords);
      createdKeyword = true;
    }
  }

  let flowId = keyword.flow_id ? String(keyword.flow_id) : "";
  let createdFlow = false;
  if (!flowId) {
    const namedFlows = (await getNamedFlows(pageId, accessToken, name))
      .filter((flow) => String(flow.name ?? "").trim() === name);
    if (namedFlows.length > 1) throw new Error(`找到 ${namedFlows.length} 个同名 Flow“${name}”，请先在 Botcake 中保留一个后重试`);
    if (namedFlows[0]) {
      flowId = String(namedFlows[0].id);
    } else {
      flowId = await createNamedFlow(pageId, accessToken, name);
      createdFlow = true;
    }
  }

  // Do not bind or require the keyword here. A newly created Flow still has an
  // empty block list at this point, and Botcake may accept add_flow without
  // exposing the binding in the editable keyword list. The caller first saves
  // the complete Flow, then finalizeKeywordFlow performs the authoritative
  // update -> bind -> activate -> verify sequence.

  return {
    createdFlow,
    createdKeyword,
    flow: { id: flowId, name },
    keyword: {
      id: String(keyword.id),
      name,
      isActivated: Boolean(keyword.is_activated),
    },
  };
}

async function finalizeKeywordFlow(payload: MainRequestMap["finalizeKeywordFlow"]): Promise<FinalizeKeywordFlowResult> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const name = payload.name.trim();
  const keywords = normalizeKeywordTerms(payload.keywords);
  if (!name || !keywords.length) throw new Error("关键词流程名称或关键词为空，无法完成绑定");

  const rules = await getCustomerKeywords(pageId, accessToken);
  const listedKeyword = rules.find((item) => String(item.id) === String(payload.keywordId))
    ?? rules.find((item) => String(item.name ?? "").trim() === name);
  // Never trust a carried keyword ID that is absent from the authoritative
  // Customer-keyword list. Botcake returns success=true when update/add_flow is
  // called with an expired unbound ID, but silently persists nothing. This can
  // happen because importing a Flow navigates away for several seconds before
  // finalization. Recreate the rule now, after the Flow is fully saved, and bind
  // it immediately.
  let keyword: CustomerKeywordRule;
  if (listedKeyword) {
    keyword = listedKeyword;
    // A visible, unbound rule created with the official Customer payload can
    // be bound immediately. Avoid touching that draft when its terms already
    // match; bound rules still use the normal update path on later imports.
    if (keyword.flow_id || !sameKeywordTerms(keywordTermsFromRule(keyword), keywords)) {
      assertSuccessfulKeywordResponse(
        await updateCustomerKeyword(pageId, accessToken, keyword.id, keywords),
        "更新关键词",
      );
    }
  } else {
    // createCustomerKeyword already writes the complete type/content. Keep the
    // newly created rule untouched until it is bound: Botcake treats unbound
    // rules as a transient draft, and calling /update before /add_flow makes
    // that draft disappear even though both endpoints report success.
    keyword = await createCustomerKeyword(pageId, accessToken, keywords);
  }
  await bindKeywordFlow(pageId, accessToken, keyword.id, payload.flowId);

  if (!booleanValue(keyword.is_activated)) {
    const activateForm = new FormData();
    activateForm.append("keyword_id", String(keyword.id));
    // Botcake expects the current state here and toggles it on the server.
    activateForm.append("is_activated", "false");
    assertSuccessfulKeywordResponse(
      await botcakeFetch(`/api/v1/pages/${pageId}/keywords/${keyword.id}`, accessToken, { method: "POST", body: activateForm }),
      "启用关键词",
    );
  }

  keyword = await requireBoundCustomerKeyword(pageId, accessToken, keyword.id, payload.flowId, name, keywords, true);

  return {
    flow: { id: String(payload.flowId), name },
    keyword: { id: String(keyword.id), name, isActivated: true },
  };
}

async function getCustomerKeywords(pageId: string, accessToken: string): Promise<CustomerKeywordRule[]> {
  const pageSize = 100;
  const rules: CustomerKeywordRule[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (rules.length < total) {
    const result = await botcakeFetch(
      `/api/v1/pages/${pageId}/keywords?for_page=false&for_comment=false&page_size=${pageSize}&page=${page}`,
      accessToken,
    );
    recordKeywordDebug("list", {
      success: result?.success,
      page,
      count: Array.isArray(result?.keywords) ? result.keywords.length : -1,
      rules: Array.isArray(result?.keywords)
        ? result.keywords.map((item: any) => ({ id: item?.id, name: item?.name, flow_id: item?.flow_id, keyword_type: item?.keyword_type, is_activated: item?.is_activated }))
        : [],
    });
    assertSuccessfulKeywordResponse(result, "读取 Customer 关键词");
    if (!Array.isArray(result?.keywords)) {
      throw new Error(`Botcake 未返回可编辑的关键词列表：${JSON.stringify(result).slice(0, 400)}`);
    }
    const batch = result.keywords.flatMap((value: unknown) => {
      const rule = firstRecord(value) as CustomerKeywordRule | undefined;
      return rule?.id !== undefined && rule?.id !== null ? [rule] : [];
    });
    rules.push(...batch);
    total = finiteNumber(result.record_search_count ?? result.record_count) ?? rules.length;
    if (result.keywords.length < pageSize || !result.keywords.length) break;
    page += 1;
  }
  return rules;
}

async function createCustomerKeyword(pageId: string, accessToken: string, keywords: string[]): Promise<CustomerKeywordRule> {
  const changes = {
    // Type 2 is Botcake's “contains any keyword” condition. Type 7 means
    // “contains all keywords” and cannot be used for our OR-style templates.
    keyword_type: 2,
    content: keywordContent(keywords),
    // Botcake itself creates an unbound keyword with an empty name. add_flow
    // fills the displayed name from the selected Flow.
    name: "",
    coordinate: {
      coordinateX: Math.floor(Math.random() * 1000),
      coordinateY: Math.floor(Math.random() * 1000),
    },
    config: {
      add_actions: [],
      after_type: "immediately",
      after: 1,
    },
    is_activated: false,
    // Customer keywords created by Botcake omit `for_comment` entirely. The
    // API misleadingly returns success when it is sent as false, but that rule
    // is not published into the editable Customer list and add_flow becomes a
    // silent no-op. Keep the payload compatible with the official UI.
    for_page: false,
  };
  const form = new FormData();
  form.append("changes", JSON.stringify(changes));
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/keywords`, accessToken, { method: "POST", body: form });
  recordKeywordDebug("create", {
    success: result?.success,
    error_code: result?.error_code,
    message: result?.message,
    keyword: result?.keyword ? {
      id: result.keyword.id,
      name: result.keyword.name,
      flow_id: result.keyword.flow_id,
      keyword_type: result.keyword.keyword_type,
      content: result.keyword.content,
    } : undefined,
  });
  assertSuccessfulKeywordResponse(result, "创建关键词");
  const keyword = firstRecord(result?.keyword) as CustomerKeywordRule | undefined;
  if (!keyword?.id) throw new Error(`Botcake 未返回新关键词规则 ID：${JSON.stringify(result).slice(0, 400)}`);
  return { ...keyword, name: String(keyword.name ?? "") };
}

async function updateCustomerKeyword(
  pageId: string,
  accessToken: string,
  keywordId: string | number,
  keywords: string[],
): Promise<any> {
  const form = new FormData();
  form.append("keyword_id", String(keywordId));
  form.append("keyword_type", "2");
  form.append("content", JSON.stringify(keywordContent(keywords)));
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/keywords/${keywordId}/update`, accessToken, { method: "POST", body: form });
  recordKeywordDebug("update", { keywordId, success: result?.success, error_code: result?.error_code, message: result?.message });
  return result;
}

async function createNamedFlow(pageId: string, accessToken: string, name: string): Promise<string> {
  const changes = { name, contents: [], path: [], blocks: [] };
  const form = new FormData();
  form.append("changes", JSON.stringify(changes));
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/flow/create`, accessToken, { method: "POST", body: form });
  const id = result?.flow?.id ?? result?.flow_id ?? result?.id;
  if (id === undefined || id === null || id === "") throw new Error(`Botcake 未返回新 Flow ID：${JSON.stringify(result).slice(0, 400)}`);
  return String(id);
}

async function getNamedFlows(pageId: string, accessToken: string, name: string): Promise<FlowSummary[]> {
  const pageSize = 100;
  const flows: FlowSummary[] = [];
  let page = 1;
  while (true) {
    const form = new FormData();
    form.append("change", JSON.stringify({ path: null, isRemoved: false }));
    const result = await botcakeFetch(`/api/v1/pages/${pageId}/flow?page_size=${pageSize}&page=${page}`, accessToken, {
      method: "POST",
      body: form,
    });
    if (result?.success === false || !Array.isArray(result?.flows)) {
      throw new Error(`Botcake 未返回 Flow 列表：${JSON.stringify(result).slice(0, 400)}`);
    }
    const batch = result.flows.flatMap((value: unknown) => {
      const flow = firstRecord(value) as FlowSummary | undefined;
      return flow?.id !== undefined && flow?.id !== null ? [flow] : [];
    });
    flows.push(...batch);
    if (result.flows.length < pageSize || !result.flows.length) break;
    page += 1;
  }
  return flows.filter((flow) => String(flow.name ?? "").trim() === name);
}

async function bindKeywordFlow(pageId: string, accessToken: string, keywordId: string | number, flowId: string | number): Promise<void> {
  const form = new FormData();
  form.append("keyword_id", String(keywordId));
  form.append("flow_id", String(flowId));
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/keywords/add_flow`, accessToken, { method: "POST", body: form });
  recordKeywordDebug("bind", { keywordId, flowId, success: result?.success, error_code: result?.error_code, message: result?.message });
  assertSuccessfulKeywordResponse(result, "绑定关键词 Flow");
}

function recordKeywordDebug(stage: string, value: unknown): void {
  const target = window as typeof window & { __BFT_KEYWORD_DEBUG__?: Array<{ at: string; stage: string; value: unknown }> };
  const records = target.__BFT_KEYWORD_DEBUG__ ?? [];
  records.push({ at: new Date().toISOString(), stage, value });
  const recent = records.slice(-30);
  target.__BFT_KEYWORD_DEBUG__ = recent;
  // Content scripts and the page run in different JS worlds, but share the
  // document. Mirror only the sanitized diagnostics so browser-side testing
  // can inspect the real Botcake responses without exposing access tokens.
  document.documentElement.setAttribute("data-bft-keyword-debug", JSON.stringify(recent));
}

function keywordContent(keywords: string[]): Record<string, string[]> {
  return { is_content: keywords, not_content: [], contents: [], are_content: [], rates: [] };
}

function normalizeKeywordTerms(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

async function requireBoundCustomerKeyword(
  pageId: string,
  accessToken: string,
  keywordId: string | number,
  flowId: string | number,
  name: string,
  expectedKeywords?: string[],
  expectedActivated?: boolean,
): Promise<CustomerKeywordRule> {
  let found: CustomerKeywordRule | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rules = await getCustomerKeywords(pageId, accessToken);
    found = rules.find((item) => String(item.id) === String(keywordId))
      ?? rules.find((item) => String(item.flow_id ?? "") === String(flowId));
    if (found && String(found.flow_id ?? "") === String(flowId)) break;
    // The keyword list is eventually consistent after add_flow/activation.
    // Keep the retry bounded, but allow Botcake enough time to publish it.
    if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  if (!found) throw new Error(`Flow“${name}”已准备好，但 Botcake 未保存对应的关键词规则，请重试`);
  if (String(found.flow_id ?? "") !== String(flowId)) {
    throw new Error(`关键词规则“${name}”未绑定到目标 Flow，请重试`);
  }
  if (found.keyword_type !== undefined && Number(found.keyword_type) !== 2) {
    throw new Error(`关键词规则“${name}”不是“包含任一关键词”类型`);
  }
  if (expectedActivated === true && !booleanValue(found.is_activated)) {
    throw new Error(`关键词规则“${name}”已创建，但未成功启用`);
  }
  if (expectedKeywords?.length) {
    const actual = Array.isArray(found.content?.is_content)
      ? found.content.is_content.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (actual.length && !sameKeywordTerms(actual, expectedKeywords)) {
      throw new Error(`关键词规则“${name}”已创建，但关键词内容校验不一致`);
    }
  }
  return found;
}

function sameKeywordTerms(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function keywordTermsFromRule(rule: CustomerKeywordRule): string[] {
  return Array.isArray(rule.content?.is_content)
    ? rule.content.is_content.map((value) => String(value).trim()).filter(Boolean)
    : [];
}

function assertSuccessfulKeywordResponse(result: any, action: string): void {
  if (result?.success === false) throw new Error(`${action}失败：${JSON.stringify(result).slice(0, 400)}`);
}

function createPrivateReplySkeleton(name: string): Record<string, any> {
  return {
    key: randomBotcakeKey(),
    type: "private_replies",
    name,
    post_id: null,
    config: { add_actions: [] },
    blocks: [{
      title: "Private Replies",
      coordinate: { coordinateX: 891, coordinateY: 779 },
      key: randomBotcakeKey(),
      cards: [{
        key: randomBotcakeKey(),
        is_valid: false,
        plugin_id: "text",
        is_spin: false,
        messages: [""],
        config: { text: "", buttons: [] },
      }],
    }],
  };
}

function randomBotcakeKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (value) => (value % 36).toString(36)).join("");
}

function getCurrentSettings(): Record<string, any> {
  const settings = firstRecord(window.__NEXT_REDUX_STORE__?.getState?.()?.pages?.currentSettings);
  if (!settings) throw new Error("尚未读取到当前专页设置，请等待 Botcake 页面加载完成");
  return cloneSerializable(settings);
}

function commentAutomationFromSettings(settings: Record<string, any>): CommentAutomationSettings {
  return {
    autoReplyComment: booleanValue(settings.auto_reply_comment),
    autoInbox: booleanValue(settings.inbox_from_comment),
    prioritizePostSettings: booleanValue(settings.prioritize_auto_reply_with_setup_of_each_post),
    replyBasedOnSpecificPosts: booleanValue(settings.only_reply_post_config),
    onlyFirstCommentOnPage: booleanValue(settings.only_reply_first_comment),
    onlyFirstCommentOnEachPost: booleanValue(settings.inbox_first_comment_post),
    onlyFirstLevelComments: booleanValue(settings.only_track_first_level_comment),
    inboxCommentsFromGroupPosts: booleanValue(settings.auto_comment_in_group),
    autoLikeComments: booleanValue(settings.auto_like_comment),
    ignoreSeedingAccounts: booleanValue(settings.no_auto_inb_fr_cmt_seeding),
    replies: normalizeCommentReplies(arrayValue(settings.data_comments)),
  };
}

function normalizeCommentReplies(value: unknown[]): CommentReplyItem[] {
  return value.map((item, index) => {
    const record = firstRecord(item) ?? {};
    const text = String(record.text ?? "").trim();
    const commentLevel2 = String(record.commentLevel2 ?? "").trim();
    if (!text) throw new Error(`第 ${index + 1} 条评论回复为空`);
    return {
      text,
      images: arrayValue(record.images) as Record<string, unknown>[],
      ...(commentLevel2 ? { commentLevel2, imagesLv2: arrayValue(record.imagesLv2) as Record<string, unknown>[] } : {}),
    };
  });
}

async function saveSimplePageSetting(pageId: string, token: string, key: string, value: boolean): Promise<void> {
  const form = new FormData();
  form.append(`changes[${key}]`, String(value));
  await botcakeFetch(`/api/v1/pages/${pageId}/settings`, token, { method: "POST", body: form });
}

async function activateDefaultReply(): Promise<MainResponseMap["activateDefaultReply"]> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  // Botcake uses two independent page settings here. Keep the normal Default
  // mode selected before publishing so a failed second request never enables AI.
  await saveSimplePageSetting(pageId, accessToken, "is_using_ai_for_default_reply", false);
  await saveSimplePageSetting(pageId, accessToken, "is_published", true);
  return { enabled: true, usingAi: false };
}

async function saveCommentReplies(pageId: string, token: string, settings: Record<string, any>, replies: CommentReplyItem[]): Promise<void> {
  const changes = {
    keywords: settings.keywords ?? [],
    hide_comment_keyword: settings.hide_comment_keyword ?? [],
    time_ranges: readTimeRanges(settings),
    action_mention: settings.action_mention ?? null,
    data_comments: replies,
    data_has_phone: settings.data_has_phone ?? [],
    data_has_mentions: settings.data_has_mentions ?? [],
    data_phone_customer: settings.data_phone_customer ?? [],
    data_live_comment: settings.data_live_comment ?? [],
    cmt_add_actions: settings.cmt_add_actions ?? [],
    use_ai_for_default_cmt: Boolean(settings.use_ai_for_default_cmt),
    selected_agent_default_cmt: settings.selected_agent_default_cmt ?? null,
  };
  const form = new FormData();
  form.append("changes", JSON.stringify(changes));
  await botcakeFetch(`/api/v1/pages/${pageId}/settings/comment`, token, { method: "POST", body: form });
}

async function saveTargetCountryCodes(pageId: string, token: string, settings: Record<string, any>, countryCodes: string[]): Promise<void> {
  const form = new FormData();
  const webformSetting = { ...readWebformSetting(settings.webform_setting), country: countryCodes };
  form.append("changes", "general_webform");
  form.append("is_country_code", "true");
  form.append("is_admin", "false");
  form.append("is_add_actions", "false");
  form.append("is_webform", "false");
  form.append("webform_setting", JSON.stringify(webformSetting));
  await botcakeFetch(`/api/v1/pages/${pageId}/settings`, token, { method: "POST", body: form });
}

function readWebformSetting(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return cloneSerializable(value as Record<string, any>);
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch { /* ignore */ }
  }
  return {};
}

function readTargetCountryCodes(value: unknown): string[] {
  return uniqueStrings(arrayValue(readWebformSetting(value).country).map(String));
}

function readTimeRanges(settings: Record<string, any>): Array<{ begin_time: string; end_time: string }> {
  const ranges = arrayValue(settings.time_ranges);
  if (ranges.length) return ranges as Array<{ begin_time: string; end_time: string }>;
  return [{ begin_time: String(settings.begin_time ?? ""), end_time: String(settings.end_time ?? "") }];
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function uniqueStrings(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function booleanValue(value: unknown): boolean { return value === true || value === "true" || value === 1 || value === "1"; }

async function getPrivateRepliesWithRetry(pageId: string, token: string): Promise<unknown[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await botcakeFetch(`/api/v1/pages/${pageId}/settings/comment`, token);
      return findPrivateReplies(result);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

function inspectFlow(): FlowSnapshot {
  const runtime = readRuntime();
  const selectedPost = runtime.selectedPost;
  if (!selectedPost) throw new Error("尚未读取到当前 Flow，请等页面加载完成后重试");
  const defaultRoute = location.href.match(DEFAULT_REPLY_EDIT_URL_PATTERN);
  const identity = defaultRoute
    ? { pageId: defaultRoute[1], flowId: String(selectedPost.id ?? ""), kind: "defaultReply" as const }
    : getFlowIdentity();
  if (!identity.flowId) throw new Error("尚未读取到当前默认回复 ID，请等页面加载完成后重试");
  if (runtime.currentPageId && runtime.currentPageId !== identity.pageId) throw new Error("Botcake 仍在切换专页");
  const post = cloneSerializable(selectedPost);
  const name = String(selectedPost.name ?? selectedPost.title ?? document.title.replace(/\s*[-|].*$/, "") ?? "未命名 Flow");
  return {
    identity,
    name,
    post,
    selectedTab: runtime.selectedTab,
    isPreview: Boolean(selectedPost.is_preview ?? false),
    isPreviewPublished: Boolean(selectedPost.is_preview_published ?? false),
    botFields: cloneSerializable(runtime.botFields),
    tags: cloneSerializable(runtime.tags),
    capturedAt: new Date().toISOString(),
  };
}

async function saveFlow(payload: SaveFlowPayload): Promise<{ success: boolean; result?: unknown }> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const form = new FormData();
  form.append("post", JSON.stringify(payload.post));
  form.append("is_preview", String(payload.isPreview ?? false));
  form.append("name", payload.name);
  form.append("is_preview_published", String(payload.isPreviewPublished ?? false));
  form.append("selected_tab", String(payload.selectedTab ?? "content"));
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/save_contents`, accessToken, {
    method: "POST",
    body: form,
  });
  return { success: result?.success !== false, result };
}

async function getBotFields(): Promise<BotField[]> {
  return (await getAllBotFields()).filter((field) => !booleanValue(field.is_archive));
}

async function getTags(): Promise<BotcakeTag[]> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const json = await botcakeFetch(`/api/v1/pages/${pageId}/tags`, accessToken);
  const candidates = [json?.tags, json?.result, json?.data, json];
  const tags = candidates.find(Array.isArray) ?? [];
  return tags.flatMap((value: unknown) => {
    const tag = firstRecord(value);
    const id = tag?.id ?? tag?.tag_id;
    const name = tag?.name ?? tag?.label;
    if ((typeof id !== "string" && typeof id !== "number") || typeof name !== "string" || !name.trim()) return [];
    return [{ ...tag, id, name: name.trim() } as BotcakeTag];
  });
}

async function createTag(name: string): Promise<BotcakeTag> {
  const normalized = name.trim();
  if (!normalized) throw new Error("标签名称不能为空");
  if (normalized.length > 20) throw new Error(`标签“${normalized}”超过 Botcake 的 20 字符限制`);
  const existing = (await getTags()).find((tag) => tag.name.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase());
  if (existing) return existing;
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  let json: any;
  try {
    json = await botcakeFetch(`/api/v1/pages/${pageId}/tags`, accessToken, {
      method: "POST",
      body: buildCreateBotcakeTagForm(normalized),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`创建标签“${normalized}”失败：${message}`);
  }
  const direct = firstRecord(json?.tag) ?? firstRecord(json?.result) ?? firstRecord(json?.data) ?? firstRecord(json);
  const directId = direct?.id ?? direct?.tag_id;
  const directName = direct?.name ?? direct?.label;
  if ((typeof directId === "string" || typeof directId === "number") && typeof directName === "string") {
    return { ...direct, id: directId, name: directName.trim() } as BotcakeTag;
  }
  const created = (await getTags()).find((tag) => tag.name.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase());
  if (!created) throw new Error(`Botcake 已响应创建标签，但未能读取新标签“${normalized}”`);
  return created;
}

async function getAllBotFields(): Promise<BotField[]> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const json = await botcakeFetch(`/api/v1/pages/${pageId}/bot_field`, accessToken);
  const fields = Array.isArray(json?.result) ? json.result : Array.isArray(json) ? json : [];
  return fields as BotField[];
}

async function createBotField(name: string, type = "string", value?: unknown, description = ""): Promise<BotField> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const normalizedName = name.trim().toLocaleLowerCase();
  const sameName = (await getAllBotFields()).find((field) => field.name.trim().toLocaleLowerCase() === normalizedName);
  if (sameName) {
    if (booleanValue(sameName.is_archive)) {
      await restoreBotFields([sameName.id]);
      return { ...sameName, is_archive: false };
    }
    return sameName;
  }
  const field = {
    name,
    type,
    value: value ?? defaultBotFieldValue(type),
    description,
    folder_id: null,
  };
  const form = new FormData();
  form.append("field", JSON.stringify(field));
  form.append("path", location.pathname);
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/bot_field`, accessToken, {
    method: "POST",
    body: form,
  });
  const created = result?.result ?? result?.field ?? result;
  if (!created?.id) throw new Error(`机器人变量“${name}”创建失败：${JSON.stringify(result)}`);
  return created as BotField;
}

async function restoreBotFields(fieldIds: Array<string | number>): Promise<void> {
  if (!fieldIds.length) return;
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const form = new FormData();
  form.append("changes", JSON.stringify({ is_archive: false, field_ids: fieldIds }));
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/bot_field/archive`, accessToken, {
    method: "POST",
    body: form,
  });
  if (result?.success === false) throw new Error(`机器人变量取消归档失败：${JSON.stringify(result).slice(0, 400)}`);
}

async function uploadMedia(payload: MainRequestMap["uploadMedia"]): Promise<Record<string, unknown>> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const bytes = base64ToBytes(payload.base64);
  const file = new File([bytes.slice().buffer as ArrayBuffer], payload.name, { type: payload.mime });
  const form = new FormData();
  form.append("name", payload.name);
  form.append("file", file);
  form.append("upload_type", payload.kind);
  form.append("length", String(file.size));
  const result = await botcakeFetch(
    `/api/v1/pages/${pageId}/contents?is_reusable=true&upload_type=${payload.kind}`,
    accessToken,
    { method: "POST", body: form },
  );
  if (result?.success === false) throw new Error(`素材上传失败：${result?.message ?? "未知错误"}`);
  const root = objectValue(result?.result) ?? objectValue(result?.data) ?? objectValue(result) ?? {};
  const kindData = objectValue(root[`${payload.kind}_data`])
    ?? objectValue(result?.[`${payload.kind}_data`])
    ?? objectValue(result?.result?.[`${payload.kind}_data`])
    ?? objectValue(result?.data?.[`${payload.kind}_data`])
    ?? {};
  const media = { ...root, ...kindData };
  const contentUrl = media.content_url ?? media.url ?? result?.content_url ?? result?.url;
  const previewUrl = media.content_preview_url ?? media.preview_url ?? result?.content_preview_url ?? result?.preview_url ?? contentUrl;
  if (!contentUrl && !media.content_id && !media.fb_id) {
    throw new Error(`Botcake 素材上传成功但未返回素材信息：${JSON.stringify(result).slice(0, 600)}`);
  }
  return {
    ...result,
    ...media,
    content_url: contentUrl,
    url: contentUrl,
    preview_url: previewUrl,
    name: media.name ?? result?.name ?? payload.name,
    page_id: pageId,
  } as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

async function getPrivateReplies(): Promise<unknown[]> {
  const pageId = getCurrentPageId();
  const { accessToken } = readRuntime();
  const result = await botcakeFetch(`/api/v1/pages/${pageId}/settings/comment`, accessToken);
  return findPrivateReplies(result);
}

async function getCommentFlowStatus(): Promise<CommentFlowStatus> {
  const pageId = getCurrentPageId();
  const runtime = readRuntime();
  const state = window.__NEXT_REDUX_STORE__?.getState?.();
  const reduxReplies = Array.isArray(state?.cards?.privateReplies) ? state.cards.privateReplies : [];
  const reduxSettings = firstRecord(state?.pages?.currentSettings);
  if (reduxReplies.length) return commentFlowStatusFrom(pageId, reduxReplies, reduxSettings ?? {});

  const result = await botcakeFetch(`/api/v1/pages/${pageId}/settings/comment`, runtime.accessToken);
  const replies = findPrivateReplies(result);
  const settings = reduxSettings
    ?? firstRecord(result?.result)
    ?? firstRecord(result?.settings)
    ?? firstRecord(result)
    ?? {};
  return commentFlowStatusFrom(pageId, replies, settings);
}

function commentFlowStatusFrom(pageId: string, replies: unknown[], settings: Record<string, unknown>): CommentFlowStatus {
  const first = replies.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id) as Record<string, unknown> | undefined;
  return {
    pageId,
    flow: first ? { id: String(first.id), name: String(first.name ?? first.title ?? `Flow ${first.id}`) } : undefined,
    autoInbox: firstBoolean(settings, ["inbox_from_comment", "auto_inbox", "is_auto_inbox"]),
    autoReplyComment: firstBoolean(settings, ["auto_reply_comment", "is_auto_reply_comment"]),
  };
}

function findPrivateReplies(value: any): unknown[] {
  const candidates = [
    value?.private_replies,
    value?.privateReplies,
    value?.result?.private_replies,
    value?.result?.privateReplies,
    value?.settings?.private_replies,
    value?.settings?.privateReplies,
  ];
  return candidates.find(Array.isArray) ?? [];
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) if (typeof record[key] === "boolean") return record[key] as boolean;
  return undefined;
}

function getCurrentPageId(): string {
  const fromUrl = location.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
  if (!fromUrl) throw new Error("当前页面尚未选择 Botcake 专页");
  const runtimePageId = readRuntime().currentPageId;
  if (runtimePageId && runtimePageId !== fromUrl) throw new Error("Botcake 仍在切换专页");
  return fromUrl;
}

const ANALYTICS_PAGE_SIZE = 50;
const ANALYTICS_MAX_PAGES = 500;

async function getAnalyticsPages(): Promise<AnalyticsPage[]> {
  const pageMap = new Map<string, AnalyticsPage>();
  try {
    const token = readRuntime().accessToken;
    for (const path of ["/api/v1/pages", "/api/v1/users/pages_by_platform_on_pancake"] as const) {
      try {
        const raw = await botcakeFetch(path, token);
        const rows = extractRecordArray(raw, ["pages", "activated", "inactivated", "data", "items"]);
        for (const row of rows) {
          const page = toAnalyticsPage(row);
          if (page) pageMap.set(page.id, mergeAnalyticsPage(pageMap.get(page.id), page));
        }
        if (pageMap.size) break;
      } catch {
        // 继续使用下一接口或页面状态，避免单一接口变化使目录完全不可用。
      }
    }
  } catch {
    // 页面登录状态尚未准备好时仍可尝试 Redux / React 页面数据。
  }
  const roots: unknown[] = [];
  const reduxState = window.__NEXT_REDUX_STORE__?.getState?.();
  if (reduxState) roots.push(reduxState);
  const nextText = document.getElementById("__NEXT_DATA__")?.textContent;
  if (nextText) {
    try { roots.push(JSON.parse(nextText)); } catch { /* 页面数据尚未准备完成 */ }
  }
  roots.push(...collectReactRoots());

  const objects = collectObjects(roots, 8, 12_000);
  for (const object of objects) {
    for (const key of ["activated", "inactivated", "pages", "page_list", "pageList", "activated_pages"] as const) {
      const value = object[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const page = toAnalyticsPage(item);
        if (page) pageMap.set(page.id, mergeAnalyticsPage(pageMap.get(page.id), page));
      }
    }
  }

  for (const image of document.querySelectorAll<HTMLImageElement>("img[alt]")) {
    const alt = image.alt.trim();
    if (!alt) continue;
    const page = [...pageMap.values()].find((item) => item.name === alt);
    const source = image.currentSrc || image.src;
    if (page && /^https:\/\//.test(source) && !/logo/i.test(alt)) pageMap.set(page.id, { ...page, avatarUrl: source });
  }

  const currentId = location.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
  if (currentId && !pageMap.has(currentId)) {
    const heading = [...document.querySelectorAll("h1, h2, h3")].map((node) => node.textContent?.trim()).find(Boolean);
    pageMap.set(currentId, { id: currentId, name: heading && !/^(Home|Flow|Comments|Settings)$/i.test(heading) ? heading : `专页 ${currentId}` });
  }
  return [...pageMap.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function getTrafficDashboardData(payload: MainRequestMap["getTrafficDashboardData"]): Promise<TrafficDashboardData> {
  assertTimezone(payload.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(payload.endDate) || payload.startDate > payload.endDate) {
    throw new Error("统计日期范围不正确");
  }
  const directory = await getAnalyticsPages();
  const requested = new Set(payload.pageIds.filter(Boolean));
  const pages = (requested.size ? directory.filter((page) => requested.has(page.id)) : directory);
  if (!pages.length) throw new Error("没有找到可统计的 Botcake 专页");

  const today = dateInAnalyticsTimezone(Date.now(), payload.timezone);
  const yesterday = addAnalyticsDays(today, -1);
  const results = await mapWithConcurrency(pages, 3, (page) => fetchAnalyticsPage(page, payload, today, yesterday));
  return {
    timezone: payload.timezone,
    today,
    yesterday,
    startDate: payload.startDate,
    endDate: payload.endDate,
    pages: results.map((result) => result.traffic),
    logs: results.flatMap((result) => result.logs).sort((a, b) => parseAnalyticsTimestamp(b.updatedAt) - parseAnalyticsTimestamp(a.updatedAt)),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchAnalyticsPage(
  page: AnalyticsPage,
  payload: MainRequestMap["getTrafficDashboardData"],
  today: string,
  yesterday: string,
): Promise<{ traffic: AnalyticsPageTraffic; logs: AnalyticsLogEntry[] }> {
  const blank = (): AnalyticsPageTraffic => ({
    page,
    todayHours: Array(24).fill(0),
    yesterdayHours: Array(24).fill(0),
    daily: enumerateIsoDates(payload.startDate, payload.endDate).map((date) => ({ date, count: 0 })),
    todayTotal: 0,
    yesterdayTotal: 0,
    rangeTotal: 0,
    gender: { female: 0, male: 0, unknown: 0 },
  });
  const traffic = blank();
  let logs: AnalyticsLogEntry[] = [];
  const token = readRuntime().accessToken;
  try {
    const customers = await fetchAllAnalyticsCustomers(page, token);
    Object.assign(traffic, aggregateCustomerTraffic(customers, {
      timezone: payload.timezone,
      startDate: payload.startDate,
      endDate: payload.endDate,
      today,
      yesterday,
    }));
  } catch (error) {
    traffic.error = error instanceof Error ? error.message : String(error);
  }

  try {
    const raw = await botcakeFetch(`/api/v1/pages/${page.id}/logs`, token);
    const rows = extractRecordArray(raw, ["page_logs", "logs", "data"]).slice(0, 50);
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    logs = rows.map((row): AnalyticsLogEntry => ({
      page,
      id: typeof row.id === "string" || typeof row.id === "number" ? row.id : undefined,
      code: String(row.code ?? "-") ,
      subcode: String(row.subcode ?? "-") ,
      description: String(row.description ?? row.message ?? "未知错误"),
      count: Math.max(0, Number(row.count ?? 0) || 0),
      updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
    })).filter((entry) => {
      const timestamp = parseAnalyticsTimestamp(entry.updatedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  } catch {
    // 日志属于辅助信息；读取失败不影响核心引流统计。
  }
  return { traffic, logs };
}

async function fetchAllAnalyticsCustomers(page: AnalyticsPage, accessToken: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const apiPageId = analyticsApiPageId(page);
  let previousSignature = "";
  for (let pageNumber = 1; pageNumber <= ANALYTICS_MAX_PAGES; pageNumber += 1) {
    const raw = await botcakeFetch(`/api/v1/pages/${apiPageId}/customers?page_size=${ANALYTICS_PAGE_SIZE}&page=${pageNumber}`, accessToken);
    const batch = extractRecordArray(raw, ["customers", "data", "items"]);
    if (!batch.length) break;
    const signature = `${String(batch[0]?.id ?? batch[0]?.psid ?? "")}:${String(batch.at(-1)?.id ?? batch.at(-1)?.psid ?? "")}:${batch.length}`;
    if (signature === previousSignature) break;
    previousSignature = signature;
    rows.push(...batch);
    if (batch.length < ANALYTICS_PAGE_SIZE) break;
    if (pageNumber === ANALYTICS_MAX_PAGES) throw new Error(`专页“${page.name}”客户数据超过安全分页上限`);
  }
  return rows;
}

function toAnalyticsPage(value: unknown): AnalyticsPage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawId = record.page_id ?? record.pageId ?? record.id;
  const rawName = record.page_name ?? record.pageName ?? record.name ?? record.title;
  if ((typeof rawId !== "string" && typeof rawId !== "number") || typeof rawName !== "string") return undefined;
  const id = String(rawId).replace(/^igo_/, "");
  if (!/^\d{8,}$/.test(id) || !rawName.trim()) return undefined;
  const platform = typeof record.platform === "string" ? record.platform : typeof record.type === "string" ? record.type : undefined;
  const avatarUrl = findPageAvatar(record) ?? (/facebook/i.test(platform ?? "") ? `https://graph.facebook.com/${id}/picture?type=small` : undefined);
  return { id, name: rawName.trim(), avatarUrl, platform };
}

function mergeAnalyticsPage(current: AnalyticsPage | undefined, next: AnalyticsPage): AnalyticsPage {
  return current ? { ...current, ...next, avatarUrl: next.avatarUrl ?? current.avatarUrl, platform: next.platform ?? current.platform } : next;
}

function findPageAvatar(record: Record<string, unknown>): string | undefined {
  for (const key of ["avatar_url", "avatarUrl", "picture", "image_url", "image", "photo_url", "profile_picture_url"]) {
    const value = record[key];
    if (typeof value === "string" && /^https:\/\//.test(value)) return value;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      const url = nested.url ?? nested.src;
      if (typeof url === "string" && /^https:\/\//.test(url)) return url;
    }
  }
  for (const key of ["platform_extra_info", "platformExtraInfo", "extra_info"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const avatar = findPageAvatar(nested as Record<string, unknown>);
      if (avatar) return avatar;
    }
  }
  return undefined;
}

function analyticsApiPageId(page: AnalyticsPage): string {
  const platform = page.platform?.toLowerCase() ?? "";
  return /instagram|(^|\W)ig($|\W)/.test(platform) ? `igo_${page.id}` : page.id;
}

function extractRecordArray(value: unknown, preferredKeys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of preferredKeys) {
    const found = record[key];
    if (Array.isArray(found)) return extractRecordArray(found, preferredKeys);
    if (found && typeof found === "object") {
      const nested = extractRecordArray(found, preferredKeys);
      if (nested.length) return nested;
    }
  }
  return [];
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function botcakeFetch(path: string, accessToken: string, init: RequestInit = {}): Promise<any> {
  const url = new URL(path, location.origin);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error" });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) throw new Error(`Botcake 接口 ${response.status}：${redactCredential(typeof body === "string" ? body : JSON.stringify(body), accessToken)}`);
  return body;
}

function readRuntime(): RuntimeState {
  const reduxRuntime = readReduxRuntime();
  if (reduxRuntime) return reduxRuntime;

  const roots = collectReactRoots();
  const objects = collectObjects(roots, 5, 5000);
  const accessToken = findStringProperty(objects, ["accessToken", "access_token", "token"])
    ?? findNextDataToken()
    ?? findStoredAccessToken();
  if (!accessToken) throw new Error("无法取得 Botcake 登录令牌，请刷新页面后重试");

  const selectedPost = findSelectedPost(objects);
  const botFields = findArrayProperty(objects, "botFields")
    ?? findArrayProperty(objects, "bot_fields")
    ?? [];
  const tags = findArrayProperty(objects, "tags") ?? [];
  const selectedTabValue = findPrimitiveProperty(objects, ["selectedTab", "selected_tab", "selectedTabMenu"]);
  const selectedTab = typeof selectedTabValue === "string" || typeof selectedTabValue === "number"
    ? selectedTabValue
    : undefined;
  return { accessToken, selectedPost, botFields: botFields as BotField[], tags: tags as BotcakeTag[], selectedTab };
}

function readReduxRuntime(): RuntimeState | undefined {
  const state = window.__NEXT_REDUX_STORE__?.getState?.();
  if (!state) return undefined;
  const accessTokenValue = state.auth?.accessToken ?? state.auth?.access_token;
  if (typeof accessTokenValue !== "string" || accessTokenValue.length <= 10) return undefined;
  const selectedPost = isPost(state.cards?.selectedPost) ? state.cards.selectedPost : undefined;
  const fields = state.pages?.botFields ?? state.pages?.bot_fields;
  const tags = state.pages?.tags;
  const selectedTabValue = state.cards?.selectedTabMenu;
  const pageIdValue = state.pages?.currentPageId;
  return {
    accessToken: accessTokenValue,
    selectedPost,
    botFields: Array.isArray(fields) ? fields as BotField[] : [],
    tags: Array.isArray(tags) ? tags as BotcakeTag[] : [],
    selectedTab: typeof selectedTabValue === "string" || typeof selectedTabValue === "number" ? selectedTabValue : undefined,
    currentPageId: typeof pageIdValue === "string" || typeof pageIdValue === "number" ? String(pageIdValue) : undefined,
  };
}

function installRouteObserver(): void {
  if (window.__BOTCAKE_FLOW_TOOLKIT_ROUTE_OBSERVER__) return;
  window.__BOTCAKE_FLOW_TOOLKIT_ROUTE_OBSERVER__ = true;
  const notify = () => window.postMessage({ app: APP_ID, channel: "route", href: location.href }, location.origin);
  const historyMethods = history as unknown as Record<"pushState" | "replaceState", (...args: unknown[]) => unknown>;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = historyMethods[method].bind(history);
    historyMethods[method] = (...args: unknown[]) => {
      const result = original(...args);
      queueMicrotask(notify);
      return result;
    };
  }
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
}

function collectReactRoots(): unknown[] {
  const roots: unknown[] = [];
  const elements = document.querySelectorAll(".react-flow__node, .react-flow, #__next");
  for (const element of elements) {
    for (const key of Object.getOwnPropertyNames(element)) {
      if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactProps$") && !key.startsWith("__reactContainer$")) continue;
      let fiber = (element as unknown as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      let guard = 0;
      while (fiber && guard < 150) {
        roots.push(fiber.memoizedProps, fiber.pendingProps, fiber.memoizedState);
        fiber = fiber.return as Record<string, unknown> | undefined;
        guard += 1;
      }
    }
  }
  const nextData = document.getElementById("__NEXT_DATA__")?.textContent;
  if (nextData) {
    try { roots.push(JSON.parse(nextData)); } catch { /* ignore */ }
  }
  return roots.filter(Boolean);
}

function collectObjects(roots: unknown[], maxDepth: number, maxItems: number): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue = roots.map((value) => ({ value, depth: 0 }));
  while (queue.length && result.length < maxItems) {
    const item = queue.shift()!;
    if (!item.value || typeof item.value !== "object" || seen.has(item.value as object)) continue;
    if (item.value instanceof Element || item.value instanceof Window || item.value instanceof EventTarget) continue;
    seen.add(item.value as object);
    if (Array.isArray(item.value)) {
      if (item.depth < maxDepth) item.value.slice(0, 300).forEach((value) => queue.push({ value, depth: item.depth + 1 }));
      continue;
    }
    const record = item.value as Record<string, unknown>;
    result.push(record);
    if (item.depth >= maxDepth) continue;
    for (const value of Object.values(record).slice(0, 300)) queue.push({ value, depth: item.depth + 1 });
  }
  return result;
}

function findSelectedPost(objects: Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const object of objects) {
    const direct = object.selectedPost;
    if (isPost(direct)) return direct;
    if (isPost(object) && (object.id || object.key)) return object;
  }
  return undefined;
}

function isPost(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).blocks));
}

function findStringProperty(objects: Record<string, unknown>[], keys: string[]): string | undefined {
  const value = findPrimitiveProperty(objects, keys);
  return typeof value === "string" && value.length > 10 ? value : undefined;
}

function findPrimitiveProperty(objects: Record<string, unknown>[], keys: string[]): string | number | boolean | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (["string", "number", "boolean"].includes(typeof value)) return value as string | number | boolean;
    }
  }
  return undefined;
}

function findArrayProperty(objects: Record<string, unknown>[], key: string): unknown[] | undefined {
  for (const object of objects) if (Array.isArray(object[key])) return object[key] as unknown[];
  return undefined;
}

function findNextDataToken(): string | undefined {
  const text = document.getElementById("__NEXT_DATA__")?.textContent;
  if (!text) return undefined;
  const match = text.match(/"(?:accessToken|access_token)":"([^"]+)"/);
  return match?.[1];
}

function findStoredAccessToken(): string | undefined {
  const candidates = [
    localStorage.getItem("token_jwt"),
    localStorage.getItem("BOTCAKE_TOKEN"),
    localStorage.getItem("accessToken"),
    sessionStorage.getItem("token_jwt"),
    sessionStorage.getItem("BOTCAKE_TOKEN"),
    document.cookie.match(/(?:^|;\s*)token_jwt=([^;]+)/)?.[1],
  ];
  for (const candidate of candidates) {
    const token = normalizeStoredToken(candidate);
    if (token && token.length > 10) return token;
  }
  return undefined;
}

function normalizeStoredToken(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.trim();
  try { text = decodeURIComponent(text); } catch { /* 已解码 */ }
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const nested = parsed.token_jwt ?? parsed.accessToken ?? parsed.access_token ?? parsed.token;
      if (typeof nested === "string") text = nested.trim();
    } catch { /* 不是 JSON 存储值 */ }
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
  const token = text.replace(/^Bearer\s+/i, "").trim();
  return token || undefined;
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultBotFieldValue(type: string): unknown {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "date") return Math.floor(Date.now() / 1000);
  return " ";
}
