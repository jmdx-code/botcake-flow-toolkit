import { MAX_REMOTE_FILE_BYTES } from "../../shared/constants";
import type { BackgroundRequest, BackgroundResponse } from "../../shared/background-protocol";
import { parseCatalogCsv } from "../../core/catalog";
import { isAnalyticsDashboardUrl } from "../../core/analytics-refresh";
import { AnalyticsBackgroundService } from "./analytics";
import { readAnalyticsPrimaryToken, writeAnalyticsPrimaryToken } from "./analytics-token-vault";
import type { AnalyticsDirectoryData, AnalyticsPage, AnalyticsPageTraffic, TrafficDashboardData } from "../../shared/types";

const CATALOG_CACHE_KEY = "catalogCsvCache";
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const ANALYTICS_REFRESH_ALARM = "analytics-auto-refresh";
const ANALYTICS_REFRESH_TARGET_KEY = "analyticsRefreshTarget";
const ANALYTICS_REFRESH_RESULT_KEY = "analyticsAutoRefreshResult";
const ANALYTICS_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const ANALYTICS_PAGE_CACHE_KEY = "analyticsPageResultCacheV1";
const ANALYTICS_DIRECTORY_SNAPSHOT_KEY = "analyticsDirectorySnapshotV1";
const ANALYTICS_DIRECTORY_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

type CatalogCacheEntry = {
  url: string;
  text: string;
  contentType?: string;
  fetchedAt: number;
};

type AnalyticsRefreshTarget = {
  pageIds: string[];
  timezone: string;
  startDate: string;
  endDate: string;
  comparePrevious: boolean;
};

type AnalyticsStoredResult = {
  target: AnalyticsRefreshTarget;
  data?: TrafficDashboardData;
  error?: string;
  completedAt: number;
};

const analyticsService = new AnalyticsBackgroundService(readBotcakeAccessToken, discoverAnalyticsPages);
let analyticsPageCacheWriteTail: Promise<void> = Promise.resolve();

