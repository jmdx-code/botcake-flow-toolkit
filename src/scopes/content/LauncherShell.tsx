import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { DEFAULT_REPLY_EDIT_URL_PATTERN, FLOW_URL_PATTERN } from "../../shared/constants";
import type { CommentFlowStatus } from "../../shared/types";
import { usePersistentPosition } from "./usePersistentPosition";
import { consumeAssistantOpenOnArrival } from "./assistant-return";

const FlowAssistant = lazy(async () => {
  const module = await import("./App");
  return { default: module.App };
});

const PageAssistant = lazy(async () => {
  const module = await import("./PageAssistant");
  return { default: module.PageAssistant };
});

type RouteInfo = {
  href: string;
  pageId?: string;
  flowId?: string;
  isFlow: boolean;
  isComment: boolean;
};

const PENDING_COMMENT_FLOW_KEY = "botcake-flow-toolkit:pending-comment-flow";

export function LauncherShell() {
  const [route, setRoute] = useState(() => readRoute());
  const [open, setOpen] = useState(false);
  const [commentStatus, setCommentStatus] = useState<CommentFlowStatus>();
  const [commentError, setCommentError] = useState("");
  const [loadingComment, setLoadingComment] = useState(false);
  const [externalLaunchRequest, setExternalLaunchRequest] = useState(0);
  const [pendingPageSelection, setPendingPageSelection] = useState(() => readPendingCommentFlow());
  const launcherPosition = usePersistentPosition("ui:launcher-position", { width: 150, height: 50 }, () => ({ x: window.innerWidth - 168, y: window.innerHeight - 68 }));
  const commentPanelPosition = usePersistentPosition("ui:comment-panel-position", { width: 430, height: 620 }, () => ({ x: window.innerWidth - 448, y: Math.max(18, window.innerHeight - 638) }));

  useEffect(() => {
    const update = () => {
      const next = readRoute();
      setRoute((current) => current.href === next.href ? current : next);
    };
    const routeMessage = (event: MessageEvent<{ app?: string; channel?: string }>) => {
      if (event.source === window && event.data?.app === "botcake-flow-toolkit" && event.data.channel === "route") update();
    };
    const runtimeMessage = (message: { action?: string }) => {
      if (message.action === "togglePanel") setExternalLaunchRequest((value) => value + 1);
    };
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    window.addEventListener("message", routeMessage);
    chrome.runtime.onMessage.addListener(runtimeMessage);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      window.removeEventListener("message", routeMessage);
      chrome.runtime.onMessage.removeListener(runtimeMessage);
    };
  }, []);

  useEffect(() => {
    if (!externalLaunchRequest) return;
    void openLauncher();
  }, [externalLaunchRequest]);

  useEffect(() => {
    if (!route.isFlow) setOpen(false);
  }, [route.isFlow]);

  useEffect(() => {
    if (consumeAssistantOpenOnArrival()) setOpen(true);
  }, [route.href]);

  useEffect(() => {
    if (!pendingPageSelection || !route.pageId || route.isFlow) return;
    clearPendingCommentFlow();
    setPendingPageSelection(false);
    navigate(`/${route.pageId}/comment#bft-open-default-flow`);
  }, [pendingPageSelection, route.pageId, route.isFlow]);

  useEffect(() => {
    if (!route.isFlow || location.hash !== "#bft-open-assistant") return;
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    setOpen(true);
  }, [route.href, route.isFlow]);

  useEffect(() => {
    if (!route.isComment || location.hash !== "#bft-open-default-flow") return;
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    setOpen(true);
    void locateCommentFlow();
  }, [route.href, route.isComment]);

  const label = useMemo(() => route.isFlow ? "流程助手" : "专页助手", [route.isFlow]);

  async function openLauncher() {
    if (route.isFlow) { setOpen(true); return; }
    if (!route.pageId) {
      writePendingCommentFlow();
      setPendingPageSelection(true);
      setOpen(true);
      return;
    }
    setOpen(true);
  }

  function closeLauncher() {
    clearPendingCommentFlow();
    setPendingPageSelection(false);
    setOpen(false);
  }

  async function locateCommentFlow() {
    if (!route.pageId) return;
    setLoadingComment(true);
    setCommentError("");
    setCommentStatus(undefined);
    try {
      const { callMain } = await import("./bridge");
      let status: CommentFlowStatus | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          status = await callMain("getCommentFlowStatus", undefined);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 4) await delay(400 * (attempt + 1));
        }
      }
      if (!status) throw lastError ?? new Error("Botcake 未返回评论流程设置");
      setCommentStatus(status);
      if (status?.flow) navigate(`/${status.pageId}/flows/${status.flow.id}/content#bft-open-assistant`);
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingComment(false);
    }
  }

  if (route.isFlow && open) {
    return <Suspense fallback={<div className="bft-loading-card">正在加载流程助手…</div>}>
      <FlowAssistant onClose={() => setOpen(false)} />
    </Suspense>;
  }

  if (!route.isFlow && open && route.pageId) {
    return <Suspense fallback={<div className="bft-loading-card">正在加载专页助手…</div>}>
      <PageAssistant pageId={route.pageId} onClose={closeLauncher} style={commentPanelPosition.style} dragProps={commentPanelPosition.dragProps} />
    </Suspense>;
  }

  if (!route.isFlow && open) {
    return <aside className="bft-launch-card" style={commentPanelPosition.style}>
      <header {...commentPanelPosition.dragProps}><div><strong>评论流程</strong><small>{route.pageId ? `专页 ${route.pageId}` : "等待选择专页"}</small></div><button className="icon" aria-label="收起" onClick={closeLauncher}>×</button></header>
      <p>{!route.pageId ? "请选择一个专页；进入专页后将自动打开它的评论流程。" : loadingComment ? "正在识别默认评论私信流程…" : commentError ? "Botcake 暂时无法读取评论流程，请稍后重试。" : commentStatus?.flow ? `正在打开：${commentStatus.flow.name}` : commentStatus ? "当前专页未设置默认评论私信流程。" : "正在准备识别评论流程…"}</p>
      {commentError && <p className="bft-inline-error">识别失败：{commentError}</p>}
      {route.pageId && !loadingComment && commentError && <button className="primary" onClick={() => void locateCommentFlow()}>重新识别</button>}
      {route.pageId && !loadingComment && !commentError && commentStatus && !commentStatus.flow && <button className="primary" onClick={() => navigate(`/${route.pageId}/comment`)}>前往创建流程并开启 Auto-inbox</button>}
    </aside>;
  }

  return <button className={`bft-fab ${route.isFlow ? "flow" : "comment"}`} style={launcherPosition.style} {...launcherPosition.dragProps} aria-label={label} title={`${label}（可拖动）`} onClick={() => { if (!launcherPosition.consumeSuppressedClick()) void openLauncher(); }}>
    <span aria-hidden="true">{route.isFlow ? "↗" : "◌"}</span><b>{label}</b>
  </button>;
}

