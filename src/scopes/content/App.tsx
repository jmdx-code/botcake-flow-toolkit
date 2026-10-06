import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeSnapshot } from "../../core/template-analyzer";
import { createTemplateArchive, loadTemplateArchive } from "../../core/archive";
import { isCatalogStorageRefresh, normalizePublicDriveUrl, parseCatalogCsv, sheetUrlToCsv } from "../../core/catalog";
import { compileTemplate, uploadServiceAdapter } from "../../core/compiler";
import { DEFAULT_REPLY_EDIT_URL_PATTERN, FLOW_URL_PATTERN } from "../../shared/constants";
import type { CatalogRow, FlowSnapshot, ImportInputValue, LoadedTemplate, PendingFlowApply } from "../../shared/types";
import { callBackground, callMain, downloadBytes, fetchBytes, fetchCatalog, fetchText } from "./bridge";
import { clearPendingFlowApply, readPendingFlowApply } from "./pending-flow-apply";
import { reloadWithAssistantOpen, requestAssistantOpenOnArrival, resolveAssistantReturnUrl } from "./assistant-return";
import { countMissingRequired, initialInputValues, TemplateInputControl } from "./TemplateInputControl";
import { usePersistentPosition } from "./usePersistentPosition";
import { redactCredential } from "../../core/security-errors";

type Notice = { kind: "info" | "success" | "error"; text: string };
type BackupEntry = { storageKey: string; snapshot: FlowSnapshot; createdAt: number; size: number };

