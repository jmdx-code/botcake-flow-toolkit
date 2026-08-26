import {
  addAnalyticsDays,
  aggregateCustomerTraffic,
  assertTimezone,
  countCustomerTrafficThroughTime,
  dateInAnalyticsTimezone,
  enumerateIsoDates,
  parseAnalyticsTimestamp,
} from "../../core/traffic-analytics";
import { mergeManagedTokenPages } from "../../core/analytics-token-management";
import type {
  AnalyticsDirectoryData,
  AnalyticsLogEntry,
  AnalyticsPage,
  AnalyticsPageConfigurationResult,
  AnalyticsPageTraffic,
  AnalyticsTokenManagementResult,
  TrafficDashboardData,
} from "../../shared/types";
import {
  createAnalyticsManagedToken,
  mergeAnalyticsExternalTokens,
  readAnalyticsExternalTokens,
  readAnalyticsManagedTokens,
  writeAnalyticsManagedTokens,
  type AnalyticsManagedTokenRecord,
} from "./analytics-token-vault";

const CACHE_TTL_MS = 10 * 60 * 1000;
const DIRECTORY_CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_START_GAP_MS = 75;
const REQUEST_CONCURRENCY = 4;
const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const CUSTOMER_PAGE_CONCURRENCY = 3;
const MAX_SELECTED_PAGES = 12;
const EXTRA_PAGE_IDS_KEY = "analyticsExtraPageIds";
const EXTRA_PAGES_KEY = "analyticsExtraPages";

type Cached<T> = { value: T; fetchedAt: number };
type CustomerRangeFilter = {
  unit: "hour" | "day";
  startSeconds: number;
  endSeconds: number;
};
type DataRequest = {
  pageIds: string[];
  timezone: string;
  startDate: string;
  endDate: string;
  comparePrevious: boolean;
  forceRefresh?: boolean;
  includeLogs?: boolean;
};

export class AnalyticsBackgroundService {
  private directoryCache?: Cached<AnalyticsPage[]>;
  private customerCache = new Map<string, Cached<Record<string, unknown>[]>>();
  private logCache = new Map<string, Cached<AnalyticsLogEntry[]>>();
  private inFlight = new Map<string, Promise<unknown>>();
  private requestStartTail: Promise<unknown> = Promise.resolve();
  private activeRequests = 0;
  private requestWaiters: Array<() => void> = [];
  private nextRequestAt = 0;

  constructor(
    private readonly getToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly discoverPages: () => Promise<AnalyticsPage[]>,
  ) {}

