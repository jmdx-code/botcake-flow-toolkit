import React from "react";
import { createRoot } from "react-dom/client";
import { LauncherShell } from "./LauncherShell";
import { callMain } from "./bridge";
import type { MainAction, MainRequestMap } from "../../shared/types";
import css from "./style.css?inline";

const HOST_ID = "botcake-flow-toolkit-host";
const ANALYTICS_BOOTSTRAP_ID = "botcake-analytics-bootstrap-host";
const ANALYTICS_VIEW = new URLSearchParams(location.search).get("botcake_flow_toolkit") === "analytics";

// The popup uses this explicit acknowledgement instead of treating any
// message delivery as proof that the assistant UI finished mounting.
chrome.runtime.onMessage.addListener((message: { action?: string; mainAction?: MainAction; payload?: MainRequestMap[MainAction] }, _sender, sendResponse) => {
  if (message.action === "ensureInjected") {
    sendResponse({ ok: true, host: Boolean(document.getElementById(HOST_ID)) });
    return;
  }
  if (message.action !== "callMainProxy" || !message.mainAction) return;
  void callMain(message.mainAction, message.payload as never, 180_000)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

if (!document.getElementById(HOST_ID)) {
  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const root = document.createElement("div");
  shadow.append(root);
  if (ANALYTICS_VIEW) {
    host.dataset.view = "analytics";
    document.title = "Botcake 引流数据";
    // The fixed dashboard has its own scroll container. Suppress Botcake's
    // underlying document scrollbar so an empty dashboard does not show a
    // misleading second scrollbar at the right edge.
    document.documentElement.style.setProperty("overflow", "hidden", "important");
    if (document.body) document.body.style.setProperty("overflow", "hidden", "important");
    root.id = "botcake-analytics-scroll-root";
    const style = document.createElement("style");
    style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block;overflow:hidden;background:#f5f8f8;color:#17242c;font-family:Inter,"Microsoft YaHei","PingFang SC",system-ui,sans-serif}#botcake-analytics-scroll-root{width:100%;height:100%;overflow:auto;overscroll-behavior:contain}.analytics-inline-boot{display:grid;width:100%;height:100%;gap:12px;color:#6b7b85;font:12px/1.4 Inter,"Microsoft YaHei","PingFang SC",system-ui,sans-serif;place-content:center;justify-items:center}.analytics-inline-boot::before{width:30px;height:30px;border:3px solid #d6e9e7;border-top-color:#07827b;border-radius:50%;content:"";animation:analytics-boot-spin .8s linear infinite}@keyframes analytics-boot-spin{to{transform:rotate(360deg)}}*{box-sizing:border-box}`;
    shadow.prepend(style);
    const loading = document.createElement("div");
    loading.className = "analytics-inline-boot";
    loading.textContent = "正在打开引流数据…";
    root.appendChild(loading);
    document.getElementById(ANALYTICS_BOOTSTRAP_ID)?.remove();
    void Promise.all([
      import("../options/AnalyticsDashboardApp"),
      import("../options/analytics.css?inline"),
    ]).then(([{ AnalyticsDashboardApp }, analyticsCss]) => {
      style.textContent += analyticsCss.default;
      createRoot(root).render(<React.StrictMode><AnalyticsDashboardApp /></React.StrictMode>);
    }).catch((reason) => {
      loading.textContent = `看板资源加载失败，请刷新页面重试：${reason instanceof Error ? reason.message : String(reason)}`;
    });
  } else {
    const style = document.createElement("style");
    style.textContent = css;
    shadow.prepend(style);
    createRoot(root).render(<React.StrictMode><LauncherShell /></React.StrictMode>);
  }
}
