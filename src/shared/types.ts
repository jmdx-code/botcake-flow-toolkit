export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface FlowIdentity {
  pageId: string;
  flowId: string;
  kind?: "flow" | "defaultReply";
}

export interface BotField {
  id: string | number;
  name: string;
  type?: string;
  [key: string]: unknown;
}

export interface BotcakeTag {
  id: string | number;
  name: string;
  color?: string | null;
  [key: string]: unknown;
}

export interface FlowSnapshot {
  identity: FlowIdentity;
  name: string;
  post: Record<string, unknown>;
  selectedTab?: string | number;
  isPreview?: boolean;
  isPreviewPublished?: boolean;
  botFields: BotField[];
  tags?: BotcakeTag[];
  capturedAt: string;
}

export type MediaKind = "image" | "audio" | "video";
export type InputKind = "text" | "number" | "random" | MediaKind;

export interface TemplateInputOption {
  label: string;
  value?: string;
  asset?: string;
  url?: string;
}

export interface TemplateInput {
  key: string;
  label: string;
  kind: InputKind;
  required?: boolean;
  default?: string | number;
  description?: string;
  options?: TemplateInputOption[];
  bindings?: string[];
  accept?: string;
  retainWhenUnused?: boolean;
}

export interface BotFieldDependency {
  name: string;
  sourceId?: string;
  fieldType?: string;
  defaultValue?: unknown;
  description?: string;
}

export interface TagDependency {
  name: string;
  sourceId?: string;
}

export interface MediaDependency {
  key: string;
  kind: MediaKind;
  configPath: string;
  sourceUrl?: string;
  asset?: string;
  name?: string;
  mime?: string;
}

export interface UnsupportedDependency {
  path: string;
  key: string;
  value: unknown;
  reason: string;
}

export interface FlowTemplateV1 {
  format: "botcake-flow-template";
  version: 1;
  meta: {
    id: string;
    name: string;
    description?: string;
    createdAt: string;
    sourcePageId?: string;
    sourceFlowId?: string;
  };
  flow: {
    name: string;
    post: Record<string, unknown>;
    entryBlockKey: string;
    selectedTab?: string | number;
    isPreview?: boolean;
    isPreviewPublished?: boolean;
  };
  inputs: TemplateInput[];
  dependencies: {
    botFields: BotFieldDependency[];
    tags?: TagDependency[];
    media: MediaDependency[];
    unsupported: UnsupportedDependency[];
  };
}

export interface LoadedTemplate {
  template: FlowTemplateV1;
  assets: Map<string, Uint8Array>;
  sourceName: string;
}

export interface CatalogRow {
  name: string;
  kind: "settings" | "flow" | "defaultReply" | "keyword";
  version?: string;
  url: string;
  description?: string;
  keywords?: string[];
  enabled: boolean;
}

export interface PendingFlowApply {
  id: string;
  sourceName: string;
  archiveBytes: Uint8Array;
  values: Record<string, ImportInputValue>;
  targetPageId: string;
  targetFlowId: string;
  applyWelcome: boolean;
  target: "comment" | "defaultReply" | "keyword";
  keyword?: {
    id: string;
    name: string;
    terms: string[];
  };
  /** 开始自动应用前所在的 Botcake 页面；完成后返回。 */
  returnUrl?: string;
  createdAt: number;
}

export interface ImportInputValue {
  text?: string;
  bytes?: Uint8Array;
  fileName?: string;
  mime?: string;
  url?: string;
  asset?: string;
}

export interface CompileReport {
  warnings: string[];
  createdBotFields: string[];
  mappedBotFields: Array<{ name: string; from?: string; to: string }>;
  createdTags: string[];
  mappedTags: Array<{ name: string; from?: string; to: string }>;
  uploadedMedia: string[];
}

export interface SaveFlowPayload {
  name: string;
  post: Record<string, unknown>;
  selectedTab?: string | number;
  isPreview?: boolean;
  isPreviewPublished?: boolean;
}