  async getDirectory(forceRefresh = false): Promise<AnalyticsDirectoryData> {
    const now = Date.now();
    if (!forceRefresh && this.directoryCache && now - this.directoryCache.fetchedAt < DIRECTORY_CACHE_TTL_MS) {
      return { pages: this.directoryCache.value, fetchedAt: new Date(this.directoryCache.fetchedAt).toISOString() };
    }
    const key = "directory";
    const pending = this.inFlight.get(key) as Promise<AnalyticsDirectoryData> | undefined;
    if (pending) return pending;
    const task = (async () => {
      const stored = await chrome.storage.local.get([EXTRA_PAGE_IDS_KEY, EXTRA_PAGES_KEY]);
      const extraIds = normalizePageIds(stored[EXTRA_PAGE_IDS_KEY]);
      const storedPages = normalizeAnalyticsPages(stored[EXTRA_PAGES_KEY]);
      // 页内请求与 Botcake 自身使用完全相同的执行环境，应优先作为目录
      // 来源。后台接口同时启动作为后备，避免任一 10 秒超时把整条串行
      // 回退链拖过 UI 的总超时。
      const tokenTask = this.getToken(forceRefresh);
      const candidates = [
        this.discoverPages().then(requireAnalyticsPages),
        tokenTask.then((token) => this.botcakeFetch("/api/v1/pages", token)).then(extractAnalyticsPages).then(requireAnalyticsPages),
        tokenTask.then((token) => this.botcakeFetch("/api/v1/users/pages_by_platform_on_pancake", token)).then(extractAnalyticsPages).then(requireAnalyticsPages),
      ];
      let discovered: AnalyticsPage[];
      try {
        discovered = await Promise.any(candidates);
      } catch (error) {
        if (storedPages.length || extraIds.length) discovered = [];
        else {
        const reasons = error instanceof AggregateError ? error.errors : [error];
        const detail = reasons.map((reason) => reason instanceof Error ? reason.message : String(reason)).filter(Boolean).slice(0, 3).join("；");
        throw new Error(`专页目录读取失败${detail ? `：${detail}` : ""}`);
        }
      }
      const pageMap = new Map(discovered.map((page) => [page.id, page]));
      for (const page of storedPages) if (!pageMap.has(page.id)) pageMap.set(page.id, page);
      for (const id of extraIds) if (!pageMap.has(id)) pageMap.set(id, fallbackPage(id));
      const pages = [...pageMap.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      this.directoryCache = { value: pages, fetchedAt: Date.now() };
      return { pages, fetchedAt: new Date(this.directoryCache.fetchedAt).toISOString() };
    })();
    this.inFlight.set(key, task);
    try { return await task; } finally { this.inFlight.delete(key); }
  }

  async configurePages(entries: Array<{ pageId: string; token: string }>): Promise<AnalyticsPageConfigurationResult> {
    const normalized = normalizeExternalPageEntries(entries);
    if (!normalized.length) throw new Error("没有识别到有效的 Token 与专页 ID 配对");
    const current = await this.getDirectory();
    const known = new Map(current.pages.map((page) => [page.id, page]));
    const added: string[] = [];
    const failed: Array<{ pageId: string; error: string }> = [];
    const directoryByToken = new Map<string, AnalyticsPage[]>();
    await mapWithConcurrency([...new Set(normalized.map((entry) => entry.token))], 2, async (token) => {
      try {
        const raw = await this.botcakeFetch("/api/v1/users/pages_by_platform_on_pancake", token);
        directoryByToken.set(token, extractAnalyticsPages(raw));
      } catch {
        directoryByToken.set(token, []);
      }
    });
    await mapWithConcurrency(normalized, 2, async ({ pageId, token }) => {
      try {
        await this.botcakeFetch(`/api/v1/pages/${pageId}/customers?page_size=1&page=1`, token);
        const discovered = directoryByToken.get(token)?.find((page) => page.id === pageId);
        known.set(pageId, discovered ?? known.get(pageId) ?? fallbackPage(pageId));
        added.push(pageId);
      } catch (reason) {
        failed.push({ pageId, error: reason instanceof Error ? reason.message : String(reason) });
      }
    });
    const stored = await chrome.storage.local.get([EXTRA_PAGE_IDS_KEY, EXTRA_PAGES_KEY]);
    const saved = new Set(normalizePageIds(stored[EXTRA_PAGE_IDS_KEY]));
    added.forEach((id) => saved.add(id));
    const savedPages = new Map(normalizeAnalyticsPages(stored[EXTRA_PAGES_KEY]).map((page) => [page.id, page]));
    for (const id of added) savedPages.set(id, known.get(id) ?? fallbackPage(id));
    const tokenUpdates: Record<string, string> = {};
    for (const entry of normalized) if (added.includes(entry.pageId)) tokenUpdates[entry.pageId] = entry.token;
    await Promise.all([
      chrome.storage.local.set({ [EXTRA_PAGE_IDS_KEY]: [...saved], [EXTRA_PAGES_KEY]: [...savedPages.values()] }),
      mergeAnalyticsExternalTokens(tokenUpdates),
    ]);
    for (const id of added) { this.clearCustomerCache(id); this.logCache.delete(id); }
    this.directoryCache = undefined;
    const directory = await this.getDirectory(true);
    return { ...directory, added, failed };
  }

  async getManagedTokens(): Promise<AnalyticsTokenManagementResult> {
    const records = await readAnalyticsManagedTokens();
    await this.syncManagedTokenPages(records);
    const directory = await this.getDirectory();
    return { ...directory, tokens: records.map(managedTokenSummary), added: [], failed: [] };
  }

  async addManagedTokens(tokens: string[]): Promise<AnalyticsTokenManagementResult> {
    const normalized = [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length >= 20 && !/\s/.test(token)))].slice(0, 100);
    if (!normalized.length) throw new Error("没有识别到有效 Token，请每行输入一个 Token");
    const records = await readAnalyticsManagedTokens();
    const byId = new Map(records.map((record) => [record.id, record]));
    const added: string[] = [];
    const failed: Array<{ label: string; error: string }> = [];
    await mapWithConcurrency(normalized, 2, async (token) => {
      const label = `Token ••••${token.slice(-4)}`;
      try {
        const pages = await this.discoverPagesForToken(token);
        if (!pages.length) throw new Error("没有读取到有权限的专页");
        const existing = [...byId.values()].find((record) => record.token === token);
        const record = await createAnalyticsManagedToken(token, pages, existing?.addedAt ?? Date.now());
        byId.set(record.id, record);
        added.push(record.id);
      } catch (reason) {
        failed.push({ label, error: reason instanceof Error ? reason.message : String(reason) });
      }
    });
    await writeAnalyticsManagedTokens([...byId.values()]);
    await this.syncManagedTokenPages([...byId.values()]);
    const directory = await this.getDirectory(true);
    return { ...directory, tokens: [...byId.values()].sort((a, b) => a.addedAt - b.addedAt).map(managedTokenSummary), added, failed };
  }

  async removeManagedToken(tokenId: string): Promise<AnalyticsTokenManagementResult> {
    const records = await readAnalyticsManagedTokens();
    const next = records.filter((record) => record.id !== tokenId);
    if (next.length === records.length) throw new Error("没有找到需要删除的 Token");
    await writeAnalyticsManagedTokens(next);
    await this.syncManagedTokenPages(next);
    const directory = await this.getDirectory(true);
    return { ...directory, tokens: next.map(managedTokenSummary), added: [], failed: [] };
  }

  async getData(request: DataRequest): Promise<TrafficDashboardData> {
    validateDataRequest(request);
    const pageIds = normalizePageIds(request.pageIds);
    if (!pageIds.length) throw new Error("请至少选择一个专页");
    if (pageIds.length > MAX_SELECTED_PAGES) throw new Error(`每次最多统计 ${MAX_SELECTED_PAGES} 个专页`);
    if (request.forceRefresh) {
      pageIds.forEach((id) => {
        this.clearCustomerCache(id);
        this.logCache.delete(id);
      });
    }
    const cacheKey = JSON.stringify({ ...request, pageIds: [...pageIds].sort(), forceRefresh: false });
    const pending = this.inFlight.get(cacheKey) as Promise<TrafficDashboardData> | undefined;
    if (pending) return pending;
    const task = this.loadData(pageIds, request);
    this.inFlight.set(cacheKey, task);
    try { return await task; } finally { this.inFlight.delete(cacheKey); }
  }

  async getPageData(request: Omit<DataRequest, "pageIds" | "includeLogs"> & { pageId: string }): Promise<AnalyticsPageTraffic> {
    const data = await this.getData({ ...request, pageIds: [request.pageId], includeLogs: false });
    const page = data.pages[0];
    if (!page) throw new Error("Botcake 没有返回该专页的统计数据");
    return page;
  }

  async getLogsData(pageIds: string[], forceRefresh = false): Promise<AnalyticsLogEntry[]> {
    const normalizedIds = normalizePageIds(pageIds).slice(0, MAX_SELECTED_PAGES);
    if (!normalizedIds.length) return [];
    const directory = await this.getDirectory();
    const known = new Map(directory.pages.map((page) => [page.id, page]));
    const externalTokens = await readAnalyticsExternalTokens();
    let token = "";
    try { token = await this.getToken(); }
    catch (reason) {
      if (normalizedIds.some((id) => !externalTokens[id])) throw reason;
    }
    if (forceRefresh) normalizedIds.forEach((id) => this.logCache.delete(id));
    const rows = await mapWithConcurrency(normalizedIds, REQUEST_CONCURRENCY, async (id) => {
      const page = known.get(id) ?? fallbackPage(id);
      return settle(this.getLogs(page, externalTokens[id] ?? token));
    });
    const failures = rows.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === rows.length) {
      const detail = failures[0]?.reason;
      throw new Error(`错误日志读取失败：${detail instanceof Error ? detail.message : String(detail ?? "未知错误")}`);
    }
    return rows.flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .sort((a, b) => parseAnalyticsTimestamp(b.updatedAt) - parseAnalyticsTimestamp(a.updatedAt));
  }

  private async loadData(pageIds: string[], request: DataRequest): Promise<TrafficDashboardData> {
    const directory = await this.getDirectory();
    const known = new Map(directory.pages.map((page) => [page.id, page]));
    const pages = pageIds.map((id) => known.get(id) ?? fallbackPage(id));
    const periodLength = daysBetween(request.startDate, request.endDate) + 1;
    const previousEnd = addAnalyticsDays(request.startDate, -1);
    const previousStart = addAnalyticsDays(previousEnd, -(periodLength - 1));
    const externalTokens = await readAnalyticsExternalTokens();
    let token = "";
    try { token = await this.getToken(); }
    catch (reason) {
      if (pageIds.some((id) => !externalTokens[id])) throw reason;
    }
    const earliestRequiredDate = request.comparePrevious ? previousStart : request.startDate;
    const results = await mapWithConcurrency(pages, REQUEST_CONCURRENCY, async (page) => {
      const traffic = blankTraffic(page, request.startDate, request.endDate, previousStart, previousEnd);
      const pageToken = externalTokens[page.id] ?? token;
      const customersResult = await settle(this.getCustomers(
        page,
        pageToken,
        earliestRequiredDate,
        request.endDate,
        request.timezone,
      ));
      if (customersResult.status === "fulfilled") {
        const customers = customersResult.value;
        const current = aggregateCustomerTraffic(customers, {
          timezone: request.timezone,
          startDate: request.startDate,
          endDate: request.endDate,
          today: request.startDate,
          yesterday: previousEnd,
        });
        Object.assign(traffic, current);
        if (request.comparePrevious) {
          const previous = aggregateCustomerTraffic(customers, {
            timezone: request.timezone,
            startDate: previousStart,
            endDate: previousEnd,
            today: previousEnd,
            yesterday: addAnalyticsDays(previousEnd, -1),
          });
          traffic.previousDaily = previous.daily;
          traffic.previousRangeTotal = previous.rangeTotal;
          if (request.startDate === request.endDate) {
            traffic.yesterdayHours = previous.todayHours;
            if (request.startDate === dateInAnalyticsTimezone(Date.now(), request.timezone)) {
              traffic.previousToCurrentTimeTotal = countCustomerTrafficThroughTime(customers, {
                timezone: request.timezone,
                date: previousEnd,
                cutoffTimestamp: Date.now(),
              });
            }
          }
        }
      } else {
        const reason = customersResult.reason;
        traffic.error = reason instanceof Error ? reason.message : String(reason);
      }
      const logs = request.includeLogs === false ? [] : await this.getLogs(page, pageToken).catch(() => []);
      return { traffic, logs };
    });
    return {
      timezone: request.timezone,
      today: request.startDate,
      yesterday: previousEnd,
      startDate: request.startDate,
      endDate: request.endDate,
      pages: results.map((item) => item.traffic),
      logs: results.flatMap((item) => item.logs).sort((a, b) => parseAnalyticsTimestamp(b.updatedAt) - parseAnalyticsTimestamp(a.updatedAt)),
      fetchedAt: new Date().toISOString(),
    };
  }

  private async getCustomers(
    page: AnalyticsPage,
    token: string,
    startDate: string,
    endDate: string,
    timezone: string,
  ): Promise<Record<string, unknown>[]> {
    const cacheKey = `v2:${page.id}:${timezone}:${startDate}:${endDate}`;
    const cached = this.customerCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
    const key = `customers:${cacheKey}`;
    const pending = this.inFlight.get(key) as Promise<Record<string, unknown>[]> | undefined;
    if (pending) return pending;
    const task = (async () => {
      const apiPageId = analyticsApiPageId(page);
      const filter = buildCustomerRangeFilter(startDate, endDate, timezone);
      const first = await this.fetchFilteredCustomerPage(apiPageId, token, 1, filter);
      const rows = [...extractRecordArray(first, ["customers", "data", "items"])];
      const totalEntries = extractTotalEntries(first);
      const pageCount = totalEntries > 0 ? Math.ceil(totalEntries / PAGE_SIZE) : 1;
      if (pageCount > MAX_PAGES) throw new Error(`专页“${page.name}”所选范围数据超过安全分页上限`);
      if (totalEntries > 0 && pageCount > 1) {
        const pageNumbers = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
        const batches = await mapWithConcurrency(pageNumbers, CUSTOMER_PAGE_CONCURRENCY, async (pageNumber) => {
          const raw = await this.fetchFilteredCustomerPage(apiPageId, token, pageNumber, filter);
          return extractRecordArray(raw, ["customers", "data", "items"]);
        });
        for (const batch of batches) rows.push(...batch);
      } else if (totalEntries === 0 && rows.length >= PAGE_SIZE) {
        // 老版本响应可能没有 total_entries；此时安全地顺序读到短页，避免只取前 200 条。
        let previousSignature = batchSignature(rows);
        for (let pageNumber = 2; pageNumber <= MAX_PAGES; pageNumber += 1) {
          const raw = await this.fetchFilteredCustomerPage(apiPageId, token, pageNumber, filter);
          const batch = extractRecordArray(raw, ["customers", "data", "items"]);
          if (!batch.length) break;
          const signature = batchSignature(batch);
          if (signature === previousSignature) break;
          previousSignature = signature;
          rows.push(...batch);
          if (batch.length < PAGE_SIZE) break;
          if (pageNumber === MAX_PAGES) throw new Error(`专页“${page.name}”所选范围数据超过安全分页上限`);
        }
      }
      this.customerCache.set(cacheKey, { value: rows, fetchedAt: Date.now() });
      return rows;
    })();
    this.inFlight.set(key, task);
    try { return await task; } finally { this.inFlight.delete(key); }
  }

  private async discoverPagesForToken(token: string): Promise<AnalyticsPage[]> {
    const candidates = [
      "/api/v1/users/pages_by_platform_on_pancake",
      "/api/v1/pages",
    ];
    const errors: string[] = [];
    for (const path of candidates) {
      try {
        const pages = extractAnalyticsPages(await this.botcakeFetch(path, token));
        if (pages.length) return pages;
      } catch (reason) {
        errors.push(reason instanceof Error ? reason.message : String(reason));
      }
    }
    throw new Error(errors[0] || "Token 无效、已过期或没有专页权限");
  }

  private async syncManagedTokenPages(records: AnalyticsManagedTokenRecord[]): Promise<void> {
    const stored = await chrome.storage.local.get([EXTRA_PAGE_IDS_KEY, EXTRA_PAGES_KEY]);
    const previousIds = normalizePageIds(stored[EXTRA_PAGE_IDS_KEY]);
    const previousPages = normalizeAnalyticsPages(stored[EXTRA_PAGES_KEY]);
    const pages = mergeManagedTokenPages(records);
    if (sameAnalyticsPages(previousPages, pages) && sameIds(previousIds, pages.map((page) => page.id))) return;
    await chrome.storage.local.set({ [EXTRA_PAGE_IDS_KEY]: pages.map((page) => page.id), [EXTRA_PAGES_KEY]: pages });
    const nextIds = new Set(pages.map((page) => page.id));
    const changedIds = new Set([
      ...previousIds.filter((id) => !nextIds.has(id)),
      ...pages.map((page) => page.id).filter((id) => !previousIds.includes(id)),
    ]);
    for (const id of changedIds) {
      this.clearCustomerCache(id);
      this.logCache.delete(id);
    }
    this.directoryCache = undefined;
  }

  private fetchFilteredCustomerPage(
    pageId: string,
    token: string,
    pageNumber: number,
    filter: CustomerRangeFilter,
  ): Promise<unknown> {
    const body = new FormData();
    body.append("filter[0][type]", "last_subscribed");
    body.append("filter[0][filter_type]", "ranger");
    body.append("filter[0][unit]", filter.unit);
    body.append("filter[0][start_date]", String(filter.startSeconds));
    body.append("filter[0][end_date]", String(filter.endSeconds));
    return this.botcakeFetch(
      `/api/v1/pages/${pageId}/customers?page_size=${PAGE_SIZE}&page=${pageNumber}`,
      token,
      { method: "POST", body },
    );
  }

  private async getLogs(page: AnalyticsPage, token: string): Promise<AnalyticsLogEntry[]> {
    const cached = this.logCache.get(page.id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
    const raw = await this.botcakeFetch(`/api/v1/pages/${page.id}/logs`, token);
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const logs = extractRecordArray(raw, ["page_logs", "logs", "data"]).slice(0, 50).map((row): AnalyticsLogEntry => ({
      page,
      id: typeof row.id === "string" || typeof row.id === "number" ? row.id : undefined,
      code: String(row.code ?? "-"),
      subcode: String(row.subcode ?? "-"),
      description: String(row.description ?? row.message ?? "未知错误"),
      count: Math.max(0, Number(row.count ?? 0) || 0),
      updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
    })).filter((entry) => {
      const timestamp = parseAnalyticsTimestamp(entry.updatedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    this.logCache.set(page.id, { value: logs, fetchedAt: Date.now() });
    return logs;
  }

  private botcakeFetch(path: string, token: string, init?: RequestInit): Promise<unknown> {
    return this.schedule(async () => {
      const url = new URL(path, "https://botcake.io");
      url.searchParams.set("access_token", token);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let response: Response;
        try {
          response = await fetch(url, { ...init, cache: "no-store", credentials: "omit", signal: controller.signal });
        } catch (error) {
          if (attempt === 0) { await delay(500); continue; }
          throw new Error(controller.signal.aborted ? "Botcake 接口连接超时" : `Botcake 接口连接失败：${error instanceof Error ? error.message : String(error)}`);
        } finally { clearTimeout(timeout); }
        const text = await response.text();
        let body: unknown;
        try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
        if (response.ok) return body;
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 800);
          continue;
        }
        throw new Error(`Botcake 接口 ${response.status}：${typeof body === "string" ? body : JSON.stringify(body)}`);
      }
      throw new Error("Botcake 接口请求失败");
    });
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    return (async () => {
      await this.acquireRequestSlot();
      const startTurn = this.requestStartTail.then(async () => {
        const wait = Math.max(0, this.nextRequestAt - Date.now());
        if (wait) await delay(wait);
        this.nextRequestAt = Date.now() + REQUEST_START_GAP_MS;
      });
      this.requestStartTail = startTurn.then(() => undefined, () => undefined);
      try {
        await startTurn;
        return await task();
      } finally {
        this.releaseRequestSlot();
      }
    })();
  }

  private acquireRequestSlot(): Promise<void> {
    if (this.activeRequests < REQUEST_CONCURRENCY) {
      this.activeRequests += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.requestWaiters.push(() => {
      this.activeRequests += 1;
      resolve();
    }));
  }

  private releaseRequestSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.requestWaiters.shift()?.();
  }

  private clearCustomerCache(pageId: string): void {
    for (const key of this.customerCache.keys()) {
      if (key.startsWith(`v2:${pageId}:`)) this.customerCache.delete(key);
    }
  }
}

