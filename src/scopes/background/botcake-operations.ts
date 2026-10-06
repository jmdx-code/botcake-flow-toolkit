import { buildCreateBotcakeTagForm } from "../../core/botcake-tags";
import { isSameBotcakeTimezone, toBotcakeTimezoneValue } from "../../core/botcake-timezone";
import { runWithTokenFallback } from "../../core/analytics-token-management";
import { base64ToBytes } from "../../shared/utils";
import type {
  BotField,
  BotFieldSpec,
  BotcakeFlowApplyTarget,
  BotcakeTag,
  CommentAutomationSettings,
  CommentReplyItem,
  CompleteBotcakeFlowPayload,
  EnsureBotFieldsResult,
  FinalizeKeywordFlowResult,
  FlowSnapshot,
  MediaKind,
  PageAutomationState,
  PreparedBotcakeFlow,
  SaveFlowPayload,
  UpdatePageAutomationPayload,
  UpdatePageAutomationResult,
} from "../../shared/types";
import { readAnalyticsExternalTokenCandidates } from "./analytics-token-vault";
import { redactCredential } from "../../core/security-errors";

const BOTCAKE_ORIGIN = "https://botcake.io";

type TokenProvider = (forceRefresh?: boolean) => Promise<string>;
type CustomerKeywordRule = {
  id: string | number;
  name?: string;
  flow_id?: string | number | null;
  is_activated?: boolean;
  keyword_type?: number;
  content?: Record<string, unknown>;
};