function readRoute(): RouteInfo {
  const href = location.href;
  const flow = href.match(FLOW_URL_PATTERN);
  const defaultReply = href.match(DEFAULT_REPLY_EDIT_URL_PATTERN);
  const page = location.pathname.match(/^\/(\d+)(?:\/|$)/);
  return {
    href,
    pageId: flow?.[1] ?? defaultReply?.[1] ?? page?.[1],
    flowId: flow?.[2] ?? (defaultReply ? "default" : undefined),
    isFlow: Boolean(flow || defaultReply),
    isComment: /^\/\d+\/comment(?:\/|$)/.test(location.pathname),
  };
}

function navigate(path: string): void {
  if (location.pathname === path) location.reload();
  else location.assign(path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readPendingCommentFlow(): boolean {
  try { return sessionStorage.getItem(PENDING_COMMENT_FLOW_KEY) === "1"; }
  catch { return false; }
}

function writePendingCommentFlow(): void {
  try { sessionStorage.setItem(PENDING_COMMENT_FLOW_KEY, "1"); } catch { /* ignore unavailable session storage */ }
}

function clearPendingCommentFlow(): void {
  try { sessionStorage.removeItem(PENDING_COMMENT_FLOW_KEY); } catch { /* ignore unavailable session storage */ }
}
