import { APP_ID } from "../../shared/constants";
import type {
  MainAction,
  MainBridgeRequest,
  MainBridgeResponse,
  MainRequestMap,
  MainResponseMap,
} from "../../shared/types";
import type { BackgroundRequest, BackgroundResponse } from "../../shared/background-protocol";

export function callMain<A extends MainAction>(
  action: A,
  payload: MainRequestMap[A],
  timeoutMs = 20_000,
): Promise<MainResponseMap[A]> {
  const requestId = crypto.randomUUID();
  const request: MainBridgeRequest<A> = { app: APP_ID, channel: "request", requestId, action, payload };
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error(`页面操作超时：${action}`));
    }, timeoutMs);
    const listener = (event: MessageEvent<MainBridgeResponse<A>>) => {
      const response = event.data;
      if (event.source !== window || event.origin !== location.origin || response?.app !== APP_ID || response.channel !== "response" || response.requestId !== requestId || response.action !== action) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      if (response.ok) resolve(response.result as MainResponseMap[A]);
      else reject(new Error(response.error || `页面操作失败：${action}`));
    };
    window.addEventListener("message", listener);
    window.postMessage(request, location.origin);
  });
}

export async function callBackground(request: BackgroundRequest): Promise<BackgroundResponse & { ok: true }> {
  const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse>(request);
  if (!response?.ok) throw new Error(response?.error ?? "插件后台没有响应");
  return response;
}

export async function callBackgroundValue<T>(request: BackgroundRequest): Promise<T> {
  const response = await callBackground(request);
  if (!("value" in response)) throw new Error("插件后台没有返回操作结果");
  return response.value as T;
}

export async function fetchText(url: string): Promise<string> {
  const result = await callBackground({ action: "fetchText", url });
  if (!("text" in result)) throw new Error("下载结果不是文本");
  return result.text;
}

export async function fetchCatalog(url: string, forceRefresh = false): Promise<{ text: string; cache: "fresh" | "network" | "stale" }> {
  const result = await callBackground({ action: "fetchCatalog", url, forceRefresh });
  if (!("text" in result) || !("cache" in result)) throw new Error("控制台下载结果不是文本");
  return { text: result.text, cache: result.cache };
}

export async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; contentType?: string; fileName?: string }> {
  const result = await callBackground({ action: "fetchBinary", url });
  if (!("bytes" in result)) throw new Error("下载结果不是文件");
  return { bytes: new Uint8Array(result.bytes), contentType: result.contentType, fileName: result.fileName };
}

export async function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): Promise<void> {
  await callBackground({ action: "download", bytes: Array.from(bytes), fileName, mime });
}
