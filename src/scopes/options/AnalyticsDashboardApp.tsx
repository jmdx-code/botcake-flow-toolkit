import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { parseAnalyticsTimestamp } from "../../core/traffic-analytics";
import type { BackgroundRequest, BackgroundResponse } from "../../shared/background-protocol";
import type {
  AnalyticsDirectoryData,
  AnalyticsLogEntry,
  AnalyticsPage,
  AnalyticsPageTraffic,
  AnalyticsManagedTokenSummary,
  AnalyticsTokenManagementResult,
  TrafficDashboardData,
} from "../../shared/types";
import "./analytics.css";

const DEFAULT_TIMEZONE = "Asia/Hong_Kong";
const MAX_SELECTED_PAGES = 12;
const ANALYTICS_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const ANALYTICS_DASHBOARD_STATE_KEY = "analyticsDashboardStateV1";
const DEMO_MODE = new URLSearchParams(location.search).get("demo") === "1";
const COMMON_TIMEZONES: Array<[string, string]> = [
  ["local", "本机时区"],
  ["Asia/Hong_Kong", "香港时间（GMT+8）"],
  ["Asia/Taipei", "台北时间（GMT+8）"],
  ["Asia/Shanghai", "北京时间（GMT+8）"],
  ["Asia/Singapore", "新加坡时间（GMT+8）"],
  ["Asia/Manila", "马尼拉时间（GMT+8）"],
  ["Asia/Kuala_Lumpur", "吉隆坡时间（GMT+8）"],
  ["Asia/Tokyo", "东京时间（GMT+9）"],
  ["Asia/Seoul", "首尔时间（GMT+9）"],
  ["Asia/Yangon", "缅甸时间（GMT+6:30）"],
  ["Asia/Bangkok", "曼谷时间（GMT+7）"],
  ["Asia/Ho_Chi_Minh", "胡志明市时间（GMT+7）"],
  ["Asia/Jakarta", "雅加达时间（GMT+7）"],
  ["Asia/Kolkata", "印度时间（GMT+5:30）"],
  ["Asia/Kathmandu", "尼泊尔时间（GMT+5:45）"],
  ["Asia/Dubai", "迪拜时间（GMT+4）"],
  ["UTC", "世界协调时间（GMT+0）"],
];

type StoredPreferences = {
  analyticsTimezone?: string;
  analyticsComparePrevious?: boolean;
  analyticsDashboardStateV1?: StoredDashboardState;
  analyticsRefreshTarget?: AnalyticsRefreshTarget;
};
type StoredDashboardState = {
  version: 1;
  selectedPageIds: string[];
  timezoneChoice: string;
  datePreset: DatePreset;
  customRange: { startDate: string; endDate: string };
  comparePrevious: boolean;
  pageIdSearch: string;
  logsOpen: boolean;
  logCode: string;
};
type AnalyticsRefreshTarget = { pageIds: string[]; timezone: string; startDate: string; endDate: string; comparePrevious: boolean };
type AnalyticsAutoRefreshResult = { target: AnalyticsRefreshTarget; data?: TrafficDashboardData; error?: string; completedAt: number };
type DatePreset = "today" | "yesterday" | "week" | "custom";
type MemoryCacheEntry<T> = { value: T; cachedAt: number };