const COMMENT_SETTING_KEYS = {
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

export class BotcakeOperationsService {
  constructor(private readonly getPrimaryToken: TokenProvider) {}

  getPageState(pageId: string): Promise<PageAutomationState> {
    return this.withPageToken(pageId, (token) => this.getPageStateWithToken(pageId, token));
  }

  updatePageAutomation(pageId: string, payload: UpdatePageAutomationPayload): Promise<UpdatePageAutomationResult> {
    return this.withPageToken(pageId, (token) => this.updatePageAutomationWithToken(pageId, token, payload));
  }

  ensureBotFields(pageId: string, specs: BotFieldSpec[]): Promise<EnsureBotFieldsResult> {
    return this.withPageToken(pageId, (token) => this.ensureBotFieldsWithToken(pageId, token, specs));
  }

  getBotFields(pageId: string): Promise<BotField[]> {
    return this.withPageToken(pageId, (token) => this.getBotFieldsWithToken(pageId, token));
  }

  createBotField(pageId: string, spec: BotFieldSpec): Promise<BotField> {
    return this.withPageToken(pageId, (token) => this.createBotFieldWithToken(pageId, token, spec));
  }

  getTags(pageId: string): Promise<BotcakeTag[]> {
    return this.withPageToken(pageId, (token) => this.getTagsWithToken(pageId, token));
  }

  createTag(pageId: string, name: string): Promise<BotcakeTag> {
    return this.withPageToken(pageId, (token) => this.createTagWithToken(pageId, token, name));
  }

  uploadMedia(pageId: string, media: { kind: MediaKind; name: string; mime: string; base64: string }): Promise<Record<string, unknown>> {
    return this.withPageToken(pageId, (token) => this.uploadMediaWithToken(pageId, token, media));
  }

  prepareFlow(pageId: string, target: BotcakeFlowApplyTarget, name: string, keywords: string[] = [], enableAutoInbox = true): Promise<PreparedBotcakeFlow> {
    return this.withPageToken(pageId, (token) => this.prepareFlowWithToken(pageId, token, target, name, keywords, enableAutoInbox));
  }

  saveFlow(pageId: string, payload: SaveFlowPayload): Promise<{ success: boolean; result?: unknown }> {
    return this.withPageToken(pageId, (token) => this.saveFlowWithToken(pageId, token, payload));
  }

  completeFlow(pageId: string, payload: CompleteBotcakeFlowPayload): Promise<{ success: true; keyword?: FinalizeKeywordFlowResult }> {
    return this.withPageToken(pageId, (token) => this.completeFlowWithToken(pageId, token, payload));
  }

  private async withPageToken<T>(pageId: string, task: (token: string) => Promise<T>): Promise<T> {
    assertPageId(pageId);
    const external = await readAnalyticsExternalTokenCandidates();
    const candidates = [...(external[pageId] ?? [])];
    try {
      const primary = await this.getPrimaryToken(false);
      if (primary && !candidates.includes(primary)) candidates.push(primary);
    } catch { /* 已保存的专页 Token 足以执行时，不要求打开 Botcake */ }
    return runWithTokenFallback(candidates, task, isTokenAccessError);
  }

  private async getPageStateWithToken(pageId: string, token: string): Promise<PageAutomationState> {
    const [settingsResult, commentResult, defaultResult, welcomeResult, botFields] = await Promise.all([
      this.request(pageId, token, "/settings"),
      this.request(pageId, token, "/settings/comment"),
      this.request(pageId, token, "/get_contents?type=default"),
      this.request(pageId, token, "/get_contents?type=welcome"),
      this.getBotFieldsWithToken(pageId, token),
    ]);
    const settings = objectValue(settingsResult?.settings) ?? objectValue(settingsResult?.result) ?? {};
    const commentFlow = firstRecord(findPrivateReplies(commentResult)[0]);
    const defaultFlow = flowFromGetContents(defaultResult);
    const welcomeFlow = flowFromGetContents(welcomeResult);
    return {
      pageId,
      timezone: finiteNumber(settings.time_zone),
      targetCountryCodes: readTargetCountryCodes(settings.webform_setting),
      comment: commentAutomationFromSettings(settings),
      ...(commentFlow?.id ? { defaultPrivateReply: flowSummary(commentFlow) } : {}),
      ...(defaultFlow?.id ? { defaultReply: flowSummary(defaultFlow) } : {}),
      welcome: {
        enabled: booleanValue(settings.is_started),
        ...(welcomeFlow?.id ? { flow: flowSummary(welcomeFlow) } : {}),
      },
      botFields,
    };
  }

  private async updatePageAutomationWithToken(pageId: string, token: string, payload: UpdatePageAutomationPayload): Promise<UpdatePageAutomationResult> {
    const settingsResult = await this.request(pageId, token, "/settings");
    const settings = clone(objectValue(settingsResult?.settings) ?? objectValue(settingsResult?.result) ?? {});
    const changed: string[] = [];
    if (payload.timezone !== undefined && !isSameBotcakeTimezone(settings.time_zone, payload.timezone)) {
      const form = new FormData();
      form.append("timezone", toBotcakeTimezoneValue(payload.timezone));
      assertSuccess(await this.request(pageId, token, "/change_timezone", { method: "POST", body: form }), "更新时区");
      settings.time_zone = toBotcakeTimezoneValue(payload.timezone);
      changed.push("timezone");
    }
    if (payload.targetCountryCodes) {
      const codes = uniqueStrings(payload.targetCountryCodes);
      if (!codes.length) throw new Error("目标地区至少保留一个国家/地区");
      if (JSON.stringify(codes) !== JSON.stringify(readTargetCountryCodes(settings.webform_setting))) {
        const form = new FormData();
        form.append("changes", "general_webform");
        form.append("is_country_code", "true");
        form.append("is_admin", "false");
        form.append("is_add_actions", "false");
        form.append("is_webform", "false");
        form.append("webform_setting", JSON.stringify({ ...readWebformSetting(settings.webform_setting), country: codes }));
        assertSuccess(await this.request(pageId, token, "/settings", { method: "POST", body: form }), "更新目标地区");
        settings.webform_setting = { ...readWebformSetting(settings.webform_setting), country: codes };
        changed.push("targetCountryCodes");
      }
    }
    if (payload.comment) {
      if (payload.comment.onlyFirstCommentOnPage === true && payload.comment.onlyFirstCommentOnEachPost === true) {
        throw new Error("“专页首次评论”和“每篇帖子首次评论”不能同时开启");
      }
      for (const [uiKey, apiKey] of Object.entries(COMMENT_SETTING_KEYS) as Array<[keyof typeof COMMENT_SETTING_KEYS, string]>) {
        const value = payload.comment[uiKey];
        if (typeof value !== "boolean" || booleanValue(settings[apiKey]) === value) continue;
        if (uiKey === "onlyFirstCommentOnPage" && value && booleanValue(settings.inbox_first_comment_post)) {
          await this.saveSimpleSetting(pageId, token, "inbox_first_comment_post", false);
          settings.inbox_first_comment_post = false;
          changed.push("comment.onlyFirstCommentOnEachPost");
        }
        if (uiKey === "onlyFirstCommentOnEachPost" && value && booleanValue(settings.only_reply_first_comment)) {
          await this.saveSimpleSetting(pageId, token, "only_reply_first_comment", false);
          settings.only_reply_first_comment = false;
          changed.push("comment.onlyFirstCommentOnPage");
        }
        await this.saveSimpleSetting(pageId, token, apiKey, value);
        settings[apiKey] = value;
        changed.push(`comment.${uiKey}`);
      }
      if (payload.comment.replies) {
        const replies = normalizeCommentReplies(payload.comment.replies);
        if (JSON.stringify(replies) !== JSON.stringify(normalizeCommentReplies(arrayValue(settings.data_comments)))) {
          const changes = {
            keywords: settings.keywords ?? [], hide_comment_keyword: settings.hide_comment_keyword ?? [],
            time_ranges: readTimeRanges(settings), action_mention: settings.action_mention ?? null,
            data_comments: replies, data_has_phone: settings.data_has_phone ?? [], data_has_mentions: settings.data_has_mentions ?? [],
            data_phone_customer: settings.data_phone_customer ?? [], data_live_comment: settings.data_live_comment ?? [],
            cmt_add_actions: settings.cmt_add_actions ?? [], use_ai_for_default_cmt: Boolean(settings.use_ai_for_default_cmt),
            selected_agent_default_cmt: settings.selected_agent_default_cmt ?? null,
          };
          const form = new FormData(); form.append("changes", JSON.stringify(changes));
          assertSuccess(await this.request(pageId, token, "/settings/comment", { method: "POST", body: form }), "更新评论回复");
          settings.data_comments = replies;
          changed.push("comment.replies");
        }
      }
    }
    return { changed, state: await this.getPageStateWithToken(pageId, token) };
  }

  private async ensureBotFieldsWithToken(pageId: string, token: string, specs: BotFieldSpec[]): Promise<EnsureBotFieldsResult> {
    const all = await this.getAllBotFieldsWithToken(pageId, token);
    const active = new Map(all.filter((x) => !booleanValue(x.is_archive)).map((x) => [x.name.trim().toLowerCase(), x]));
    const archived = new Map(all.filter((x) => booleanValue(x.is_archive)).map((x) => [x.name.trim().toLowerCase(), x]));
    const result: EnsureBotFieldsResult = { created: [], existing: [], restored: [] };
    for (const spec of specs) {
      const key = spec.name.trim().toLowerCase();
      if (!key) throw new Error("机器人变量名称不能为空");
      const found = active.get(key);
      if (found) { result.existing.push(found); continue; }
      const old = archived.get(key);
      if (old) {
        const form = new FormData(); form.append("changes", JSON.stringify({ is_archive: false, field_ids: [old.id] }));
        assertSuccess(await this.request(pageId, token, "/bot_field/archive", { method: "POST", body: form }), "恢复机器人变量");
        const restored = { ...old, is_archive: false };
        active.set(key, restored); result.restored.push(restored); continue;
      }
      const created = await this.createBotFieldWithToken(pageId, token, spec);
      active.set(key, created); result.created.push(created);
    }
    return result;
  }

  private async getAllBotFieldsWithToken(pageId: string, token: string): Promise<BotField[]> {
    const json = await this.request(pageId, token, "/bot_field");
    return (Array.isArray(json?.result) ? json.result : Array.isArray(json) ? json : []) as BotField[];
  }

  private async getBotFieldsWithToken(pageId: string, token: string): Promise<BotField[]> {
    return (await this.getAllBotFieldsWithToken(pageId, token)).filter((field) => !booleanValue(field.is_archive));
  }

  private async createBotFieldWithToken(pageId: string, token: string, spec: BotFieldSpec): Promise<BotField> {
    const same = (await this.getAllBotFieldsWithToken(pageId, token)).find((x) => x.name.trim().toLowerCase() === spec.name.trim().toLowerCase());
    if (same) {
      if (booleanValue(same.is_archive)) {
        const form = new FormData(); form.append("changes", JSON.stringify({ is_archive: false, field_ids: [same.id] }));
        assertSuccess(await this.request(pageId, token, "/bot_field/archive", { method: "POST", body: form }), "恢复机器人变量");
        return { ...same, is_archive: false };
      }
      return same;
    }
    const form = new FormData();
    form.append("field", JSON.stringify({ name: spec.name, type: spec.type ?? "string", value: spec.value ?? defaultBotFieldValue(spec.type ?? "string"), description: spec.description ?? "", folder_id: null }));
    form.append("path", `/${pageId}/home`);
    const json = await this.request(pageId, token, "/bot_field", { method: "POST", body: form });
    const created = json?.result ?? json?.field ?? json;
    if (!created?.id) throw new Error(`机器人变量“${spec.name}”创建失败：${summarize(json)}`);
    return created as BotField;
  }

  private async getTagsWithToken(pageId: string, token: string): Promise<BotcakeTag[]> {
    const json = await this.request(pageId, token, "/tags");
    const source = [json?.tags, json?.result, json?.data, json].find(Array.isArray) ?? [];
    return source.flatMap((value: unknown) => {
      const tag = firstRecord(value); const id = tag?.id ?? tag?.tag_id; const name = tag?.name ?? tag?.label;
      return (typeof id === "string" || typeof id === "number") && typeof name === "string" && name.trim()
        ? [{ ...tag, id, name: name.trim() } as BotcakeTag] : [];
    });
  }

  private async createTagWithToken(pageId: string, token: string, name: string): Promise<BotcakeTag> {
    const normalized = name.trim();
    if (!normalized) throw new Error("标签名称不能为空");
    if (normalized.length > 20) throw new Error(`标签“${normalized}”超过 Botcake 的 20 字符限制`);
    const existing = (await this.getTagsWithToken(pageId, token)).find((x) => x.name.trim().toLowerCase() === normalized.toLowerCase());
    if (existing) return existing;
    const json = await this.request(pageId, token, "/tags", { method: "POST", body: buildCreateBotcakeTagForm(normalized) });
    const direct = firstRecord(json?.tag) ?? firstRecord(json?.result) ?? firstRecord(json?.data) ?? firstRecord(json);
    const id = direct?.id ?? direct?.tag_id; const label = direct?.name ?? direct?.label;
    if ((typeof id === "string" || typeof id === "number") && typeof label === "string") return { ...direct, id, name: label.trim() } as BotcakeTag;
    const created = (await this.getTagsWithToken(pageId, token)).find((x) => x.name.trim().toLowerCase() === normalized.toLowerCase());
    if (!created) throw new Error(`Botcake 已响应创建标签，但未能读取新标签“${normalized}”`);
    return created;
  }

  private async uploadMediaWithToken(pageId: string, token: string, media: { kind: MediaKind; name: string; mime: string; base64: string }): Promise<Record<string, unknown>> {
    const bytes = base64ToBytes(media.base64);
    const file = new Blob([bytes.slice().buffer as ArrayBuffer], { type: media.mime });
    const form = new FormData(); form.append("name", media.name); form.append("file", file, media.name); form.append("upload_type", media.kind); form.append("length", String(file.size));
    const json = await this.request(pageId, token, `/contents?is_reusable=true&upload_type=${media.kind}`, { method: "POST", body: form });
    assertSuccess(json, "上传素材");
    const root = objectValue(json?.result) ?? objectValue(json?.data) ?? objectValue(json) ?? {};
    const kindData = objectValue(root[`${media.kind}_data`]) ?? objectValue(json?.[`${media.kind}_data`]) ?? {};
    const value = { ...root, ...kindData };
    const contentUrl = value.content_url ?? value.url ?? json?.content_url ?? json?.url;
    const previewUrl = value.content_preview_url ?? value.preview_url ?? json?.content_preview_url ?? json?.preview_url ?? contentUrl;
    if (!contentUrl && !value.content_id && !value.fb_id) throw new Error(`素材上传成功但未返回素材信息：${summarize(json)}`);
    return { ...json, ...value, content_url: contentUrl, url: contentUrl, preview_url: previewUrl, name: value.name ?? media.name, page_id: pageId };
  }

  private async prepareFlowWithToken(pageId: string, token: string, target: BotcakeFlowApplyTarget, rawName: string, rawKeywords: string[], enableAutoInbox: boolean): Promise<PreparedBotcakeFlow> {
    const name = rawName.trim() || (target === "defaultReply" ? "默认回复" : "评论");
    if (target === "comment") {
      const settingsResult = await this.request(pageId, token, "/settings");
      const settings = objectValue(settingsResult?.settings) ?? {};
      let flow = firstRecord(findPrivateReplies(await this.request(pageId, token, "/settings/comment"))[0]);
      let createdFlow = false;
      if (!flow?.id) {
        const skeleton = createPrivateReplySkeleton(name);
        let id: unknown;
        try {
          const createForm = new FormData(); createForm.append("post", JSON.stringify(skeleton));
          const created = await this.request(pageId, token, "/create_private_reply?for_case=1", { method: "POST", body: createForm });
          id = created?.reply_id ?? created?.id;
          if (id === undefined || id === null || id === "") throw new Error(`Botcake 未返回新评论流程 ID：${summarize(created)}`);
          skeleton.id = numericOrString(id);
          const saved = await this.saveFlowWithToken(pageId, token, { name, post: skeleton, selectedTab: "content" });
          if (!saved.success) throw new Error(`Botcake 保存新评论流程失败：${summarize(saved.result)}`);
          flow = skeleton; createdFlow = true;
        } catch (error) {
          if (id !== undefined && id !== null && id !== "") {
            try { await this.request(pageId, token, "/private_replies?for_case=1", { method: "DELETE" }); } catch { /* best effort */ }
          }
          throw error;
        }
      }
      if (enableAutoInbox && !booleanValue(settings.inbox_from_comment)) await this.saveSimpleSetting(pageId, token, "inbox_from_comment", true);
      return { target, snapshot: flowSnapshot(pageId, flow, "flow"), createdFlow };
    }
    if (target === "defaultReply") {
      let flow = flowFromGetContents(await this.request(pageId, token, "/get_contents?type=default"));
      let createdFlow = false;
      if (!flow?.id) {
        const skeleton = createPrivateReplySkeleton(name);
        const form = new FormData(); form.append("post", JSON.stringify({ blocks: skeleton.blocks, drafts: { blocks: clone(skeleton.blocks) }, config: {}, name })); form.append("type", "default");
        const created = await this.request(pageId, token, "/create_contents", { method: "POST", body: form });
        flow = flowFromGetContents(await this.request(pageId, token, "/get_contents?type=default"));
        if (!flow?.id) throw new Error(`Botcake 未返回新默认回复 ID：${summarize(created)}`);
        createdFlow = true;
      }
      return { target, snapshot: flowSnapshot(pageId, flow, "defaultReply"), createdFlow };
    }
    const terms = uniqueStrings(rawKeywords);
    if (!terms.length) throw new Error("关键词模板第三列至少需要一个关键词");
    const rules = await this.getCustomerKeywords(pageId, token);
    const matches = rules.filter((x) => String(x.name ?? "").trim() === name);
    if (matches.length > 1) throw new Error(`找到 ${matches.length} 条同名关键词规则“${name}”`);
    let keyword = matches[0]; let createdKeyword = false;
    if (!keyword) { keyword = await this.createCustomerKeyword(pageId, token, terms); createdKeyword = true; }
    let flowId = keyword.flow_id ? String(keyword.flow_id) : ""; let createdFlow = false;
    if (!flowId) {
      const named = await this.getNamedFlows(pageId, token, name);
      if (named.length > 1) throw new Error(`找到 ${named.length} 个同名 Flow“${name}”`);
      if (named[0]) flowId = String(named[0].id);
      else { flowId = await this.createNamedFlow(pageId, token, name); createdFlow = true; }
    }
    return {
      target,
      snapshot: flowSnapshot(pageId, { id: numericOrString(flowId), name, blocks: [] }, "flow"),
      createdFlow,
      keyword: { id: String(keyword.id), name, terms, created: createdKeyword },
    };
  }

  private async saveFlowWithToken(pageId: string, token: string, payload: SaveFlowPayload): Promise<{ success: boolean; result?: unknown }> {
    const form = new FormData(); form.append("post", JSON.stringify(payload.post)); form.append("is_preview", String(payload.isPreview ?? false));
    form.append("name", payload.name); form.append("is_preview_published", String(payload.isPreviewPublished ?? false)); form.append("selected_tab", String(payload.selectedTab ?? "content"));
    const result = await this.request(pageId, token, "/save_contents", { method: "POST", body: form });
    return { success: result?.success !== false, result };
  }

  private async completeFlowWithToken(pageId: string, token: string, payload: CompleteBotcakeFlowPayload): Promise<{ success: true; keyword?: FinalizeKeywordFlowResult }> {
    if (payload.target === "defaultReply") {
      await this.saveSimpleSetting(pageId, token, "is_using_ai_for_default_reply", false);
      await this.saveSimpleSetting(pageId, token, "is_published", true);
    }
    if (payload.target === "comment" && payload.applyWelcome) {
      const form = new FormData(); form.append("type", "welcomes"); form.append("flow_id", payload.flowId);
      await this.request(pageId, token, "/replace", { method: "POST", body: form });
      await this.saveSimpleSetting(pageId, token, "is_started", true);
    }
    if (payload.target === "keyword") {
      if (!payload.keyword) throw new Error("关键词应用任务缺少规则信息");
      const rules = await this.getCustomerKeywords(pageId, token);
      let keyword = rules.find((x) => String(x.id) === payload.keyword!.id) ?? rules.find((x) => String(x.name ?? "").trim() === payload.keyword!.name);
      if (!keyword) keyword = await this.createCustomerKeyword(pageId, token, payload.keyword.terms);
      else if (keyword.flow_id || !sameTerms(keywordTerms(keyword), payload.keyword.terms)) await this.updateCustomerKeyword(pageId, token, keyword.id, payload.keyword.terms);
      const bind = new FormData(); bind.append("keyword_id", String(keyword.id)); bind.append("flow_id", payload.flowId);
      assertSuccess(await this.request(pageId, token, "/keywords/add_flow", { method: "POST", body: bind }), "绑定关键词 Flow");
      if (!booleanValue(keyword.is_activated)) {
        const activate = new FormData(); activate.append("keyword_id", String(keyword.id)); activate.append("is_activated", "false");
        assertSuccess(await this.request(pageId, token, `/keywords/${keyword.id}`, { method: "POST", body: activate }), "启用关键词");
      }
      keyword = await this.requireBoundCustomerKeyword(
        pageId,
        token,
        keyword.id,
        payload.flowId,
        payload.keyword.name,
        payload.keyword.terms,
      );
      return { success: true, keyword: { flow: { id: payload.flowId, name: payload.keyword.name }, keyword: { id: String(keyword.id), name: payload.keyword.name, isActivated: true } } };
    }
    return { success: true };
  }

  private async getCustomerKeywords(pageId: string, token: string): Promise<CustomerKeywordRule[]> {
    const result: CustomerKeywordRule[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const json = await this.request(pageId, token, `/keywords?for_page=false&for_comment=false&page_size=100&page=${page}`);
      assertSuccess(json, "读取 Customer 关键词");
      if (!Array.isArray(json?.keywords)) throw new Error("Botcake 未返回可编辑的关键词列表");
      result.push(...json.keywords.filter((x: unknown) => Boolean(firstRecord(x)?.id)));
      if (json.keywords.length < 100) break;
    }
    return result;
  }

  private async createCustomerKeyword(pageId: string, token: string, terms: string[]): Promise<CustomerKeywordRule> {
    const form = new FormData();
    form.append("changes", JSON.stringify({ keyword_type: 2, content: keywordContent(terms), name: "", coordinate: { coordinateX: Math.floor(Math.random() * 1000), coordinateY: Math.floor(Math.random() * 1000) }, config: { add_actions: [], after_type: "immediately", after: 1 }, is_activated: false, for_page: false }));
    const json = await this.request(pageId, token, "/keywords", { method: "POST", body: form });
    assertSuccess(json, "创建关键词");
    const keyword = firstRecord(json?.keyword) as CustomerKeywordRule | undefined;
    if (!keyword?.id) throw new Error(`Botcake 未返回新关键词规则 ID：${summarize(json)}`);
    return keyword;
  }

  private async updateCustomerKeyword(pageId: string, token: string, id: string | number, terms: string[]): Promise<void> {
    const form = new FormData(); form.append("keyword_id", String(id)); form.append("keyword_type", "2"); form.append("content", JSON.stringify(keywordContent(terms)));
    assertSuccess(await this.request(pageId, token, `/keywords/${id}/update`, { method: "POST", body: form }), "更新关键词");
  }

  private async requireBoundCustomerKeyword(
    pageId: string,
    token: string,
    keywordId: string | number,
    flowId: string,
    name: string,
    expectedTerms: string[],
  ): Promise<CustomerKeywordRule> {
    let found: CustomerKeywordRule | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rules = await this.getCustomerKeywords(pageId, token);
      found = rules.find((item) => String(item.id) === String(keywordId))
        ?? rules.find((item) => String(item.flow_id ?? "") === flowId);
      if (found && String(found.flow_id ?? "") === flowId && booleanValue(found.is_activated)) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!found) throw new Error(`Flow“${name}”已保存，但 Botcake 未保存对应的关键词规则，请重试`);
    if (String(found.flow_id ?? "") !== flowId) throw new Error(`关键词规则“${name}”未绑定到目标 Flow，请重试`);
    if (found.keyword_type !== undefined && Number(found.keyword_type) !== 2) throw new Error(`关键词规则“${name}”不是“包含任一关键词”类型`);
    if (!booleanValue(found.is_activated)) throw new Error(`关键词规则“${name}”已创建，但未成功启用`);
    const actualTerms = keywordTerms(found);
    if (actualTerms.length && !sameTerms(actualTerms, expectedTerms)) throw new Error(`关键词规则“${name}”已创建，但关键词内容校验不一致`);
    return found;
  }

  private async getNamedFlows(pageId: string, token: string, name: string): Promise<Array<{ id: string | number; name?: string }>> {
    const flows: Array<{ id: string | number; name?: string }> = [];
    for (let page = 1; page <= 20; page += 1) {
      const form = new FormData(); form.append("change", JSON.stringify({ path: null, isRemoved: false }));
      const json = await this.request(pageId, token, `/flow?page_size=100&page=${page}`, { method: "POST", body: form });
      if (!Array.isArray(json?.flows)) throw new Error("Botcake 未返回 Flow 列表");
      flows.push(...json.flows.filter((x: unknown) => Boolean(firstRecord(x)?.id)));
      if (json.flows.length < 100) break;
    }
    return flows.filter((x) => String(x.name ?? "").trim() === name);
  }

  private async createNamedFlow(pageId: string, token: string, name: string): Promise<string> {
    const form = new FormData(); form.append("changes", JSON.stringify({ name, contents: [], path: [], blocks: [] }));
    const json = await this.request(pageId, token, "/flow/create", { method: "POST", body: form });
    const id = json?.flow?.id ?? json?.flow_id ?? json?.id;
    if (id === undefined || id === null || id === "") throw new Error(`Botcake 未返回新 Flow ID：${summarize(json)}`);
    return String(id);
  }

  private async saveSimpleSetting(pageId: string, token: string, key: string, value: boolean): Promise<void> {
    const form = new FormData(); form.append(`changes[${key}]`, String(value));
    assertSuccess(await this.request(pageId, token, "/settings", { method: "POST", body: form }), `更新专页设置 ${key}`);
  }

  private async request(pageId: string, token: string, path: string, init: RequestInit = {}): Promise<any> {
    const url = new URL(`/api/v1/pages/${pageId}${path}`, BOTCAKE_ORIGIN);
    url.searchParams.set("access_token", token);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, { ...init, credentials: "omit", cache: "no-store", redirect: "error" });
        const text = await response.text(); let body: any;
        try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
        if (!response.ok) throw new BotcakeOperationError(response.status, redactCredential(typeof body === "string" ? body : JSON.stringify(body), token));
        return body;
      } catch (error) {
        lastError = error;
        if (error instanceof BotcakeOperationError && ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        const isRead = !init.method || init.method.toUpperCase() === "GET";
        if (attempt === 0 && isRead) await new Promise((resolve) => setTimeout(resolve, 350));
        else throw error;
      }
    }
    throw lastError;
  }
}