void ensureAnalyticsRefreshAlarm();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ANALYTICS_REFRESH_ALARM) void runAnalyticsAutoRefresh().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse: (response: BackgroundResponse) => void) => {
  void handleMessage(request).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

async function handleMessage(request: BackgroundRequest): Promise<BackgroundResponse> {
  switch (request.action) {
    case "fetchText": {
      const response = await safeFetch(request.url);
      return { ok: true, text: await response.text(), contentType: response.headers.get("content-type") ?? undefined };
    }
    case "fetchCatalog": {
      return fetchCatalog(request.url, request.forceRefresh === true);
    }
    case "fetchBinary": {
      const response = await safeFetch(request.url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) throw new Error("远程文件超过 30MB 限制");
      return {
        ok: true,
        bytes: Array.from(bytes),
        contentType: response.headers.get("content-type") ?? undefined,
        fileName: fileNameFromResponse(response),
      };
    }
    case "download": {
      const blob = new Blob([new Uint8Array(request.bytes)], { type: request.mime });
      const dataUrl = await blobToDataUrl(blob);
      const downloadId = await chrome.downloads.download({ url: dataUrl, filename: request.fileName, saveAs: false });
      return { ok: true, downloadId };
    }
    case "saveBackup": {
      const storageKey = `backup:${request.key}:${Date.now()}`;
      const removed = await trimFlowBackupsBeforeWrite(request.key, 4);
      while (true) {
        try {
          await chrome.storage.local.set({ [storageKey]: request.value });
          return { ok: true, value: { storageKey, removed } };
        } catch (error) {
          if (!isStorageQuotaError(error)) throw error;
          const oldest = await findOldestBackupForQuota(request.key);
          if (!oldest) throw new Error(`本地备份空间不足，且没有可自动清理的旧备份：${error instanceof Error ? error.message : String(error)}`);
          await chrome.storage.local.remove(oldest);
          removed.push(oldest);
        }
      }
    }
    case "getBackups": {
      const all = await chrome.storage.local.get();
      const prefix = `backup:${request.key}:`;
      return { ok: true, value: Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(prefix))) };
    }
    case "getBotcakeAccessToken": {
      return { ok: true, value: await readBotcakeAccessToken(true) };
    }
    case "getAnalyticsDirectory": {
      const snapshot = await readAnalyticsDirectorySnapshot();
      if (!request.forceRefresh && snapshot) {
        if (Date.now() - Date.parse(snapshot.fetchedAt) >= ANALYTICS_DIRECTORY_SNAPSHOT_TTL_MS) {
          void analyticsService.getDirectory(true)
            .then((value) => chrome.storage.local.set({ [ANALYTICS_DIRECTORY_SNAPSHOT_KEY]: value }))
            .catch(() => undefined);
        }
        return { ok: true, value: snapshot };
      }
      const liveDirectory = analyticsService.getDirectory(request.forceRefresh === true);
      void liveDirectory.then((value) => chrome.storage.local.set({ [ANALYTICS_DIRECTORY_SNAPSHOT_KEY]: value })).catch(() => undefined);
      try {
        const value = await withTimeout(liveDirectory, 12_000, "读取 Botcake 专页列表超时，请刷新任意 Botcake 页面后重试");
        return { ok: true, value };
      } catch (error) {
        if (snapshot?.pages.length) return { ok: true, value: snapshot };
        throw error;
      }
    }
    case "getAnalyticsData": {
      const target = analyticsTargetFromRequest(request);
      if (!request.forceRefresh) {
        const stored = (await chrome.storage.local.get(ANALYTICS_REFRESH_RESULT_KEY))[ANALYTICS_REFRESH_RESULT_KEY];
        if (isFreshAnalyticsResult(stored, target)) return { ok: true, value: stored.data };
      }
      const data = await analyticsService.getData(request);
      await chrome.storage.local.set({
        [ANALYTICS_REFRESH_RESULT_KEY]: { target, data, completedAt: Date.now() } satisfies AnalyticsStoredResult,
      });
      return { ok: true, value: data };
    }
    case "getAnalyticsPageData": {
      const target: AnalyticsRefreshTarget = {
        pageIds: [request.pageId], timezone: request.timezone, startDate: request.startDate,
        endDate: request.endDate, comparePrevious: request.comparePrevious,
      };
      const signature = `v2:${analyticsTargetSignature(target)}`;
      if (!request.forceRefresh) {
        const cached = await readAnalyticsPageCache(signature);
        if (cached) return { ok: true, value: cached };
      }
      const value = await analyticsService.getPageData(request);
      await writeAnalyticsPageCache(signature, value);
      return { ok: true, value };
    }
    case "getAnalyticsLogs": {
      return { ok: true, value: await analyticsService.getLogsData(request.pageIds, request.forceRefresh === true) };
    }
    case "configureAnalyticsPages": {
      return { ok: true, value: await analyticsService.configurePages(request.pages) };
    }
    case "getAnalyticsManagedTokens": {
      const value = await analyticsService.getManagedTokens();
      await chrome.storage.local.set({ [ANALYTICS_DIRECTORY_SNAPSHOT_KEY]: { pages: value.pages, fetchedAt: value.fetchedAt } });
      return { ok: true, value };
    }
    case "addAnalyticsManagedTokens": {
      const value = await analyticsService.addManagedTokens(request.tokens);
      await chrome.storage.local.set({ [ANALYTICS_DIRECTORY_SNAPSHOT_KEY]: { pages: value.pages, fetchedAt: value.fetchedAt } });
      return { ok: true, value };
    }
    case "removeAnalyticsManagedToken": {
      const value = await analyticsService.removeManagedToken(request.tokenId);
      await chrome.storage.local.set({ [ANALYTICS_DIRECTORY_SNAPSHOT_KEY]: { pages: value.pages, fetchedAt: value.fetchedAt } });
      return { ok: true, value };
    }
    case "setAnalyticsRefreshTarget": {
      if (request.target) {
        await chrome.storage.local.set({ [ANALYTICS_REFRESH_TARGET_KEY]: request.target });
        await chrome.alarms.create(ANALYTICS_REFRESH_ALARM, { delayInMinutes: 10, periodInMinutes: 10 });
      } else {
        await chrome.storage.local.remove([ANALYTICS_REFRESH_TARGET_KEY, ANALYTICS_REFRESH_RESULT_KEY]);
      }
      return { ok: true };
    }
    case "callBotcakeMain": {
      return callBotcakeMain(request.mainAction, request.payload);
    }
  }
}