export function AnalyticsDashboardApp() {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  const [timezoneChoice, setTimezoneChoice] = useState(DEFAULT_TIMEZONE);
  const [timezoneOptions, setTimezoneOptions] = useState<Array<[string, string]>>(() => [...COMMON_TIMEZONES]);
  const timezone = timezoneChoice === "local" ? localTimezone : timezoneChoice;
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const initialPeriod = useMemo(() => periodForPreset("today", timezone), []);
  const [customRange, setCustomRange] = useState(initialPeriod);
  const [comparePrevious, setComparePrevious] = useState(true);
  const [directory, setDirectory] = useState<AnalyticsPage[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState("");
  const [pageIdSearch, setPageIdSearch] = useState("");
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [pageData, setPageData] = useState<Record<string, AnalyticsPageTraffic>>({});
  const [loadingPages, setLoadingPages] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<AnalyticsLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [logsOpen, setLogsOpen] = useState(true);
  const [logCode, setLogCode] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [configTokens, setConfigTokens] = useState("");
  const [managedTokens, setManagedTokens] = useState<AnalyticsManagedTokenSummary[]>([]);
  const [tokenManagerLoading, setTokenManagerLoading] = useState(false);
  const [deletingTokenId, setDeletingTokenId] = useState("");
  const [configuring, setConfiguring] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const requestId = useRef(0);
  const forceInitialDataRefresh = useRef(false);
  const selectorListRef = useRef<HTMLDivElement>(null);
  const pageResultCache = useRef(new Map<string, MemoryCacheEntry<AnalyticsPageTraffic>>());
  const logsResultCache = useRef(new Map<string, MemoryCacheEntry<AnalyticsLogEntry[]>>());
  const presetRange = useMemo(() => periodForPreset(datePreset === "custom" ? "today" : datePreset, timezone), [datePreset, timezone]);
  const { startDate, endDate } = datePreset === "custom" ? customRange : presetRange;

  useEffect(() => { document.title = "Botcake 引流数据"; void initialize(); }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void buildTimezoneOptions().then((options) => {
        if (cancelled) return;
        setTimezoneOptions((current) => {
          const merged = [...options];
          for (const entry of current) if (!merged.some(([value]) => value === entry[0])) merged.push(entry);
          return merged;
        });
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const list = selectorListRef.current;
    if (!list) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const rawPixels = event.deltaMode === 1
        ? event.deltaY * 26
        : event.deltaMode === 2 ? event.deltaY * 38 : event.deltaY;
      const distance = Math.sign(rawPixels) * Math.min(38, Math.max(1, Math.abs(rawPixels) * .38));
      list.scrollTop += distance;
    };
    list.addEventListener("wheel", handleWheel, { passive: false });
    return () => list.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      const snapshot = changes.analyticsDirectorySnapshotV1?.newValue as AnalyticsDirectoryData | undefined;
      if (!snapshot || !Array.isArray(snapshot.pages)) return;
      setDirectory(snapshot.pages);
      const available = new Set(snapshot.pages.map((page) => page.id));
      setSelectedPageIds((current) => current.filter((id) => available.has(id)));
      setDirectoryError("");
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!selectedPageIds.length) {
      requestId.current += 1;
      setPageData({});
      setLoadingPages({});
      setLogs([]);
      setError("");
      setUpdatedAt("");
      return;
    }
    const forceRefresh = forceInitialDataRefresh.current;
    forceInitialDataRefresh.current = false;
    const timer = window.setTimeout(() => void refreshData(forceRefresh), 120);
    return () => window.clearTimeout(timer);
  }, [ready, timezoneChoice, timezone, startDate, endDate, comparePrevious, selectedPageIds.join(",")]);

  useEffect(() => {
    if (!ready || DEMO_MODE) return;
    const state: StoredDashboardState = {
      version: 1,
      selectedPageIds,
      timezoneChoice,
      datePreset,
      customRange,
      comparePrevious,
      pageIdSearch,
      logsOpen,
      logCode,
    };
    void chrome.storage.local.set({
      [ANALYTICS_DASHBOARD_STATE_KEY]: state,
      analyticsTimezone: timezoneChoice,
      analyticsComparePrevious: comparePrevious,
    });
  }, [ready, selectedPageIds.join(","), timezoneChoice, datePreset, customRange.startDate, customRange.endDate, comparePrevious, pageIdSearch, logsOpen, logCode]);

  useEffect(() => {
    if (!ready || DEMO_MODE) return;
    const target = selectedPageIds.length
      ? { pageIds: selectedPageIds, timezone, startDate, endDate, comparePrevious }
      : undefined;
    void sendBackground({ action: "setAnalyticsRefreshTarget", target }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [ready, timezone, startDate, endDate, comparePrevious, selectedPageIds.join(",")]);

  useEffect(() => {
    if (!ready || !selectedPageIds.length || DEMO_MODE) return;
    const expected = analyticsTargetSignature({ pageIds: selectedPageIds, timezone, startDate, endDate, comparePrevious });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      const result = changes.analyticsAutoRefreshResult?.newValue as AnalyticsAutoRefreshResult | undefined;
      if (!result || analyticsTargetSignature(result.target) !== expected) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      if (!result.data) return;
      requestId.current += 1;
      for (const page of result.data.pages) {
        pageResultCache.current.set(pageResultSignature(page.page.id, result.target), { value: page, cachedAt: result.completedAt });
      }
      logsResultCache.current.set(logsResultSignature(result.target.pageIds), { value: result.data.logs, cachedAt: result.completedAt });
      setPageData(Object.fromEntries(result.data.pages.map((page) => [page.page.id, page])));
      setLogs(result.data.logs);
      setLoadingPages({});
      setError("");
      setUpdatedAt(formatTime(result.data.fetchedAt, timezone));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [ready, timezone, startDate, endDate, comparePrevious, selectedPageIds.join(",")]);

  async function initialize() {
    if (DEMO_MODE) {
      setDirectory(DEMO_PAGES);
      setDirectoryLoading(false);
      setReady(true);
      return;
    }
    try {
      const stored = await chrome.storage.local.get([ANALYTICS_DASHBOARD_STATE_KEY, "analyticsTimezone", "analyticsComparePrevious", "analyticsRefreshTarget"]) as StoredPreferences;
      const savedState = normalizeStoredDashboardState(stored.analyticsDashboardStateV1)
        ?? dashboardStateFromRefreshTarget(stored.analyticsRefreshTarget);
      const nextChoice = savedState?.timezoneChoice || stored.analyticsTimezone || DEFAULT_TIMEZONE;
      const nextTimezone = nextChoice === "local" ? localTimezone : nextChoice;
      setTimezoneChoice(nextChoice);
      if (!COMMON_TIMEZONES.some(([value]) => value === nextChoice)) {
        setTimezoneOptions((current) => current.some(([value]) => value === nextChoice)
          ? current
          : [...current, timezoneOption(nextChoice)]);
      }
      setComparePrevious(savedState?.comparePrevious ?? (stored.analyticsComparePrevious !== false));
      if (savedState) {
        setDatePreset(savedState.datePreset);
        setCustomRange(savedState.customRange);
        setPageIdSearch(savedState.pageIdSearch);
        setLogsOpen(savedState.logsOpen);
        setLogCode(savedState.logCode);
      }
      const pages = await loadDirectoryWithSingleRetry();
      if (savedState) {
        const available = new Set(pages.map((page) => page.id));
        const restoredIds = (pages.length
          ? savedState.selectedPageIds.filter((id) => available.has(id))
          : savedState.selectedPageIds).slice(0, MAX_SELECTED_PAGES);
        setSelectedPageIds(restoredIds);
        forceInitialDataRefresh.current = restoredIds.length > 0;
      }
    } catch (reason) {
      setDirectoryError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReady(true);
      setDirectoryLoading(false);
    }
  }

  async function loadDirectoryWithSingleRetry(forceRefresh = false): Promise<AnalyticsPage[]> {
    setDirectoryLoading(true);
    setDirectoryError("");
    try {
      let result: AnalyticsDirectoryData;
      try {
        result = await callBackground<AnalyticsDirectoryData>({ action: "getAnalyticsDirectory", forceRefresh });
        if (!result.pages.length && !forceRefresh) throw new Error("Botcake 暂时返回空的专页目录");
      } catch (firstError) {
        if (forceRefresh) throw firstError;
        // 页面刚切换、令牌刚写入或旧空缓存均可能使第一次失败；最多补偿重试一次。
        result = await callBackground<AnalyticsDirectoryData>({ action: "getAnalyticsDirectory", forceRefresh: true });
      }
      setDirectory(result.pages);
      if (!result.pages.length) setDirectoryError("Botcake 返回了空的专页目录，请确认当前账号已有专页权限");
      return result.pages;
    } catch (reason) {
      setDirectory([]);
      setDirectoryError(reason instanceof Error ? reason.message : String(reason));
      return [];
    } finally {
      setDirectoryLoading(false);
    }
  }

  async function refreshData(forceRefresh: boolean) {
    const currentRequest = ++requestId.current;
    const target = { pageIds: selectedPageIds, timezone, startDate, endDate, comparePrevious };
    const cachedAtValues: number[] = [];
    const cachedPages: Record<string, AnalyticsPageTraffic> = {};
    const pendingPageIds = selectedPageIds.filter((pageId) => {
      if (forceRefresh) return true;
      const cached = readFreshMemoryCache(pageResultCache.current, pageResultSignature(pageId, target));
      if (!cached) return true;
      cachedPages[pageId] = cached.value;
      cachedAtValues.push(cached.cachedAt);
      return false;
    });
    setLoadingPages(Object.fromEntries(selectedPageIds.map((id) => [id, pendingPageIds.includes(id)])));
    setPageData(cachedPages);
    setError("");
    setLogsError("");
    const logsKey = logsResultSignature(selectedPageIds);
    const cachedLogs = forceRefresh ? undefined : readFreshMemoryCache(logsResultCache.current, logsKey);
    if (cachedLogs) {
      setLogs(cachedLogs.value);
      setLogsLoading(false);
      cachedAtValues.push(cachedLogs.cachedAt);
    } else {
      setLogs([]);
      setLogsLoading(true);
    }
    if (DEMO_MODE) {
      await Promise.all(pendingPageIds.map(async (pageId, index) => {
        await new Promise((resolve) => window.setTimeout(resolve, forceRefresh ? 180 + index * 90 : 80 + index * 55));
        if (currentRequest !== requestId.current) return;
        const page = DEMO_PAGES.find((item) => item.id === pageId) ?? { id: pageId, name: `专页 ${pageId}` };
        const value = demoTraffic(page, startDate, endDate);
        pageResultCache.current.set(pageResultSignature(pageId, target), { value, cachedAt: Date.now() });
        setPageData((current) => ({ ...current, [pageId]: value }));
        setLoadingPages((current) => ({ ...current, [pageId]: false }));
      }));
      if (currentRequest !== requestId.current) return;
      if (!cachedLogs) {
        const value = DEMO_LOGS.filter((log) => selectedPageIds.includes(log.page.id));
        logsResultCache.current.set(logsKey, { value, cachedAt: Date.now() });
        setLogs(value);
      }
      setLogsLoading(false);
      setUpdatedAt("模拟数据");
      return;
    }
    const pageTasks = pendingPageIds.map(async (pageId) => {
      try {
        const result = await callBackground<AnalyticsPageTraffic>({
          action: "getAnalyticsPageData", pageId, timezone, startDate, endDate, comparePrevious, forceRefresh,
        });
        if (currentRequest !== requestId.current) return;
        pageResultCache.current.set(pageResultSignature(pageId, target), { value: result, cachedAt: Date.now() });
        setPageData((current) => ({ ...current, [pageId]: result }));
      } catch (reason) {
        if (currentRequest !== requestId.current) return;
        const page = directory.find((item) => item.id === pageId) ?? { id: pageId, name: `专页 ${pageId}` };
        setPageData((current) => ({ ...current, [pageId]: failedPageData(page, startDate, endDate, reason) }));
      } finally {
        if (currentRequest === requestId.current) setLoadingPages((current) => ({ ...current, [pageId]: false }));
      }
    });
    const logsTask = cachedLogs ? Promise.resolve() : callBackground<AnalyticsLogEntry[]>({ action: "getAnalyticsLogs", pageIds: selectedPageIds, forceRefresh })
      .then((result) => {
        if (currentRequest !== requestId.current) return;
        logsResultCache.current.set(logsKey, { value: result, cachedAt: Date.now() });
        setLogs(result);
      })
      .catch((reason) => {
        if (currentRequest !== requestId.current) return;
        setLogs([]);
        setLogsError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (currentRequest === requestId.current) setLogsLoading(false); });
    await Promise.allSettled([...pageTasks, logsTask]);
    if (currentRequest !== requestId.current) return;
    const usedOnlyMemoryCache = pendingPageIds.length === 0 && Boolean(cachedLogs);
    const displayTimestamp = usedOnlyMemoryCache && cachedAtValues.length
      ? Math.min(...cachedAtValues)
      : Date.now();
    setUpdatedAt(formatTime(new Date(displayTimestamp).toISOString(), timezone));
  }

  function togglePage(id: string) {
    setError("");
    setSelectedPageIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_SELECTED_PAGES) {
        setError(`最多同时显示 ${MAX_SELECTED_PAGES} 个专页`);
        return current;
      }
      return [...current, id];
    });
  }

  function applyTokenManagementResult(result: AnalyticsTokenManagementResult) {
    setManagedTokens(result.tokens);
    setDirectory(result.pages);
    const available = new Set(result.pages.map((page) => page.id));
    setSelectedPageIds((current) => current.filter((id) => available.has(id)));
    pageResultCache.current.clear();
    logsResultCache.current.clear();
  }

  async function openTokenManager() {
    setConfigOpen(true);
    setConfigMessage("");
    if (DEMO_MODE) return;
    setTokenManagerLoading(true);
    try {
      const result = await callBackground<AnalyticsTokenManagementResult>({ action: "getAnalyticsManagedTokens" });
      applyTokenManagementResult(result);
    } catch (reason) {
      setConfigMessage(reason instanceof Error ? reason.message : String(reason));
    } finally { setTokenManagerLoading(false); }
  }

  async function configurePages() {
    if (DEMO_MODE) { setConfigMessage("模拟预览模式不会保存 Token 配置"); return; }
    const tokens = parseTokenEntries(configTokens);
    if (!tokens.length) { setConfigMessage("没有识别到有效 Token，请每行输入一个 Token"); return; }
    setConfiguring(true);
    setConfigMessage("正在验证 Token 并扫描有权限专页…");
    try {
      const result = await callBackground<AnalyticsTokenManagementResult>({ action: "addAnalyticsManagedTokens", tokens });
      applyTokenManagementResult(result);
      setConfigTokens("");
      setConfigMessage(result.failed.length
        ? `已保存 ${result.added.length} 个 Token；${result.failed.length} 个无效、过期或没有专页权限`
        : `已保存 ${result.added.length} 个 Token，并同步有权限专页`);
    } catch (reason) {
      setConfigMessage(reason instanceof Error ? reason.message : String(reason));
    } finally { setConfiguring(false); }
  }

  async function removeManagedToken(tokenId: string) {
    if (DEMO_MODE) { setConfigMessage("模拟预览模式不会删除 Token"); return; }
    setDeletingTokenId(tokenId);
    setConfigMessage("正在删除 Token 并重新计算专页权限…");
    try {
      const result = await callBackground<AnalyticsTokenManagementResult>({ action: "removeAnalyticsManagedToken", tokenId });
      applyTokenManagementResult(result);
      setConfigMessage("Token 已删除；仅由该 Token 授权的专页已从列表移除");
    } catch (reason) {
      setConfigMessage(reason instanceof Error ? reason.message : String(reason));
    } finally { setDeletingTokenId(""); }
  }

  const hourlyMode = startDate === endDate;
  const filteredLogs = useMemo(() => {
    const keyword = logCode.trim().toLowerCase();
    return logs.filter((log) => !keyword
      || `${log.code} ${log.subcode} ${log.description} ${log.page.name}`.toLowerCase().includes(keyword));
  }, [logs, logCode]);
  const activePageLoads = Object.values(loadingPages).filter(Boolean).length;
  const visibleDirectory = useMemo(() => {
    const query = pageIdSearch.trim();
    return query ? directory.filter((page) => page.id.includes(query)) : directory;
  }, [directory, pageIdSearch]);

  function selectPreset(value: DatePreset) {
    setDatePreset(value);
    if (value !== "custom") setCustomRange(periodForPreset(value, timezone));
  }

  function updateCustomRange(field: "startDate" | "endDate", value: string) {
    setDatePreset("custom");
    setCustomRange((current) => {
      const next = { ...current, [field]: value };
      if (next.startDate > next.endDate) {
        if (field === "startDate") next.endDate = value;
        else next.startDate = value;
      }
      return next;
    });
  }

  return <div id="traffic-v3" className="analytics-app">
    <header className="filters-shell">
      <section className="page-selector" aria-label="专页选择">
        <div className="selector-head">
          <span>选择统计专页 <b>{selectedPageIds.length} / {MAX_SELECTED_PAGES}</b></span>
          <label className="selector-search"><DashboardIcon name="search" /><input value={pageIdSearch} onChange={(event) => setPageIdSearch(event.target.value)} inputMode="numeric" placeholder="搜索专页 ID" aria-label="按专页 ID 搜索" /></label>
          <button type="button" disabled={!selectedPageIds.length} onClick={() => setSelectedPageIds([])}>取消已选</button>
        </div>
        <div ref={selectorListRef} className="selector-list" role="listbox" aria-label="专页列表">{visibleDirectory.map((page) => {
            const checked = selectedPageIds.includes(page.id);
            const disabled = !checked && selectedPageIds.length >= MAX_SELECTED_PAGES;
            return <label key={page.id} className={`selector-item ${checked ? "selected" : ""} ${disabled ? "disabled" : ""}`}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => togglePage(page.id)} />
              <PageAvatar page={page} /><span><strong>{page.name}</strong><small>{page.id}</small></span><DashboardIcon name="check" />
            </label>;
          })}{!visibleDirectory.length && <div className={`directory-empty ${directoryError ? "has-error" : ""}`}>
            <span>{pageIdSearch.trim() && directory.length ? "没有匹配此 ID 的专页" : directoryLoading ? "正在读取 Botcake 专页列表…" : directoryError || "没有读取到专页"}</span>
            {!pageIdSearch.trim() && !directoryLoading && <button type="button" onClick={() => void loadDirectoryWithSingleRetry(true)}>重新读取</button>}
          </div>}</div>
      </section>

      <section className="date-controls" data-preset={datePreset} aria-label="统计范围">
        <div className="control-row date-row">
          <label className="period-field"><span>统计日期</span><select value={datePreset} onChange={(event) => selectPreset(event.target.value as DatePreset)}><option value="today">今日</option><option value="yesterday">昨日</option><option value="week">近一周</option><option value="custom">自定义</option></select></label>
          <div className="date-range"><input type="date" value={startDate} onChange={(event) => updateCustomRange("startDate", event.target.value)} aria-label="开始日期" /><b>至</b><input type="date" value={endDate} onChange={(event) => updateCustomRange("endDate", event.target.value)} aria-label="结束日期" /></div>
        </div>
        <div className="control-row">
          <label className="timezone-field"><span>时区</span><select value={timezoneChoice} onChange={(event) => setTimezoneChoice(event.target.value)}>{timezoneOptions.map(([value, label]) => <option key={value} value={value}>{value === "local" ? `${label}（${localTimezone.replaceAll("_", " ")}，${formatGmtOffset(localTimezone)}）` : label}</option>)}</select></label>
          <label className="compare-switch"><input type="checkbox" checked={comparePrevious} onChange={(event) => setComparePrevious(event.target.checked)} /><span className="switch-track" /><span>显示上一周期</span></label>
        </div>
      </section>

      <section className="permission-control">
        <button type="button" onClick={() => void openTokenManager()}><DashboardIcon name="key" /><span>Token 管理</span></button>
        <p><span className={activePageLoads > 0 ? "active" : selectedPageIds.length ? "ready" : ""} />{activePageLoads > 0
          ? `已选 ${selectedPageIds.length} 个，正在读取 ${activePageLoads} 个`
          : selectedPageIds.length ? `已选择 ${selectedPageIds.length} 个专页${updatedAt ? ` · ${updatedAt}` : ""}` : "尚未选择专页"}</p>
      </section>
    </header>

    <main className="analytics-content">
      {error && <div className="analytics-notice error">{error}</div>}
      {!selectedPageIds.length
      ? <section className="empty-panel"><span className="empty-icon" aria-hidden="true"><DashboardIcon name="pointer" /></span><div><strong>请选择专页</strong><p>勾选后立即显示数据面板，无需确认。</p></div></section>
      : <section className="page-panels" data-count={selectedPageIds.length}>
        {selectedPageIds.map((id) => pageData[id]
          ? <PageStatPanel key={id} item={pageData[id]} hourlyMode={hourlyMode} datePreset={datePreset} comparePrevious={comparePrevious} />
          : <PagePanelSkeleton key={id} page={directory.find((page) => page.id === id)} />)}
      </section>}

    {!!selectedPageIds.length && <section className={`logs-panel ${logsOpen ? "open" : ""}`}>
      <header><div><span className="warning-icon" aria-hidden="true"><DashboardIcon name="warning" /></span><div><h2>最近3天错误日志</h2><p>{logsLoading ? "正在后台读取，不影响上方统计" : logsError ? `读取失败：${shortText(logsError, 90)}` : logs.length ? `${logs.length} 条错误，按最新时间排列` : "暂未读取到错误"}</p></div></div><div className="log-tools"><label><DashboardIcon name="search" /><input value={logCode} onChange={(event) => setLogCode(event.target.value)} placeholder="筛选错误代码、说明或专页" /></label><button type="button" title={logsOpen ? "收起" : "展开"} onClick={() => setLogsOpen((value) => !value)}><DashboardIcon name={logsOpen ? "chevron-up" : "chevron-down"} /></button></div></header>
      {logsOpen && <div className="logs-table-wrap"><table><thead><tr><th>专页</th><th>错误代码</th><th>错误说明</th><th className="right">次数</th><th>最新时间</th></tr></thead><tbody>{filteredLogs.map((log, index) => <LogRow key={`${log.page.id}-${log.id ?? index}-${log.updatedAt}`} log={log} timezone={timezone} />)}</tbody></table>{!filteredLogs.length && <div className="empty-state">{logsLoading ? "正在读取日志…" : logsError ? "日志读取失败，请稍后重试" : "没有符合条件的错误记录"}</div>}</div>}
    </section>}
    </main>

    {configOpen && <div className="config-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfigOpen(false); }}><section className="config-dialog token-manager-dialog" role="dialog" aria-modal="true" aria-label="Token 管理">
      <header><div><h2>Token 管理</h2><p>每个 Token 会自动扫描其有权限的专页；多个 Token 的专页权限会合并。</p></div><button type="button" onClick={() => setConfigOpen(false)}>×</button></header>
      <div className="token-manager-body">
        <section className="token-entry"><strong>添加 Token</strong><textarea value={configTokens} onChange={(event) => setConfigTokens(event.target.value)} placeholder={'每行粘贴一个 Token\n无需填写专页 ID'} /><p>Token 验证后会加密持久化；界面只显示末尾四位。</p></section>
        <section className="managed-token-section"><div className="managed-token-head"><strong>已保存 Token</strong><span>{tokenManagerLoading ? "正在读取…" : `${managedTokens.length} 个`}</span></div><div className="managed-token-list">
          {managedTokens.map((token) => <article key={token.id} className="managed-token-item"><div><strong>{token.label}</strong><span>{token.pageCount} 个专页</span><small title={token.pages.map((page) => `${page.name} (${page.id})`).join("\n")}>{token.pages.slice(0, 3).map((page) => page.name).join("、")}{token.pages.length > 3 ? ` 等 ${token.pages.length} 个` : ""}</small></div><button type="button" disabled={Boolean(deletingTokenId)} onClick={() => void removeManagedToken(token.id)}>{deletingTokenId === token.id ? "删除中…" : "删除"}</button></article>)}
          {!tokenManagerLoading && !managedTokens.length && <div className="managed-token-empty">尚未保存 Token</div>}
        </div></section>
      </div>
      <p className="config-hint">删除 Token 后会立即重新计算权限；其他 Token 或当前登录账号仍有权限的专页会继续保留。</p>
      {configMessage && <div className="config-message">{configMessage}</div>}
      <footer><button type="button" className="secondary-action" onClick={() => setConfigOpen(false)}>关闭</button><button type="button" className="primary-action" disabled={configuring || !configTokens.trim()} onClick={() => void configurePages()}>{configuring ? "正在扫描专页…" : "应用 Token"}</button></footer>
    </section></div>}
  </div>;

}

