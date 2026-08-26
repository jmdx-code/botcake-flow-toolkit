import type { MainAction, MainRequestMap } from "./types";

export type BackgroundRequest =
  | { action: "fetchText"; url: string }
  | { action: "fetchCatalog"; url: string; forceRefresh?: boolean }
  | { action: "fetchBinary"; url: string }
  | { action: "download"; bytes: number[]; fileName: string; mime: string }
  | { action: "saveBackup"; key: string; value: unknown }
  | { action: "getBackups"; key: string }
  | { action: "getBotcakeAccessToken" }
  | { action: "getAnalyticsDirectory"; forceRefresh?: boolean }
  | { action: "getAnalyticsData"; pageIds: string[]; timezone: string; startDate: string; endDate: string; comparePrevious: boolean; forceRefresh?: boolean }
  | { action: "getAnalyticsPageData"; pageId: string; timezone: string; startDate: string; endDate: string; comparePrevious: boolean; forceRefresh?: boolean }
  | { action: "getAnalyticsLogs"; pageIds: string[]; forceRefresh?: boolean }
  | { action: "configureAnalyticsPages"; pages: Array<{ pageId: string; token: string }> }
  | { action: "getAnalyticsManagedTokens" }
  | { action: "addAnalyticsManagedTokens"; tokens: string[] }
  | { action: "removeAnalyticsManagedToken"; tokenId: string }
  | { action: "setAnalyticsRefreshTarget"; target?: { pageIds: string[]; timezone: string; startDate: string; endDate: string; comparePrevious: boolean } }
  | { action: "callBotcakeMain"; mainAction: MainAction; payload: MainRequestMap[MainAction] };

export type BackgroundResponse =
  | { ok: true; text: string; contentType?: string }
  | { ok: true; text: string; contentType?: string; cache: "fresh" | "network" | "stale" }
  | { ok: true; bytes: number[]; contentType?: string; fileName?: string }
  | { ok: true; downloadId?: number; value?: unknown }
  | { ok: false; error: string };