function requireAnalyticsPages(pages: AnalyticsPage[]): AnalyticsPage[] {
  if (!pages.length) throw new Error("专页目录接口没有返回可识别专页");
  return pages;
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try { return { status: "fulfilled", value: await promise }; }
  catch (reason) { return { status: "rejected", reason }; }
}

function blankTraffic(page: AnalyticsPage, startDate: string, endDate: string, previousStart: string, previousEnd: string): AnalyticsPageTraffic {
  return {
    page,
    todayHours: Array(24).fill(0),
    yesterdayHours: Array(24).fill(0),
    daily: enumerateIsoDates(startDate, endDate).map((date) => ({ date, count: 0 })),
    previousDaily: enumerateIsoDates(previousStart, previousEnd).map((date) => ({ date, count: 0 })),
    todayTotal: 0,
    yesterdayTotal: 0,
    rangeTotal: 0,
    previousRangeTotal: 0,
    gender: { female: 0, male: 0, unknown: 0 },
  };
}

function managedTokenSummary(record: AnalyticsManagedTokenRecord) {
  return {
    id: record.id,
    label: record.label,
    pageCount: record.pages.length,
    pages: record.pages,
    addedAt: record.addedAt,
  };
}

function validateDataRequest(request: DataRequest): void {
  assertTimezone(request.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(request.endDate) || request.startDate > request.endDate) throw new Error("统计日期范围不正确");
  if (daysBetween(request.startDate, request.endDate) > 365) throw new Error("一次最多统计 366 天");
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function fallbackPage(id: string): AnalyticsPage {
  return { id, name: `专页 ${id}`, avatarUrl: `https://graph.facebook.com/${id}/picture?type=small` };
}

function extractAnalyticsPages(value: unknown): AnalyticsPage[] {
  const pageMap = new Map<string, AnalyticsPage>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length && visited < 12_000) {
    const current = queue.shift()!;
    visited += 1;
    if (!current.value || typeof current.value !== "object" || current.depth > 8) continue;
    if (seen.has(current.value as object)) continue;
    seen.add(current.value as object);
    const page = toAnalyticsPage(current.value);
    if (page) pageMap.set(page.id, { ...pageMap.get(page.id), ...page });
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value as Record<string, unknown>);
    for (const child of children) if (child && typeof child === "object") queue.push({ value: child, depth: current.depth + 1 });
  }
  return [...pageMap.values()];
}