function PageStatPanel({ item, hourlyMode, datePreset, comparePrevious }: {
  item: TrafficDashboardData["pages"][number]; hourlyMode: boolean; datePreset: DatePreset; comparePrevious: boolean;
}) {
  const gender = item.gender ?? { female: 0, male: 0, unknown: 0 };
  const knownGender = gender.female + gender.male;
  const femaleRate = knownGender ? Math.round(gender.female / knownGender * 100) : 0;
  const maleRate = knownGender ? 100 - femaleRate : 0;
  const delta = item.rangeTotal - (item.previousRangeTotal ?? item.yesterdayTotal);
  const sameTimeDelta = item.previousToCurrentTimeTotal === undefined ? undefined : item.rangeTotal - item.previousToCurrentTimeTotal;
  const chartData = hourlyMode
    ? Array.from({ length: 24 }, (_, hour) => ({ label: String(hour), 当前: item.todayHours[hour] ?? 0, 上周期: item.yesterdayHours[hour] ?? 0 }))
    : item.daily.map((point, index) => ({ label: point.date.slice(5).replace("-", "/"), 当前: point.count, 上周期: item.previousDaily?.[index]?.count ?? 0 }));
  const currentLabel = datePreset === "today" ? "今日" : datePreset === "yesterday" ? "昨日" : datePreset === "week" ? "本周" : "当前周期";
  const previousLabel = datePreset === "today" ? "昨日" : datePreset === "yesterday" ? "前日" : datePreset === "week" ? "上周" : "上一周期";
  return <article className={`page-panel ${item.error ? "has-error" : ""}`}>
    <header className="page-summary">
      <div className="page-identity"><PageAvatar page={item.page} /><div className="page-title"><strong>{item.page.name}</strong><small>ID：{item.page.id}</small></div></div>
      <div className="page-total"><div className="page-total-main"><strong>{item.rangeTotal}</strong>{datePreset === "today" && comparePrevious && sameTimeDelta !== undefined && <span className={`same-time-delta ${sameTimeDelta > 0 ? "up" : sameTimeDelta < 0 ? "down" : "flat"}`} title={`昨日同时刻 ${item.previousToCurrentTimeTotal}，${sameTimeDelta > 0 ? "上升" : sameTimeDelta < 0 ? "下降" : "持平"} ${Math.abs(sameTimeDelta)}`}><i>{sameTimeDelta > 0 ? "↑" : sameTimeDelta < 0 ? "↓" : "—"}</i>{Math.abs(sameTimeDelta)}</span>}</div>{datePreset !== "today" && comparePrevious && <span className={`period-delta ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}`}>较上一周期 <b>{delta > 0 ? "+" : ""}{delta}</b>{delta > 0 ? <i>↑</i> : delta < 0 ? <i>↓</i> : null}</span>}</div>
      {!item.error && <div className="gender-summary"><div className="donut" style={{ "--female": `${femaleRate}%` } as CSSProperties} /><div className="gender-copy"><div className="gender-line"><i className="female" /><strong>{femaleRate}%</strong>女性 {gender.female}人</div><div className="gender-line"><i className="male" /><strong>{maleRate}%</strong>男性 {gender.male}人</div></div></div>}
    </header>
    <section className="chart-section"><div className="chart-head"><strong>{hourlyMode ? "每小时引流" : "每日引流"}</strong><div className="legend"><span>{currentLabel}</span>{comparePrevious && <span className="previous">{previousLabel}</span>}</div></div>
    {item.error ? <div className="panel-error">读取失败：{shortText(item.error, 120)}</div> : <>
      <div className="page-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 28, right: 12, left: 0, bottom: 0 }}><CartesianGrid vertical={false} stroke="#e7edef" /><XAxis dataKey="label" tick={false} tickLine={false} axisLine={false} height={8} /><YAxis width={36} allowDecimals={false} domain={[0, "auto"]} tickCount={5} tick={{ fill: "#526975", fontSize: 14, fontWeight: 600 }} axisLine={false} tickLine={false} /><Tooltip content={<TrafficTooltip hourlyMode={hourlyMode} />} cursor={{ stroke: "#07827b", strokeWidth: 1.5, strokeDasharray: "5 4" }} /><Area type="linear" dataKey="当前" stroke="#11a49a" strokeWidth={3.1} fill="#11a49a" fillOpacity={0.34} dot={{ r: 3, fill: "#fff", stroke: "#11a49a", strokeWidth: 2 }} activeDot={{ r: 6, fill: "#fff", stroke: "#11a49a", strokeWidth: 3 }} isAnimationActive={false}><LabelList dataKey="当前" content={(props) => <ChartValueLabel {...props} kind="current" />} /></Area>{comparePrevious && <Line type="linear" dataKey="上周期" stroke="#ec8b36" strokeWidth={1.8} strokeOpacity={0.48} dot={{ r: 2.5, fill: "#fff", stroke: "#ec8b36", strokeWidth: 1.5, opacity: .52 }} activeDot={{ r: 5, fill: "#fff", stroke: "#ec8b36", strokeWidth: 2.5, opacity: .72 }} isAnimationActive={false}><LabelList dataKey="上周期" content={(props) => <ChartValueLabel {...props} kind="previous" />} /></Line>}</AreaChart></ResponsiveContainer></div>
      <div className={`time-axis ${hourlyMode ? "" : "week"}`} style={{ "--axis-columns": chartData.length } as CSSProperties}>{chartData.map((point) => <span key={point.label}>{point.label}{hourlyMode && <small>h</small>}</span>)}</div>
    </>}</section>
  </article>;
}