async function runAnalyticsAutoRefresh(): Promise<void> {
  const extensionUrl = chrome.runtime.getURL("src/scopes/options/index.html");
  const tabs = await chrome.tabs.query({
    url: [`${extensionUrl}*`, "https://botcake.io/dashboard*"],
  });
  if (!tabs.some((tab) => isAnalyticsDashboardUrl(tab.url ?? "", extensionUrl))) return;
  const stored = await chrome.storage.local.get(ANALYTICS_REFRESH_TARGET_KEY);
  const target = stored[ANALYTICS_REFRESH_TARGET_KEY];
  if (!isAnalyticsRefreshTarget(target)) return;
  try {
    const data = await analyticsService.getData({ ...target, forceRefresh: true });
    await chrome.storage.local.set({ [ANALYTICS_REFRESH_RESULT_KEY]: { target, data, completedAt: Date.now() } });
  } catch (error) {
    await chrome.storage.local.set({
      [ANALYTICS_REFRESH_RESULT_KEY]: {
        target,
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      },
    });
  }
}

async function ensureAnalyticsRefreshAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ANALYTICS_REFRESH_ALARM);
  if (!existing) await chrome.alarms.create(ANALYTICS_REFRESH_ALARM, { periodInMinutes: 10 });
}

function isAnalyticsRefreshTarget(value: unknown): value is AnalyticsRefreshTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<AnalyticsRefreshTarget>;
  return Array.isArray(target.pageIds)
    && target.pageIds.length > 0
    && target.pageIds.every((id) => typeof id === "string" && /^\d+$/.test(id))
    && typeof target.timezone === "string"
    && typeof target.startDate === "string"
    && typeof target.endDate === "string"
    && typeof target.comparePrevious === "boolean";
}

function analyticsTargetFromRequest(request: Extract<BackgroundRequest, { action: "getAnalyticsData" }>): AnalyticsRefreshTarget {
  return {
    pageIds: [...new Set(request.pageIds)].sort(),
    timezone: request.timezone,
    startDate: request.startDate,
    endDate: request.endDate,
    comparePrevious: request.comparePrevious,
  };
}

function isFreshAnalyticsResult(value: unknown, target: AnalyticsRefreshTarget): value is AnalyticsStoredResult & { data: TrafficDashboardData } {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AnalyticsStoredResult>;
  return Boolean(result.data)
    && typeof result.completedAt === "number"
    && Date.now() - result.completedAt < ANALYTICS_RESULT_CACHE_TTL_MS
    && analyticsTargetSignature(result.target) === analyticsTargetSignature(target);
}

function analyticsTargetSignature(target: AnalyticsRefreshTarget | undefined): string {
  if (!target) return "";
  return JSON.stringify({ ...target, pageIds: [...target.pageIds].sort() });
}