function toAnalyticsPage(value: unknown): AnalyticsPage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const hasPageMarker = "page_id" in record || "pageId" in record || "platform" in record || "role_in_page" in record || "page_ids" in record;
  if (!hasPageMarker) return undefined;
  const rawId = record.page_id ?? record.pageId ?? record.id;
  const rawName = record.page_name ?? record.pageName ?? record.name ?? record.title;
  if ((typeof rawId !== "string" && typeof rawId !== "number") || typeof rawName !== "string") return undefined;
  const id = String(rawId).replace(/^igo_/, "");
  if (!/^\d{8,}$/.test(id) || !rawName.trim()) return undefined;
  const platform = typeof record.platform === "string" ? record.platform : typeof record.type === "string" ? record.type : undefined;
  const avatarUrl = findPageAvatar(record) ?? (/facebook/i.test(platform ?? "") ? `https://graph.facebook.com/${id}/picture?type=small` : undefined);
  return { id, name: rawName.trim(), avatarUrl, platform };
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
  return undefined;
}

function normalizePageIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item).trim().match(/\d{8,}/)?.[0] ?? "").filter(Boolean))].slice(0, 500);
}

function normalizeAnalyticsPages(value: unknown): AnalyticsPage[] {
  if (!Array.isArray(value)) return [];
  const pages = new Map<string, AnalyticsPage>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<AnalyticsPage>;
    const id = String(record.id ?? "").match(/\d{8,}/)?.[0] ?? "";
    if (!id) continue;
    pages.set(id, {
      id,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : `专页 ${id}`,
      avatarUrl: typeof record.avatarUrl === "string" ? record.avatarUrl : `https://graph.facebook.com/${id}/picture?type=small`,
      platform: typeof record.platform === "string" ? record.platform : undefined,
    });
  }
  return [...pages.values()];
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((id) => expected.has(id));
}