export interface CommentFlowStatus {
  pageId: string;
  flow?: { id: string; name: string };
  autoInbox?: boolean;
  autoReplyComment?: boolean;
}

export interface CommentReplyItem {
  text: string;
  images?: Record<string, unknown>[];
  commentLevel2?: string;
  imagesLv2?: Record<string, unknown>[];
}

export interface CommentAutomationSettings {
  autoReplyComment: boolean;
  autoInbox: boolean;
  prioritizePostSettings: boolean;
  replyBasedOnSpecificPosts: boolean;
  onlyFirstCommentOnPage: boolean;
  onlyFirstCommentOnEachPost: boolean;
  onlyFirstLevelComments: boolean;
  inboxCommentsFromGroupPosts: boolean;
  autoLikeComments: boolean;
  ignoreSeedingAccounts: boolean;
  replies: CommentReplyItem[];
}

export interface PageAutomationState {
  pageId: string;
  timezone?: number;
  targetCountryCodes: string[];
  comment: CommentAutomationSettings;
  defaultPrivateReply?: { id: string; name: string };
  defaultReply?: { id: string; name: string };
  welcome?: { flow?: { id: string; name: string }; enabled: boolean };
  botFields: BotField[];
}

export interface BotFieldSpec {
  name: string;
  type?: string;
  value?: unknown;
  description?: string;
}

export interface UpdatePageAutomationPayload {
  timezone?: number;
  targetCountryCodes?: string[];
  comment?: Partial<Omit<CommentAutomationSettings, "replies">> & { replies?: CommentReplyItem[] };
}

export interface UpdatePageAutomationResult {
  changed: string[];
  state: PageAutomationState;
}

export interface EnsureBotFieldsResult {
  created: BotField[];
  existing: BotField[];
  restored: BotField[];
}

export interface EnsureDefaultCommentFlowResult {
  created: boolean;
  flow: { id: string; name: string };
  autoInboxEnabled: boolean;
}

export interface EnsureWelcomeFlowResult {
  changed: boolean;
  flow: { id: string; name: string };
  enabled: boolean;
}

export interface EnsureDefaultReplyFlowResult {
  created: boolean;
  flow: { id: string; name: string };
}

export interface EnsureKeywordFlowResult {
  createdFlow: boolean;
  createdKeyword: boolean;
  flow: { id: string; name: string };
  keyword: { id: string; name: string; isActivated: boolean };
}

export interface FinalizeKeywordFlowResult {
  flow: { id: string; name: string };
  keyword: { id: string; name: string; isActivated: true };
}

export type BotcakeFlowApplyTarget = "comment" | "defaultReply" | "keyword";

export interface PreparedBotcakeFlow {
  target: BotcakeFlowApplyTarget;
  snapshot: FlowSnapshot;
  createdFlow: boolean;
  keyword?: {
    id: string;
    name: string;
    terms: string[];
    created: boolean;
  };
}

export interface CompleteBotcakeFlowPayload {
  target: BotcakeFlowApplyTarget;
  flowId: string;
  applyWelcome?: boolean;
  keyword?: {
    id: string;
    name: string;
    terms: string[];
  };
}

export interface PageSettingsTemplateV1 {
  format: "botcake-page-settings-template";
  version: 1;
  meta: {
    name: string;
    description?: string;
    createdAt: string;
    sourcePageId?: string;
  };
  settings: {
    timezone?: number;
    targetCountryCodes: string[];
    comment: Omit<CommentAutomationSettings, "autoInbox">;
    botFields: BotFieldSpec[];
  };
}

export interface AnalyticsPage {
  id: string;
  name: string;
  avatarUrl?: string;
  platform?: string;
}

export interface AnalyticsDailyPoint {
  date: string;
  count: number;
}

export interface AnalyticsPageTraffic {
  page: AnalyticsPage;
  todayHours: number[];
  yesterdayHours: number[];
  daily: AnalyticsDailyPoint[];
  todayTotal: number;
  yesterdayTotal: number;
  rangeTotal: number;
  previousDaily?: AnalyticsDailyPoint[];
  previousRangeTotal?: number;
  previousToCurrentTimeTotal?: number;
  gender: {
    female: number;
    male: number;
    unknown: number;
  };
  error?: string;
}