async function readAnalyticsPageCache(signature: string): Promise<AnalyticsPageTraffic | undefined> {
  const stored = (await chrome.storage.local.get(ANALYTICS_PAGE_CACHE_KEY))[ANALYTICS_PAGE_CACHE_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const entry = (stored as Record<string, { value?: AnalyticsPageTraffic; completedAt?: number }>)[signature];
  if (!entry?.value || typeof entry.completedAt !== "number" || Date.now() - entry.completedAt >= ANALYTICS_RESULT_CACHE_TTL_MS) return undefined;
  return entry.value;
}

async function writeAnalyticsPageCache(signature: string, value: AnalyticsPageTraffic): Promise<void> {
  const write = analyticsPageCacheWriteTail.then(async () => {
    const stored = (await chrome.storage.local.get(ANALYTICS_PAGE_CACHE_KEY))[ANALYTICS_PAGE_CACHE_KEY];
    const source = stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored as Record<string, { value?: AnalyticsPageTraffic; completedAt?: number }>
      : {};
    const entries = Object.entries(source)
      .filter(([, entry]) => typeof entry.completedAt === "number" && Date.now() - entry.completedAt < ANALYTICS_RESULT_CACHE_TTL_MS)
      .sort((a, b) => (b[1].completedAt ?? 0) - (a[1].completedAt ?? 0))
      .slice(0, 39);
    await chrome.storage.local.set({ [ANALYTICS_PAGE_CACHE_KEY]: Object.fromEntries([[signature, { value, completedAt: Date.now() }], ...entries.filter(([key]) => key !== signature)]) });
  });
  analyticsPageCacheWriteTail = write.catch(() => undefined);
  await write;
}

async function discoverAnalyticsPages(): Promise<AnalyticsPage[]> {
  const startedAt = performance.now();
  const response = await callBotcakeMain("getAnalyticsPages", undefined);
  if (!response.ok || !("value" in response) || !Array.isArray(response.value)) {
    throw new Error(response.ok ? "Botcake 没有返回专页目录" : response.error);
  }
  console.debug("[Botcake Analytics] directory:page-bridge", {
    elapsedMs: Math.round(performance.now() - startedAt),
    pages: response.value.length,
  });
  return response.value as AnalyticsPage[];
}

let primaryTokenMemory: { token: string; expiresAt: number } | undefined;

async function readBotcakeAccessToken(forceRefresh = false): Promise<string> {
  const minimumLifetime = Date.now() + 60_000;
  if (!forceRefresh && primaryTokenMemory && primaryTokenMemory.expiresAt > minimumLifetime) return primaryTokenMemory.token;
  if (!forceRefresh) {
    const cached = await readAnalyticsPrimaryToken();
    if (cached && cached.expiresAt > minimumLifetime) {
      primaryTokenMemory = cached;
      return cached.token;
    }
  }
  const tabs = await chrome.tabs.query({ url: "https://botcake.io/*" });
  const ordered = [...tabs].sort((a, b) => {
    const dashboardDifference = Number(/\/dashboard/.test(b.url ?? "")) - Number(/\/dashboard/.test(a.url ?? ""));
    return dashboardDifference || Number(Boolean(b.active)) - Number(Boolean(a.active));
  });
  let lastError: unknown;
  for (const tab of ordered) {
    if (!tab.id) continue;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const appWindow = window as Window & {
            __NEXT_REDUX_STORE__?: { getState?: () => { auth?: { accessToken?: unknown; access_token?: unknown } } };
          };
          const state = appWindow.__NEXT_REDUX_STORE__?.getState?.();
          const reduxToken = state?.auth?.accessToken ?? state?.auth?.access_token;
          if (typeof reduxToken === "string" && reduxToken.length > 10) return reduxToken;
          const normalize = (value: string | null | undefined) => {
            if (!value) return "";
            let text = value.trim();
            try { text = decodeURIComponent(text); } catch { /* already decoded */ }
            if (text.startsWith("{") || text.startsWith("[")) {
              try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                const nested = parsed?.token_jwt ?? parsed?.accessToken ?? parsed?.access_token ?? parsed?.token;
                if (typeof nested === "string") text = nested.trim();
              } catch { /* not JSON storage */ }
            }
            if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
              text = text.slice(1, -1);
            }
            return text.replace(/^Bearer\s+/i, "").trim();
          };
          // Botcake 的新版工作台会把登录令牌放在浏览器存储中，旧版才会
          // 暴露在 Redux / __NEXT_DATA__。同时读取两套来源，避免必须刷新页面。
          const storedCandidates = [
            localStorage.getItem("token_jwt"),
            localStorage.getItem("BOTCAKE_TOKEN"),
            localStorage.getItem("accessToken"),
            sessionStorage.getItem("token_jwt"),
            sessionStorage.getItem("BOTCAKE_TOKEN"),
            document.cookie.match(/(?:^|;\s*)token_jwt=([^;]+)/)?.[1],
          ];
          for (const candidate of storedCandidates) {
            const storedToken = normalize(candidate);
            if (storedToken.length > 10) return storedToken;
          }
          const text = document.getElementById("__NEXT_DATA__")?.textContent ?? "";
          return text.match(/"(?:accessToken|access_token)":"([^"]+)"/)?.[1] ?? "";
        },
      });
      const token = result?.result;
      if (typeof token === "string" && token.length > 10) {
        const expiresAt = tokenExpiration(token) ?? Date.now() + 30 * 60 * 1000;
        primaryTokenMemory = { token, expiresAt };
        await writeAnalyticsPrimaryToken(token, expiresAt);
        return token;
      }
      lastError = new Error("页面中没有可用登录令牌");
    } catch (error) {
      lastError = error;
    }
  }
  if (!ordered.length) throw new Error("请先打开并登录 Botcake；数据读取将在扩展后台完成");
  throw new Error(`无法自动取得 Botcake 登录令牌，请刷新任意 Botcake 页面：${lastError instanceof Error ? lastError.message : String(lastError ?? "未知错误")}`);
}