function sameAnalyticsPages(left: AnalyticsPage[], right: AnalyticsPage[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(left.map((page) => [page.id, analyticsPageSignature(page)]));
  return right.every((page) => expected.get(page.id) === analyticsPageSignature(page));
}

function analyticsPageSignature(page: AnalyticsPage): string {
  return JSON.stringify([
    page.name,
    page.avatarUrl || `https://graph.facebook.com/${page.id}/picture?type=small`,
    page.platform || "",
  ]);
}

function normalizeExternalPageEntries(value: unknown): Array<{ pageId: string; token: string }> {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, { pageId: string; token: string }>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { pageId?: unknown; token?: unknown };
    const pageId = String(record.pageId ?? "").match(/\d{8,}/)?.[0] ?? "";
    const token = typeof record.token === "string" ? record.token.trim() : "";
    if (pageId && token.length >= 20 && !/\s/.test(token)) entries.set(pageId, { pageId, token });
  }
  return [...entries.values()];
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

function buildCustomerRangeFilter(startDate: string, endDate: string, timezone: string): CustomerRangeFilter {
  const start = zonedDateStartMilliseconds(startDate, timezone);
  const endExclusive = zonedDateStartMilliseconds(addAnalyticsDays(endDate, 1), timezone);
  return {
    unit: startDate === endDate ? "hour" : "day",
    startSeconds: Math.floor(start / 1000),
    // Botcake 的 ranger 使用闭区间；减一秒避免把次日零点算入当前范围。
    endSeconds: Math.floor(endExclusive / 1000) - 1,
  };
}

function zonedDateStartMilliseconds(date: string, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day);
  let guess = desiredAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const representedAsUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
    const correction = desiredAsUtc - representedAsUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

function extractTotalEntries(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  for (let visited = 0; queue.length && visited < 200; visited += 1) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current as object)) continue;
    seen.add(current as object);
    const record = current as Record<string, unknown>;
    // Botcake currently returns total_entries. Keep the two documented naming
    // variants as fallbacks, but do not accept a generic nested `count`: log,
    // gender and summary objects also contain count fields and would make the
    // customer page count silently wrong.
    for (const key of ["total_entries", "totalEntries", "total"]) {
      const numeric = Number(record[key]);
      if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
    }
    for (const child of Object.values(record)) if (child && typeof child === "object" && !Array.isArray(child)) queue.push(child);
  }
  return 0;
}

function batchSignature(batch: Record<string, unknown>[]): string {
  return `${String(batch[0]?.id ?? batch[0]?.psid ?? "")}:${String(batch.at(-1)?.id ?? batch.at(-1)?.psid ?? "")}:${batch.length}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