type ChartLabelProps = { x?: number | string; y?: number | string; width?: number | string; value?: unknown; kind: "current" | "previous" };
function ChartValueLabel({ x = 0, y = 0, width = 0, value = 0, kind }: ChartLabelProps) {
  const numeric = Number(value);
  if (!numeric) return null;
  const centerX = Number(x) + Number(width) / 2;
  const boxY = kind === "current" ? Math.max(2, Number(y) - 23) : Number(y) + 7;
  return <g aria-hidden="true"><rect className={`value-box-${kind}`} x={centerX - 9} y={boxY} width={18} height={16} rx={4} /><text className={`value-${kind}`} x={centerX} y={boxY + 11.5} textAnchor="middle">{numeric}</text></g>;
}

function TrafficTooltip({ active, label, payload, hourlyMode }: { active?: boolean; label?: string; payload?: Array<{ dataKey?: string; value?: number; color?: string }>; hourlyMode: boolean }) {
  if (!active || !payload?.length) return null;
  const current = payload.find((entry) => entry.dataKey === "当前")?.value ?? 0;
  const previous = payload.find((entry) => entry.dataKey === "上周期")?.value;
  const interval = hourlyMode ? `${label}–${Number(label) + 1}h` : label;
  return <div className="chart-tooltip-react"><strong>{interval}</strong><span><i />当前周期<b>{current}</b></span>{previous !== undefined && <span className="previous"><i />上一周期<b>{previous}</b></span>}</div>;
}