function tokenExpiration(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const value = JSON.parse(atob(normalized)) as { exp?: unknown };
    return typeof value.exp === "number" && value.exp > 0 ? value.exp * 1000 : undefined;
  } catch { return undefined; }
}

async function callBotcakeMain(mainAction: string, payload: unknown): Promise<BackgroundResponse> {
  const tabs = await chrome.tabs.query({ url: "https://botcake.io/*" });
  const ordered = [...tabs].sort((a, b) => {
    const dashboardDifference = Number(/\/dashboard/.test(b.url ?? "")) - Number(/\/dashboard/.test(a.url ?? ""));
    if (/^getAnalytics|getTrafficDashboard/.test(mainAction) && dashboardDifference) return dashboardDifference;
    return Number(Boolean(b.active)) - Number(Boolean(a.active));
  });
  let lastError: unknown;
  for (const tab of ordered) {
    if (!tab.id) continue;
    try {
      const response = await withTimeout(
        chrome.tabs.sendMessage(tab.id, { action: "callMainProxy", mainAction, payload }) as Promise<BackgroundResponse | undefined>,
        8_000,
        "Botcake 页面消息响应超时",
      );
      if (response?.ok) return response;
      lastError = new Error(response?.ok === false ? response.error : "Botcake 页面没有返回数据");
    } catch (error) {
      lastError = error;
    }
  }
  if (!ordered.length) throw new Error("请先打开并登录 Botcake，再刷新数据");
  throw new Error(`无法连接 Botcake 页面，请刷新任意 Botcake 页面后重试：${lastError instanceof Error ? lastError.message : String(lastError ?? "未知错误")}`);
}

async function readAnalyticsDirectorySnapshot(): Promise<AnalyticsDirectoryData | undefined> {
  const value = (await chrome.storage.local.get(ANALYTICS_DIRECTORY_SNAPSHOT_KEY))[ANALYTICS_DIRECTORY_SNAPSHOT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<AnalyticsDirectoryData>;
  if (!Array.isArray(snapshot.pages) || typeof snapshot.fetchedAt !== "string") return undefined;
  const pages = snapshot.pages.filter((page): page is AnalyticsPage => Boolean(page && /^\d{8,}$/.test(String(page.id)) && typeof page.name === "string"));
  // 空目录不能作为有效缓存，否则一次临时连接失败会让面板在 TTL 内一直卡空。
  if (!pages.length) return undefined;
  return { pages, fetchedAt: snapshot.fetchedAt };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function fetchCatalog(url: string, forceRefresh: boolean): Promise<BackgroundResponse> {
  const cachedValue = (await chrome.storage.local.get(CATALOG_CACHE_KEY))[CATALOG_CACHE_KEY];
  const cached = isCatalogCacheEntry(cachedValue) && cachedValue.url === url ? cachedValue : undefined;
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return { ok: true, text: cached.text, contentType: cached.contentType, cache: "fresh" };
  }
  try {
    const response = await safeFetch(requestUrl(url), 1);
    const text = await response.text();
    if (!parseCatalogCsv(text).length) throw new Error("控制台 CSV 中没有可识别的设置、流程、默认回复或关键词资源");
    const entry: CatalogCacheEntry = {
      url,
      text,
      contentType: response.headers.get("content-type") ?? undefined,
      fetchedAt: Date.now(),
    };
    await chrome.storage.local.set({ [CATALOG_CACHE_KEY]: entry });
    return { ok: true, text: entry.text, contentType: entry.contentType, cache: "network" };
  } catch (error) {
    if (cached) return { ok: true, text: cached.text, contentType: cached.contentType, cache: "stale" };
    throw error;
  }
}

function isCatalogCacheEntry(value: unknown): value is CatalogCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CatalogCacheEntry>;
  return typeof entry.url === "string" && typeof entry.text === "string" && typeof entry.fetchedAt === "number";
}

