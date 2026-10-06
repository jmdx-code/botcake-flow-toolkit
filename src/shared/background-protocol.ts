import type {
  BotFieldSpec,
  BotcakeFlowApplyTarget,
  CompleteBotcakeFlowPayload,
  MainAction,
  MainRequestMap,
  MediaKind,
  SaveFlowPayload,
  UpdatePageAutomationPayload,
} from "./types";
import type { PendingFlowWire } from "../core/pending-flow-wire";

export type BackgroundRequest =
  | { action: "savePendingFlowApply"; task: PendingFlowWire }
  | { action: "readPendingFlowApply"; id: string }
  | { action: "clearPendingFlowApply"; id: string }
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
  | { action: "getBotcakePageState"; pageId: string }
  | { action: "updateBotcakePageAutomation"; pageId: string; payload: UpdatePageAutomationPayload }
  | { action: "ensureBotcakeBotFields"; pageId: string; fields: BotFieldSpec[] }
  | { action: "getBotcakeBotFields"; pageId: string }
  | { action: "createBotcakeBotField"; pageId: string; field: BotFieldSpec }
  | { action: "getBotcakeTags"; pageId: string }
  | { action: "createBotcakeTag"; pageId: string; name: string }
  | { action: "uploadBotcakeMedia"; pageId: string; media: { kind: MediaKind; name: string; mime: string; base64: string } }
  | { action: "prepareBotcakeFlow"; pageId: string; target: BotcakeFlowApplyTarget; name: string; keywords?: string[]; enableAutoInbox?: boolean }
  | { action: "saveBotcakeFlow"; pageId: string; payload: SaveFlowPayload }
  | { action: "completeBotcakeFlow"; pageId: string; payload: CompleteBotcakeFlowPayload }
  | { action: "callBotcakeMain"; mainAction: MainAction; payload: MainRequestMap[MainAction] };

export type BackgroundResponse =
  | { ok: true; text: string; contentType?: string }
  | { ok: true; text: string; contentType?: string; cache: "fresh" | "network" | "stale" }
  | { ok: true; bytes: number[]; contentType?: string; fileName?: string }
  | { ok: true; downloadId?: number; value?: unknown }
  | { ok: false; error: string };