type DashboardIconName = "check" | "key" | "pointer" | "warning" | "search" | "chevron-up" | "chevron-down";
function DashboardIcon({ name }: { name: DashboardIconName }) {
  const paths: Record<DashboardIconName, ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8-8M15 8l2 2m-5-5 2 2" /></>,
    pointer: <><path d="M14 4.1 12 2m5.9 4 2.1-.7M6.2 10.3 4 11m3.8-4.8L6.3 4.7" /><path d="m9 9 6.2 11 1.8-5 5-1.8Z" /></>,
    warning: <><path d="M10.3 2.8 2.1 17a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3L13.7 2.8a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    "chevron-up": <path d="m18 15-6-6-6 6" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function PagePanelSkeleton({ page }: { page?: AnalyticsPage }) { return <article className="page-panel skeleton-panel"><header className="page-summary"><div className="page-identity"><PageAvatar page={page ?? { id: "", name: "专页" }} /><div className="page-title"><strong>{page?.name ?? "正在读取专页"}</strong><small>{page?.id}</small></div></div><span className="panel-loading">读取中</span></header><div className="skeleton-chart"><span /><span /><span /><span /></div></article>; }
function PageAvatar({ page }: { page: AnalyticsPage }) { return page.avatarUrl ? <img className="page-avatar" src={page.avatarUrl} alt="" /> : <span className="page-avatar fallback">{page.name.trim().slice(0, 1).toUpperCase()}</span>; }
function LogRow({ log, timezone }: { log: AnalyticsLogEntry; timezone: string }) { return <tr><td><div className="log-page"><PageAvatar page={log.page} /><span><strong>{log.page.name}</strong><small>ID：{log.page.id}</small></span></div></td><td><code className={log.code !== "-" ? "danger" : ""}>{log.code}{log.subcode !== "-" ? ` / ${log.subcode}` : ""}</code></td><td title={log.description}>{log.description}</td><td className="right"><strong>{log.count}</strong></td><td>{formatTime(log.updatedAt, timezone)}</td></tr>; }

async function callBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse>(request);
  if (!response?.ok) throw new Error(response?.error ?? "插件后台没有响应");
  if (!("value" in response)) throw new Error("插件后台没有返回数据");
  return response.value as T;
}