function requestUrl(url: string): string {
  return new URL(url).toString();
}

async function trimFlowBackupsBeforeWrite(scopeKey: string, keep: number): Promise<string[]> {
  const all = await chrome.storage.local.get();
  const prefix = `backup:${scopeKey}:`;
  const keys = Object.keys(all).filter((key) => key.startsWith(prefix)).sort().reverse();
  const removed = keys.slice(keep);
  if (removed.length) await chrome.storage.local.remove(removed);
  return removed;
}

async function findOldestBackupForQuota(currentScopeKey: string): Promise<string | undefined> {
  const all = await chrome.storage.local.get();
  const entries = Object.keys(all).map(parseBackupKey).filter((entry): entry is BackupKeyInfo => Boolean(entry));
  if (!entries.length) return undefined;
  entries.sort((a, b) => a.timestamp - b.timestamp);

  const newestByScope = new Map<string, string>();
  for (const entry of [...entries].reverse()) if (!newestByScope.has(entry.scopeKey)) newestByScope.set(entry.scopeKey, entry.storageKey);
  const duplicate = entries.find((entry) => newestByScope.get(entry.scopeKey) !== entry.storageKey);
  if (duplicate) return duplicate.storageKey;

  const otherFlow = entries.find((entry) => entry.scopeKey !== currentScopeKey);
  return otherFlow?.storageKey ?? entries[0]?.storageKey;
}

type BackupKeyInfo = { storageKey: string; scopeKey: string; timestamp: number };

function parseBackupKey(storageKey: string): BackupKeyInfo | undefined {
  const match = storageKey.match(/^backup:(\d+):(\d+|defaultReply):(\d+)$/);
  if (!match) return undefined;
  return { storageKey, scopeKey: `${match[1]}:${match[2]}`, timestamp: Number(match[3]) };
}

function isStorageQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /quota|QUOTA_BYTES|MAX_WRITE|bytes.*limit/i.test(message);
}

async function safeFetch(url: string, maxRetries = 0): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("只允许 HTTPS 资源");
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(parsed, { redirect: "follow", cache: "no-store", credentials: "omit" });
      if (!response.ok) {
        if (attempt < maxRetries && (response.status === 429 || response.status >= 500)) {
          await delay(700);
          continue;
        }
        throw new Error(`下载失败（HTTP ${response.status}）`);
      }
      const size = Number(response.headers.get("content-length") ?? 0);
      if (size > MAX_REMOTE_FILE_BYTES) throw new Error("远程文件超过 30MB 限制");
      return response;
    } catch (error) {
      if (attempt >= maxRetries || !isNetworkError(error)) throw error;
      await delay(700);
    }
  }
  throw new Error("下载失败");
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || /network|fetch failed|connection/i.test(error instanceof Error ? error.message : String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fileNameFromResponse(response: Response): string | undefined {
  const disposition = response.headers.get("content-disposition") ?? "";
  const raw = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)?.[1]?.trim();
  if (!raw) return undefined;
  const cleaned = raw.replace(/^['"]|['"]$/g, "");
  try { return decodeURIComponent(cleaned); } catch { return cleaned; }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