export function App({ onClose }: { onClose?: () => void }) {
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice>({ kind: "info", text: "正在读取当前 Flow…" });
  const [snapshot, setSnapshot] = useState<FlowSnapshot>();
  const [loaded, setLoaded] = useState<LoadedTemplate>();
  const [values, setValues] = useState<Record<string, ImportInputValue>>({});
  const [view, setView] = useState<"home" | "inputs">("home");
  const [pendingTask, setPendingTask] = useState<PendingFlowApply>();
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [backupWorkspaceOpen, setBackupWorkspaceOpen] = useState(false);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [routeKey, setRouteKey] = useState(() => flowRouteKey(window.location.href));
  const pendingStartedRef = useRef(false);
  const panelPosition = usePersistentPosition("ui:flow-panel-position", { width: 390, height: 64 }, () => ({ x: window.innerWidth - 406, y: 16 }));
  const isDefaultReplyPage = routeKey.endsWith(":default");
  const templateRows = useMemo(
    () => catalog.filter((row) => row.kind === (isDefaultReplyPage ? "defaultReply" : "flow")),
    [catalog, isDefaultReplyPage],
  );
  const targetLabel = isDefaultReplyPage ? "默认回复" : "当前 Flow";

  useEffect(() => {
    const detectRoute = () => setRouteKey((current) => {
      const next = flowRouteKey(window.location.href);
      return current === next ? current : next;
    });
    const routeMessageListener = (event: MessageEvent<{ app?: string; channel?: string }>) => {
      if (event.source === window && event.origin === location.origin && event.data?.app === "botcake-flow-toolkit" && event.data.channel === "route") detectRoute();
    };
    window.addEventListener("popstate", detectRoute);
    window.addEventListener("hashchange", detectRoute);
    window.addEventListener("message", routeMessageListener);
    return () => {
      window.removeEventListener("popstate", detectRoute);
      window.removeEventListener("hashchange", detectRoute);
      window.removeEventListener("message", routeMessageListener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(undefined);
    setBackups([]);
    setBackupWorkspaceOpen(false);
    setToolMenuOpen(false);
    if (!routeKey) return () => { cancelled = true; };
    setNotice({ kind: "info", text: "正在读取当前 Flow…" });

    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
        try {
          const current = await callMain("inspect", undefined);
          const postId = current.post.id;
          const routeMatches = routeKey.endsWith(":default")
            ? current.identity.pageId === routeKey.split(":")[0]
            : backupScopeKey(current) === routeKey;
          if (!routeMatches || String(postId ?? "") !== current.identity.flowId) {
            throw new Error("Botcake 仍在切换流程");
          }
          if (cancelled) return;
          setSnapshot(current);
          await loadBackupsFor(current);
          if (cancelled) return;
          const nodeCount = current.post.blocks && Array.isArray(current.post.blocks) ? current.post.blocks.length : 0;
          setNotice({ kind: "success", text: isDefaultReplyPage ? `已连接默认回复（${nodeCount} 个节点）` : `已连接：${current.name}（${nodeCount} 个节点）` });
          return;
        } catch (error) {
          lastError = error;
          await delay(500);
        }
      }
      if (!cancelled) setNotice({ kind: "error", text: `无法读取当前 Flow：${messageOf(lastError)}` });
    })();
    return () => { cancelled = true; };
  }, [routeKey]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer = 0;
    let requestVersion = 0;
    setCatalog([]);
    setCatalogError("");
    if (!routeKey) return () => { disposed = true; };

    const reloadCatalog = async () => {
      const version = ++requestVersion;
      try {
        const stored = await chrome.storage.local.get("catalogSheetUrl");
        const url = typeof stored.catalogSheetUrl === "string" ? stored.catalogSheetUrl.trim() : "";
        const rows = url
          ? parseCatalogCsv((await fetchCatalog(sheetUrlToCsv(url))).text).filter((row) => row.enabled)
          : [];
        if (disposed || version !== requestVersion) return;
        setCatalog(rows);
        setCatalogError("");
      } catch (error) {
        if (!disposed && version === requestVersion) setCatalogError(messageOf(error));
      }
    };
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (!isCatalogStorageRefresh(changes, areaName)) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void reloadCatalog(), 120);
    };

    void reloadCatalog();
    chrome.storage.onChanged.addListener(listener);
    return () => {
      disposed = true;
      requestVersion += 1;
      window.clearTimeout(refreshTimer);
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [routeKey]);

  const missingRequired = loaded ? countMissingRequired(loaded.template, values) : 0;

  useEffect(() => {
    if (!snapshot || pendingStartedRef.current) return;
    pendingStartedRef.current = true;
    void readPendingFlowApply().then(async (task) => {
      if (!task) return;
      if (snapshot.identity.pageId !== task.targetPageId || snapshot.identity.flowId !== task.targetFlowId) {
        await clearPendingFlowApply(task.id);
        throw new Error(`自动应用任务目标是专页 ${task.targetPageId} / Flow ${task.targetFlowId}，当前页面不是目标 Flow，已停止应用`);
      }
      const next = loadTemplateArchive(task.archiveBytes, task.sourceName);
      setPendingTask(task); setLoaded(next); setValues(task.values);
      setNotice({ kind: "info", text: `正在应用${task.target === "defaultReply" ? "默认回复" : task.target === "keyword" ? "关键词" : "评论私信"}流程：${task.keyword?.name ?? next.template.meta.name}…` });
      await applyLoadedTemplate(next, task.values, { skipConfirm: true, pending: task });
    }).catch((error) => setNotice({ kind: "error", text: `自动应用失败：${messageOf(error)}` }));
  }, [snapshot]);

  async function loadBackupsFor(current: FlowSnapshot) {
    const key = backupScopeKey(current);
    const response = await callBackground({ action: "getBackups", key });
    const values = "value" in response && response.value && typeof response.value === "object"
      ? response.value as Record<string, unknown>
      : {};
    const prefix = `backup:${key}:`;
    const entries = Object.entries(values).flatMap(([storageKey, value]) => {
      if (!isFlowSnapshot(value) || backupScopeKey(value) !== key) return [];
      const createdAt = Number(storageKey.slice(prefix.length));
      return [{
        storageKey,
        snapshot: value,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.parse(value.capturedAt),
        size: new Blob([JSON.stringify(value)]).size,
      }];
    }).sort((a, b) => b.createdAt - a.createdAt);
    setBackups(entries);
  }

  async function createManualBackup() {
    await run("备份当前流程", async () => {
      const current = await callMain("inspect", undefined);
      await callBackground({ action: "saveBackup", key: backupScopeKey(current), value: current });
      await loadBackupsFor(current);
      setNotice({ kind: "success", text: "当前流程已备份到插件本地存储" });
    });
  }

  async function restoreBackup(entry: BackupEntry) {
    if (!snapshot) return;
    if (!window.confirm(`将从 ${formatBackupDate(entry.createdAt)} 的备份恢复当前 Flow。恢复前会再次备份当前状态，是否继续？`)) return;
    await run("恢复流程", async () => {
      const current = await callMain("inspect", undefined);
      if (backupScopeKey(current) !== backupScopeKey(entry.snapshot)) throw new Error("备份不属于当前专页和 Flow，已阻止恢复");
      await callBackground({ action: "saveBackup", key: backupScopeKey(current), value: current });
      const restorePost = structuredClone(entry.snapshot.post);
      if (current.identity.kind === "defaultReply") restorePost.id = current.post.id;
      const saved = await callMain("saveFlow", {
        name: current.identity.kind === "defaultReply" ? "默认回复" : entry.snapshot.name,
        post: restorePost,
        selectedTab: entry.snapshot.selectedTab,
        isPreview: entry.snapshot.isPreview,
        isPreviewPublished: entry.snapshot.isPreviewPublished,
      }, 120_000);
      if (!saved.success) throw new Error(`Botcake 恢复失败：${summarizeResult(saved.result)}`);
      setNotice({ kind: "success", text: "备份已恢复，正在刷新流程…" });
      reloadWithAssistantOpen(800);
    });
  }

  async function loadLocalTemplate(file: File) {
    await run("读取本地资源包", async () => {
      const next = loadTemplateArchive(new Uint8Array(await file.arrayBuffer()), file.name);
      selectTemplate(next);
    });
  }

  async function loadRemoteTemplate(row: CatalogRow) {
    let next: LoadedTemplate | undefined;
    await run(`下载 ${row.name}`, async () => {
      const remote = await fetchBytes(normalizePublicDriveUrl(row.url));
      next = loadTemplateArchive(remote.bytes, row.name);
      selectTemplate(next);
    });
    if (next && !next.template.inputs.length) {
      await applyLoadedTemplate(next, initialInputValues(next.template));
    }
  }

  function selectTemplate(next: LoadedTemplate) {
    setLoaded(next);
    setValues(initialInputValues(next.template));
    setView(next.template.inputs.length ? "inputs" : "home");
    const issueCount = next.template.dependencies.unsupported.length;
    setNotice(issueCount
      ? { kind: "error", text: `模板含 ${issueCount} 个未支持的专页绑定，导入前必须处理` }
      : { kind: "success", text: `已载入模板：${next.template.meta.name}` });
  }

  async function makeTemplate() {
    await run("制作模板", async () => {
      const current = await callMain("inspect", undefined);
      const template = analyzeSnapshot(current);
      const assets = new Map<string, Uint8Array>();
      const failed: string[] = [];
      for (const media of template.dependencies.media) {
        if (!media.asset || !media.sourceUrl) continue;
        try {
          const result = await fetchBytes(media.sourceUrl);
          assets.set(media.asset, result.bytes);
          if (result.contentType) media.mime = result.contentType.split(";")[0];
        } catch {
          failed.push(media.key);
        }
      }
      const next: LoadedTemplate = { template, assets, sourceName: `${safeName(template.meta.name)}.zip` };
      selectTemplate(next);
      const archive = createTemplateArchive(template, assets);
      await downloadBytes(archive, `${safeName(template.meta.name)}.zip`, "application/zip");
      setNotice({
        kind: failed.length ? "info" : "success",
        text: failed.length
          ? `模板已生成；${failed.length} 个素材下载失败，保留远程地址作为后备`
          : `模板已生成并打包 ${assets.size} 个素材`,
      });
    });
  }

  async function applyTemplate() {
    if (!loaded) return;
    await applyLoadedTemplate(loaded, values, pendingTask ? { skipConfirm: true, pending: pendingTask } : {});
  }

  async function applyLoadedTemplate(target: LoadedTemplate, targetValues: Record<string, ImportInputValue>, options: { skipConfirm?: boolean; pending?: PendingFlowApply } = {}) {
    if (!snapshot) return;
    if (target.template.dependencies.unsupported.length) {
      setNotice({ kind: "error", text: "模板仍含未支持的专页绑定对象，已阻止覆盖" });
      return;
    }
    const missing = countMissingRequired(target.template, targetValues);
    if (missing) {
      setNotice({ kind: "error", text: `还有 ${missing} 个必填项未填写` });
      return;
    }
    if (!options.skipConfirm && !window.confirm(`将用“${target.template.meta.name}”替换当前 Flow“${snapshot.name}”。插件会先备份，再创建变量和上传素材。是否继续？`)) return;

    await run("编译并设置流程", async () => {
      const before = await callMain("inspect", undefined);
      const returnUrl = options.pending
        ? resolveAssistantReturnUrl(options.pending.returnUrl, before.identity.pageId)
        : undefined;
      await callBackground({
        action: "saveBackup",
        key: backupScopeKey(before),
        value: before,
      });
      const compiled = await compileTemplate(target, targetValues, {
        getBotFields: () => callMain("getBotFields", undefined),
        createBotField: (name, type, value, description) => callMain("createBotField", { name, type, value, description }),
        getTags: () => callMain("getTags", undefined),
        createTag: (name) => callMain("createTag", { name }),
        uploadMedia: uploadServiceAdapter((data) => callMain("uploadMedia", data, 120_000)),
        fetchBytes,
        fetchText,
      }, before);
      const savePayload = options.pending?.target === "keyword" && options.pending.keyword
        ? { ...compiled.payload, name: options.pending.keyword.name }
        : isDefaultReplyPage
        ? { ...compiled.payload, name: "默认回复" }
        : compiled.payload;
      const saved = await callMain("saveFlow", savePayload, 120_000);
      if (!saved.success) throw new Error(`Botcake 保存失败：${summarizeResult(saved.result)}`);
      if (isDefaultReplyPage) {
        const activation = await callMain("activateDefaultReply", undefined, 120_000);
        if (!activation.enabled || activation.usingAi) throw new Error("默认回复流程已保存，但自动启用失败");
      }
      if (options.pending?.applyWelcome) {
        const welcome = await callMain("ensureWelcomeFlowFromComment", { enable: true }, 120_000);
        if (!welcome.enabled || !welcome.flow) throw new Error("评论流程已保存，但欢迎信息绑定失败");
      }
      if (options.pending?.target === "keyword") {
        if (!options.pending.keyword) throw new Error("关键词应用任务缺少规则信息");
        await callMain("finalizeKeywordFlow", {
          keywordId: options.pending.keyword.id,
          flowId: before.identity.flowId,
          name: options.pending.keyword.name,
          keywords: options.pending.keyword.terms,
        }, 120_000);
      }
      if (options.pending) {
        await clearPendingFlowApply(options.pending.id);
        setPendingTask(undefined);
      }
      await loadBackupsFor(before);
      const details = [
        compiled.report.createdBotFields.length ? `新建变量 ${compiled.report.createdBotFields.length} 个` : "变量已映射",
        compiled.report.createdTags.length ? `新建标签 ${compiled.report.createdTags.length} 个` : compiled.report.mappedTags.length ? "标签已映射" : "无标签动作",
        compiled.report.uploadedMedia.length ? `上传素材 ${compiled.report.uploadedMedia.length} 个` : "无素材上传",
      ].join("，");
      const bindingDetail = options.pending?.target === "defaultReply"
        ? "，默认回复已更新并启用"
        : options.pending?.target === "keyword"
          ? `，关键词规则“${options.pending.keyword?.name ?? ""}”已更新并启用`
        : options.pending?.applyWelcome ? "，并已同步欢迎信息" : "";
      setNotice({
        kind: "success",
        text: `流程已保存：${details}${bindingDetail}。${returnUrl ? "正在返回原页面…" : "正在刷新…"}`,
      });
      window.setTimeout(() => {
        requestAssistantOpenOnArrival();
        if (returnUrl) location.assign(returnUrl);
        else location.reload();
      }, 900);
    });
  }

  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setNotice({ kind: "info", text: `${label}…` });
    try { await fn(); } catch (error) { setNotice({ kind: "error", text: messageOf(error) }); }
    finally { setBusy(""); }
  }

  if (!routeKey) return null;

  return (
    <aside className={`bft-panel flow-assistant ${view === "inputs" ? "show-inputs" : ""}`} style={panelPosition.style}>
      <header className="bft-header" {...panelPosition.dragProps}>
        <div><strong>{view === "inputs" ? loaded?.template.meta.name : isDefaultReplyPage ? "Botcake 默认回复助手" : "Botcake 流程助手"}</strong><small>{view === "inputs" ? `填写${targetLabel}所需内容` : snapshot ? `${snapshot.identity.pageId} / ${isDefaultReplyPage ? "默认回复" : snapshot.identity.flowId}` : "连接中"}</small></div>
        <div className="bft-header-actions">
          {view === "home" && <label className="header-file-button">＋ ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => event.target.files?.[0] && void loadLocalTemplate(event.target.files[0])} /></label>}
          {view === "inputs" && !pendingTask && <button onClick={() => setView("home")}>返回</button>}
          {view === "home" && <div className="tool-menu-wrap"><button className="icon tool-menu-button" title="工具" aria-label="打开工具菜单" onClick={() => setToolMenuOpen((value) => !value)}>⋮</button>{toolMenuOpen && <div className="tool-menu" role="menu"><button role="menuitem" onClick={() => { void makeTemplate(); setToolMenuOpen(false); }} disabled={Boolean(busy)}><span>⇩</span><div><strong>导出当前流程模板</strong><small>打包当前节点、变量和素材</small></div></button><button role="menuitem" onClick={() => { setBackupWorkspaceOpen(true); setToolMenuOpen(false); }}><span>↶</span><div><strong>备份/恢复</strong><small>管理当前专页和 Flow 的备份</small></div></button></div>}</div>}
          <button className="icon" aria-label="收起流程助手" onClick={onClose}>×</button>
        </div>
      </header>

      <div className={`notice ${notice.kind}`}>{busy && <span className="spinner" />}{notice.text}</div>

      <div className="page-assistant-viewport"><div className="page-assistant-slides">
        <div className="flow-assistant-body page-home-view">
          <section className="resource-section flow-catalog-section"><h3>{isDefaultReplyPage ? "默认回复模板" : "流程模板"}</h3>
            {templateRows.map((row) => <div className="resource-row" key={`${row.name}-${row.url}`}><div><strong>{row.name}</strong>{row.description && <small>{row.description}</small>}</div><button disabled={Boolean(busy) || !snapshot} onClick={() => void loadRemoteTemplate(row)}>应用到{targetLabel}</button></div>)}
            {!templateRows.length && <p className="resource-empty">{catalogError ? `控制台读取失败：${catalogError}` : `控制台中没有以“${isDefaultReplyPage ? "默认回复" : "流程"}”开头的资源`}</p>}
          </section>
          {loaded && <section><div className="section-title"><h3>{loaded.template.meta.name}</h3><span>v{loaded.template.version}</span></div>{loaded.template.meta.description && <p className="muted">{loaded.template.meta.description}</p>}<div className="chips"><span>{loaded.template.inputs.length} 个输入</span><span>{loaded.template.dependencies.botFields.length} 个变量</span>{Boolean(loaded.template.dependencies.tags?.length) && <span>{loaded.template.dependencies.tags?.length} 个标签</span>}<span>{loaded.template.dependencies.media.length} 个素材</span></div>{loaded.template.dependencies.unsupported.length > 0 && <details className="issues" open><summary>存在不支持的绑定对象</summary>{loaded.template.dependencies.unsupported.map((item, index) => <p key={index}>{item.path}<br />{item.reason}</p>)}</details>}{loaded.template.inputs.length > 0 && <button className="secondary-wide" onClick={() => setView("inputs")}>填写流程变量</button>}<button className="primary" onClick={() => void applyTemplate()} disabled={Boolean(busy) || !snapshot}>应用到{targetLabel}{missingRequired ? `（缺 ${missingRequired} 项）` : ""}</button></section>}
        </div>
        <div className="flow-assistant-body page-input-view"><div className="input-intro"><strong>填写流程变量</strong><span>填写完成后直接替换{targetLabel}。</span></div>{loaded?.template.inputs.map((input) => <TemplateInputControl key={input.key} input={input} value={values[input.key] ?? {}} assets={loaded.assets} onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))} />)}<button className="primary sticky-apply" onClick={() => void applyTemplate()} disabled={Boolean(busy) || !snapshot}>应用到{targetLabel}{missingRequired ? `（缺 ${missingRequired} 项）` : ""}</button></div>
      </div></div>

      {backupWorkspaceOpen && <div className="settings-backdrop" onMouseDown={() => setBackupWorkspaceOpen(false)}>
        <div className="settings-modal" role="dialog" aria-modal="true" aria-label="备份恢复工作区" onMouseDown={(event) => event.stopPropagation()}>
          <header className="settings-modal-header"><div><strong>备份/恢复工作区</strong><small>{snapshot ? `专页 ${snapshot.identity.pageId} · ${snapshot.identity.kind === "defaultReply" ? "默认回复" : `Flow ${snapshot.identity.flowId}`}` : "正在连接 Flow"}</small></div><button className="icon" aria-label="关闭工作区" onClick={() => setBackupWorkspaceOpen(false)}>×</button></header>
          <div className="settings-content">
            <>
              <div className="backup-heading"><div><strong>从备份中恢复当前流程</strong><small>按专页 ID 和 Flow ID 独立保存，最多保留 5 份</small></div><button onClick={createManualBackup} disabled={Boolean(busy) || !snapshot}>立即备份</button></div>
              <div className="backup-list">
                {backups.map((entry, index) => <div className="backup-row" key={entry.storageKey}>
                  <strong>备份{index + 1}</strong><span>{formatBackupDate(entry.createdAt)}</span><span>{formatBytes(entry.size)}</span><button onClick={() => restoreBackup(entry)} disabled={Boolean(busy)}>从此备份恢复</button>
                </div>)}
                {!backups.length && <p className="empty-backups">当前专页的这个 Flow 还没有本地备份。</p>}
              </div>
            </>
          </div>
        </div>
      </div>}
    </aside>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "botcake-template";
}

function summarizeResult(value: unknown): string {
  try { return redactCredential(JSON.stringify(value), "") || "接口未返回详情"; }
  catch { return String(value).slice(0, 600); }
}

function backupScopeKey(snapshot: FlowSnapshot): string {
  return snapshot.identity.kind === "defaultReply"
    ? `${snapshot.identity.pageId}:defaultReply`
    : `${snapshot.identity.pageId}:${snapshot.identity.flowId}`;
}

function isFlowSnapshot(value: unknown): value is FlowSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<FlowSnapshot>;
  return Boolean(record.identity?.pageId && record.identity?.flowId && record.post && typeof record.post === "object" && typeof record.name === "string");
}

function formatBackupDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "时间未知";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function flowRouteKey(url: string): string {
  const match = url.match(FLOW_URL_PATTERN);
  if (match) return `${match[1]}:${match[2]}`;
  const defaultReply = url.match(DEFAULT_REPLY_EDIT_URL_PATTERN);
  return defaultReply ? `${defaultReply[1]}:default` : "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