async function sendBackground(request: BackgroundRequest): Promise<void> {
  const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse>(request);
  if (!response?.ok) throw new Error(response?.error ?? "插件后台没有响应");
}

function analyticsTargetSignature(target: AnalyticsRefreshTarget): string {
  return JSON.stringify([[...target.pageIds].sort(), target.timezone, target.startDate, target.endDate, target.comparePrevious]);
}

function pageResultSignature(pageId: string, target: AnalyticsRefreshTarget): string {
  return JSON.stringify([pageId, target.timezone, target.startDate, target.endDate, target.comparePrevious]);
}

function logsResultSignature(pageIds: string[]): string {
  return JSON.stringify([...pageIds].sort());
}

function readFreshMemoryCache<T>(cache: Map<string, MemoryCacheEntry<T>>, key: string): MemoryCacheEntry<T> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt < ANALYTICS_RESULT_CACHE_TTL_MS) return entry;
  cache.delete(key);
  return undefined;
}

function periodForPreset(preset: DatePreset, timezone: string): { startDate: string; endDate: string } {
  const today = dateInTimezone(Date.now(), timezone);
  if (preset === "yesterday") { const yesterday = addDays(today, -1); return { startDate: yesterday, endDate: yesterday }; }
  if (preset === "week") return { startDate: addDays(today, -6), endDate: today };
  return { startDate: today, endDate: today };
}