export interface AnalyticsLogEntry {
  page: AnalyticsPage;
  id?: string | number;
  code: string;
  subcode: string;
  description: string;
  count: number;
  updatedAt: string;
}

export interface TrafficDashboardData {
  timezone: string;
  today: string;
  yesterday: string;
  startDate: string;
  endDate: string;
  pages: AnalyticsPageTraffic[];
  logs: AnalyticsLogEntry[];
  fetchedAt: string;
}

export interface AnalyticsDirectoryData {
  pages: AnalyticsPage[];
  fetchedAt: string;
}

export interface AnalyticsPageConfigurationResult extends AnalyticsDirectoryData {
  added: string[];
  failed: Array<{ pageId: string; error: string }>;
}

export interface AnalyticsManagedTokenSummary {
  id: string;
  label: string;
  pageCount: number;
  pages: AnalyticsPage[];
  addedAt: number;
}

export interface AnalyticsTokenManagementResult extends AnalyticsDirectoryData {
  tokens: AnalyticsManagedTokenSummary[];
  added: string[];
  failed: Array<{ label: string; error: string }>;
}

export interface MainRequestMap {
  inspect: undefined;
  saveFlow: SaveFlowPayload;
  getBotFields: undefined;
  createBotField: { name: string; type?: string; value?: unknown; description?: string };
  getTags: undefined;
  createTag: { name: string };
  uploadMedia: { kind: MediaKind; name: string; mime: string; base64: string };
  getPrivateReplies: undefined;
  getCommentFlowStatus: undefined;
  getPageAutomationState: undefined;
  updatePageAutomation: UpdatePageAutomationPayload;
  ensureBotFields: { fields: BotFieldSpec[] };
  ensureDefaultCommentFlow: { name?: string; enableAutoInbox?: boolean };
  ensureWelcomeFlowFromComment: { enable?: boolean };
  ensureDefaultReplyFlow: { name?: string };
  ensureKeywordFlow: { name: string; keywords: string[] };
  finalizeKeywordFlow: { keywordId: string; flowId: string; name: string; keywords: string[] };
  activateDefaultReply: undefined;
  getAnalyticsPages: undefined;
  getTrafficDashboardData: {
    pageIds: string[];
    timezone: string;
    startDate: string;
    endDate: string;
  };
}

export interface MainResponseMap {
  inspect: FlowSnapshot;
  saveFlow: { success: boolean; result?: unknown };
  getBotFields: BotField[];
  createBotField: BotField;
  getTags: BotcakeTag[];
  createTag: BotcakeTag;
  uploadMedia: Record<string, unknown>;
  getPrivateReplies: unknown[];
  getCommentFlowStatus: CommentFlowStatus;
  getPageAutomationState: PageAutomationState;
  updatePageAutomation: UpdatePageAutomationResult;
  ensureBotFields: EnsureBotFieldsResult;
  ensureDefaultCommentFlow: EnsureDefaultCommentFlowResult;
  ensureWelcomeFlowFromComment: EnsureWelcomeFlowResult;
  ensureDefaultReplyFlow: EnsureDefaultReplyFlowResult;
  ensureKeywordFlow: EnsureKeywordFlowResult;
  finalizeKeywordFlow: FinalizeKeywordFlowResult;
  activateDefaultReply: { enabled: true; usingAi: false };
  getAnalyticsPages: AnalyticsPage[];
  getTrafficDashboardData: TrafficDashboardData;
}

export type MainAction = keyof MainRequestMap;

export interface MainBridgeRequest<A extends MainAction = MainAction> {
  app: string;
  channel: "request";
  requestId: string;
  action: A;
  payload: MainRequestMap[A];
}

export interface MainBridgeResponse<A extends MainAction = MainAction> {
  app: string;
  channel: "response";
  requestId: string;
  action: A;
  ok: boolean;
  result?: MainResponseMap[A];
  error?: string;
}