class BotcakeOperationError extends Error {
  constructor(readonly status: number, detail: string) { super(`Botcake 接口 ${status}：${detail}`); }
}

function isTokenAccessError(reason: unknown): boolean {
  if (reason instanceof BotcakeOperationError && [401, 403].includes(reason.status)) return true;
  return /token|无权限|权限不足|unauthori[sz]ed|forbidden/i.test(reason instanceof Error ? reason.message : String(reason));
}

function assertPageId(pageId: string): void { if (!/^\d{8,}$/.test(pageId)) throw new Error("专页 ID 格式无效"); }
function objectValue(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function firstRecord(value: unknown): Record<string, any> | undefined { return objectValue(value); }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function clone<T>(value: T): T { return structuredClone(value); }
function booleanValue(value: unknown): boolean { return value === true || value === "true" || value === 1 || value === "1"; }
function finiteNumber(value: unknown): number | undefined { const number = Number(value); return value === "" || value == null || !Number.isFinite(number) ? undefined : number; }
function uniqueStrings(values: string[]): string[] { return [...new Set(values.map((x) => String(x).trim()).filter(Boolean))]; }
function numericOrString(value: unknown): string | number { const number = Number(value); return Number.isSafeInteger(number) ? number : String(value); }
function summarize(value: unknown): string { try { return JSON.stringify(value).slice(0, 500); } catch { return String(value).slice(0, 500); } }
function assertSuccess(value: any, action: string): void { if (value?.success === false) throw new Error(`${action}失败：${summarize(value)}`); }
function findPrivateReplies(value: any): unknown[] { return [value?.private_replies, value?.privateReplies, value?.result?.private_replies, value?.settings?.private_replies].find(Array.isArray) ?? []; }
function flowFromGetContents(value: any): Record<string, any> | undefined { return firstRecord(value?.flow) ?? firstRecord(arrayValue(value?.flow)[0]); }
function flowSummary(flow: Record<string, any>): { id: string; name: string } { return { id: String(flow.id), name: String(flow.name ?? flow.title ?? `Flow ${flow.id}`) }; }
function flowSnapshot(pageId: string, flow: Record<string, any>, kind: "flow" | "defaultReply"): FlowSnapshot {
  return { identity: { pageId, flowId: String(flow.id), kind }, name: String(flow.name ?? flow.title ?? `Flow ${flow.id}`), post: clone(flow), selectedTab: "content", isPreview: Boolean(flow.is_preview), isPreviewPublished: Boolean(flow.is_preview_published), botFields: [], tags: [], capturedAt: new Date().toISOString() };
}
function readWebformSetting(value: unknown): Record<string, any> { if (objectValue(value)) return clone(value as Record<string, any>); if (typeof value === "string") { try { return objectValue(JSON.parse(value)) ?? {}; } catch { return {}; } } return {}; }
function readTargetCountryCodes(value: unknown): string[] { return uniqueStrings(arrayValue(readWebformSetting(value).country).map(String)); }
function readTimeRanges(settings: Record<string, any>): Array<{ begin_time: string; end_time: string }> { const ranges = arrayValue(settings.time_ranges); return ranges.length ? ranges as Array<{ begin_time: string; end_time: string }> : [{ begin_time: String(settings.begin_time ?? ""), end_time: String(settings.end_time ?? "") }]; }
function normalizeCommentReplies(value: unknown[]): CommentReplyItem[] { return value.map((item, index) => { const record = firstRecord(item) ?? {}; const text = String(record.text ?? "").trim(); const commentLevel2 = String(record.commentLevel2 ?? "").trim(); if (!text) throw new Error(`第 ${index + 1} 条评论回复为空`); return { text, images: arrayValue(record.images) as Record<string, unknown>[], ...(commentLevel2 ? { commentLevel2, imagesLv2: arrayValue(record.imagesLv2) as Record<string, unknown>[] } : {}) }; }); }
function commentAutomationFromSettings(settings: Record<string, any>): CommentAutomationSettings { return { autoReplyComment: booleanValue(settings.auto_reply_comment), autoInbox: booleanValue(settings.inbox_from_comment), prioritizePostSettings: booleanValue(settings.prioritize_auto_reply_with_setup_of_each_post), replyBasedOnSpecificPosts: booleanValue(settings.only_reply_post_config), onlyFirstCommentOnPage: booleanValue(settings.only_reply_first_comment), onlyFirstCommentOnEachPost: booleanValue(settings.inbox_first_comment_post), onlyFirstLevelComments: booleanValue(settings.only_track_first_level_comment), inboxCommentsFromGroupPosts: booleanValue(settings.auto_comment_in_group), autoLikeComments: booleanValue(settings.auto_like_comment), ignoreSeedingAccounts: booleanValue(settings.no_auto_inb_fr_cmt_seeding), replies: normalizeCommentReplies(arrayValue(settings.data_comments)) }; }
function defaultBotFieldValue(type: string): unknown { return type === "number" ? 0 : type === "boolean" ? false : ""; }
function keywordContent(terms: string[]): Record<string, string[]> { return { is_content: uniqueStrings(terms), not_content: [], contents: [], are_content: [], rates: [] }; }
function keywordTerms(rule: CustomerKeywordRule): string[] { return Array.isArray(rule.content?.is_content) ? uniqueStrings(rule.content.is_content.map(String)) : []; }
function sameTerms(left: string[], right: string[]): boolean { const a = uniqueStrings(left).sort(); const b = uniqueStrings(right).sort(); return a.length === b.length && a.every((x, i) => x === b[i]); }
function createPrivateReplySkeleton(name: string): Record<string, any> { return { key: randomKey(), type: "private_replies", name, post_id: null, config: { add_actions: [] }, blocks: [{ title: "Private Replies", coordinate: { coordinateX: 891, coordinateY: 779 }, key: randomKey(), cards: [{ key: randomKey(), is_valid: false, plugin_id: "text", is_spin: false, messages: [""], config: { text: "", buttons: [] } }] }] }; }
function randomKey(): string { return Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => (x % 36).toString(36)).join(""); }