function failedPageData(page: AnalyticsPage, startDate: string, endDate: string, reason: unknown): AnalyticsPageTraffic {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  return {
    page, todayHours: Array(24).fill(0), yesterdayHours: Array(24).fill(0),
    daily: dates.map((date) => ({ date, count: 0 })), todayTotal: 0, yesterdayTotal: 0,
    rangeTotal: 0, previousRangeTotal: 0, gender: { female: 0, male: 0, unknown: 0 },
    error: reason instanceof Error ? reason.message : String(reason),
  };
}

async function buildTimezoneOptions(): Promise<Array<[string, string]>> {
  const common = new Set(COMMON_TIMEZONES.map(([value]) => value));
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const supported = supportedValuesOf?.("timeZone") ?? [];
  const remaining: Array<{ value: string; offset: number; label: string }> = [];
  const values = supported.filter((value) => !common.has(value));
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const offset = timezoneOffsetMinutes(value);
    remaining.push({ value, offset, label: `${localizedTimezoneName(value)}（${formatGmtOffsetMinutes(offset)}）` });
    if (index > 0 && index % 12 === 0) await yieldToBrowser();
  }
  remaining.sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label, "zh-CN"));
  return [...COMMON_TIMEZONES, ...remaining.map(({ value, label }): [string, string] => [value, label])];
}

function timezoneOption(timezone: string): [string, string] {
  return [timezone, `${localizedTimezoneName(timezone)}（${formatGmtOffset(timezone)}）`];
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

const TIMEZONE_REGION_NAMES: Record<string, string> = {
  Africa: "非洲", America: "美洲", Antarctica: "南极洲", Arctic: "北极地区", Asia: "亚洲",
  Atlantic: "大西洋", Australia: "澳洲", Europe: "欧洲", Indian: "印度洋", Pacific: "太平洋",
};

function localizedTimezoneName(timezone: string): string {
  const [region, ...location] = timezone.split("/");
  const localizedRegion = TIMEZONE_REGION_NAMES[region] ?? region;
  return location.length ? `${localizedRegion} · ${location.join(" / ").replaceAll("_", " ")}` : localizedRegion;
}

function formatGmtOffset(timezone: string): string {
  return formatGmtOffsetMinutes(timezoneOffsetMinutes(timezone));
}

function formatGmtOffsetMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `GMT${sign}${hours}${remainder ? `:${String(remainder).padStart(2, "0")}` : ""}`;
}

const timezoneOffsetCache = new Map<string, number>();

function timezoneOffsetMinutes(timezone: string): number {
  const cached = timezoneOffsetCache.get(timezone);
  if (cached !== undefined) return cached;
  try {
    const offsetName = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = offsetName.match(/^GMT([+-])(\d{1,2}):(\d{2})$/);
    if (!match) { timezoneOffsetCache.set(timezone, 0); return 0; }
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    const result = match[1] === "-" ? -minutes : minutes;
    timezoneOffsetCache.set(timezone, result);
    return result;
  } catch {
    timezoneOffsetCache.set(timezone, 0);
    return 0;
  }
}

function normalizeStoredDashboardState(value: unknown): StoredDashboardState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Partial<StoredDashboardState>;
  if (state.version !== 1 || typeof state.timezoneChoice !== "string" || !isDatePreset(state.datePreset)) return undefined;
  const selectedPageIds = Array.isArray(state.selectedPageIds)
    ? [...new Set(state.selectedPageIds.map(String).filter((id) => /^\d{8,}$/.test(id)))].slice(0, MAX_SELECTED_PAGES)
    : [];
  let today: string;
  try {
    today = dateInTimezone(Date.now(), state.timezoneChoice === "local"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE
      : state.timezoneChoice);
  } catch { return undefined; }
  const range = state.customRange;
  const validRange = Boolean(range && isIsoDate(range.startDate) && isIsoDate(range.endDate) && range.startDate <= range.endDate);
  return {
    version: 1,
    selectedPageIds,
    timezoneChoice: state.timezoneChoice,
    datePreset: state.datePreset,
    customRange: validRange ? { startDate: range!.startDate, endDate: range!.endDate } : { startDate: today, endDate: today },
    comparePrevious: state.comparePrevious !== false,
    pageIdSearch: typeof state.pageIdSearch === "string" ? state.pageIdSearch.slice(0, 64) : "",
    logsOpen: state.logsOpen !== false,
    logCode: typeof state.logCode === "string" ? state.logCode.slice(0, 120) : "",
  };
}

function dashboardStateFromRefreshTarget(value: unknown): StoredDashboardState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const target = value as Partial<AnalyticsRefreshTarget>;
  if (!Array.isArray(target.pageIds) || typeof target.timezone !== "string"
    || !isIsoDate(target.startDate) || !isIsoDate(target.endDate) || target.startDate > target.endDate) return undefined;
  let today: string;
  try { today = dateInTimezone(Date.now(), target.timezone); }
  catch { return undefined; }
  const yesterday = addDays(today, -1);
  const datePreset: DatePreset = target.startDate === today && target.endDate === today
    ? "today"
    : target.startDate === yesterday && target.endDate === yesterday
      ? "yesterday"
      : target.startDate === addDays(today, -6) && target.endDate === today ? "week" : "custom";
  return {
    version: 1,
    selectedPageIds: [...new Set(target.pageIds.map(String).filter((id) => /^\d{8,}$/.test(id)))].slice(0, MAX_SELECTED_PAGES),
    timezoneChoice: target.timezone,
    datePreset,
    customRange: { startDate: target.startDate, endDate: target.endDate },
    comparePrevious: target.comparePrevious !== false,
    pageIdSearch: "",
    logsOpen: true,
    logCode: "",
  };
}

function isDatePreset(value: unknown): value is DatePreset {
  return value === "today" || value === "yesterday" || value === "week" || value === "custom";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseTokenEntries(value: string): string[] {
  const tokens = value.split(/\r?\n|\t/).map(normalizeTokenInput).filter(looksLikeAccessToken);
  return [...new Set(tokens)].slice(0, 100);
}

function normalizeTokenInput(value: string): string {
  let token = value.trim().replace(/^Bearer\s+/i, "").trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function looksLikeAccessToken(value: string): boolean {
  return value.length >= 20 && !/\s/.test(value) && !/^https?:\/\//i.test(value) && !/^\d+$/.test(value);
}

function dateInTimezone(timestamp: number, timezone: string): string { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp)); const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00"; return `${get("year")}-${get("month")}-${get("day")}`; }
function addDays(date: string, amount: number): string { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); }
function formatTime(value: string, timezone: string): string { const timestamp = parseAnalyticsTimestamp(value); if (!Number.isFinite(timestamp)) return value || "-"; return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp)); }
function shortText(value: string, length: number): string { return value.length > length ? `${value.slice(0, length)}…` : value; }
const tooltipStyle = { border: "1px solid #dfe7e5", borderRadius: 8, boxShadow: "0 8px 20px rgba(28, 45, 52, .1)", fontSize: 12 };

const DEMO_PAGES: AnalyticsPage[] = [
  { id: "1247700201749799", name: "Jesus' Love Shelter", avatarUrl: "https://graph.facebook.com/1247700201749799/picture?type=small" },
  { id: "1189673984225873", name: "Garden of the Heart", avatarUrl: "https://graph.facebook.com/1189673984225873/picture?type=small" },
  { id: "1003163739541906", name: "God's Protection", avatarUrl: "https://graph.facebook.com/1003163739541906/picture?type=small" },
  { id: "1218161064713904", name: "客服测试专页", avatarUrl: "https://graph.facebook.com/1218161064713904/picture?type=small" },
  { id: "1028416657403372", name: "Hope & Grace", avatarUrl: "https://graph.facebook.com/1028416657403372/picture?type=small" },
  { id: "1193587301462086", name: "Light of Life", avatarUrl: "https://graph.facebook.com/1193587301462086/picture?type=small" },
  { id: "1075416829033441", name: "Warm Family", avatarUrl: "https://graph.facebook.com/1075416829033441/picture?type=small" },
  { id: "1157298047610298", name: "Daily Blessing", avatarUrl: "https://graph.facebook.com/1157298047610298/picture?type=small" },
];

function demoTraffic(page: AnalyticsPage, startDate: string, endDate: string): AnalyticsPageTraffic {
  const seed = Number(page.id.slice(-3)) || 17;
  const hourly: number[] = Array.from({ length: 24 }, (_, hour) => (hour * 7 + seed) % 11 === 0 ? 3 : (hour * 5 + seed) % 7 === 0 ? 2 : (hour + seed) % 5 === 0 ? 1 : 0);
  const previous: number[] = Array.from({ length: 24 }, (_, hour) => (hour * 3 + seed) % 9 === 0 ? 2 : (hour + seed) % 6 === 0 ? 1 : 0);
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  const daily = dates.map((date, index) => ({ date, count: 4 + (seed + index * 5) % 14 }));
  const previousDaily = dates.map((date, index) => ({ date: addDays(date, -dates.length), count: 3 + (seed + index * 3) % 11 }));
  const rangeTotal = startDate === endDate ? hourly.reduce((sum, value) => sum + value, 0) : daily.reduce((sum, point) => sum + point.count, 0);
  const previousRangeTotal = startDate === endDate ? previous.reduce((sum, value) => sum + value, 0) : previousDaily.reduce((sum, point) => sum + point.count, 0);
  const currentHour = new Date().getHours();
  return {
    page, todayHours: hourly, yesterdayHours: previous, daily, previousDaily,
    todayTotal: hourly.reduce((sum, value) => sum + value, 0),
    yesterdayTotal: previous.reduce((sum, value) => sum + value, 0),
    rangeTotal, previousRangeTotal,
    previousToCurrentTimeTotal: previous.slice(0, currentHour + 1).reduce((sum, value) => sum + value, 0),
    gender: { female: 8 + seed % 9, male: 5 + seed % 7, unknown: seed % 3 },
  };
}

const DEMO_LOGS: AnalyticsLogEntry[] = [
  { page: DEMO_PAGES[0], code: "10903", subcode: "1893049", description: "用户暂时无法回复此账号", count: 119, updatedAt: new Date().toISOString() },
  { page: DEMO_PAGES[1], code: "100", subcode: "1893060", description: "参数无效", count: 11, updatedAt: new Date(Date.now() - 42 * 60_000).toISOString() },
];
