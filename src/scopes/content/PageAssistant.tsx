import { useEffect, useMemo, useState, type HTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { loadTemplateArchive } from "../../core/archive";
import { compileTemplate, uploadServiceAdapter } from "../../core/compiler";
import { isCatalogStorageRefresh, normalizePublicDriveUrl, parseCatalogCsv, sheetUrlToCsv } from "../../core/catalog";
import {
  extractPageSettingsTemplate,
  parsePageSettingsTemplate,
  serializePageSettingsTemplate,
  templateToUpdatePayload,
} from "../../core/page-settings-template";
import type {
  BotField,
  BotcakeTag,
  CatalogRow,
  EnsureBotFieldsResult,
  ImportInputValue,
  LoadedTemplate,
  PageAutomationState,
  PreparedBotcakeFlow,
  UpdatePageAutomationResult,
} from "../../shared/types";
import { callBackground, callBackgroundValue, downloadBytes, fetchBytes, fetchCatalog, fetchText } from "./bridge";
import { countMissingRequired, initialInputValues, TemplateInputControl } from "./TemplateInputControl";

type Notice = { kind: "info" | "success" | "error"; text: string };
type FlowApplyTarget = "comment" | "defaultReply" | "keyword";

export function PageAssistant({ pageId, onClose, style, dragProps }: { pageId: string; onClose: () => void; style: CSSProperties; dragProps: HTMLAttributes<HTMLElement> }) {
  const [state, setState] = useState<PageAutomationState>();
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice>({ kind: "info", text: "正在读取专页和资源目录…" });
  const [applyWelcome, setApplyWelcome] = useState(true);
  const [loaded, setLoaded] = useState<LoadedTemplate>();
  const [values, setValues] = useState<Record<string, ImportInputValue>>({});
  const [view, setView] = useState<"home" | "inputs">("home");
  const [flowTarget, setFlowTarget] = useState<FlowApplyTarget>("comment");
  const [keywordRow, setKeywordRow] = useState<CatalogRow>();

  useEffect(() => {
    void initialize();
    let refreshTimer = 0;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (!isCatalogStorageRefresh(changes, areaName)) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void reloadCatalog(), 120);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      window.clearTimeout(refreshTimer);
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [pageId]);

  const settingsRows = useMemo(() => catalog.filter((row) => row.kind === "settings"), [catalog]);
  const flowRows = useMemo(() => catalog.filter((row) => row.kind === "flow"), [catalog]);
  const defaultReplyRows = useMemo(() => catalog.filter((row) => row.kind === "defaultReply"), [catalog]);
  const keywordRows = useMemo(() => catalog.filter((row) => row.kind === "keyword"), [catalog]);
  const missingRequired = loaded ? countMissingRequired(loaded.template, values) : 0;

  async function initialize() {
    await run("读取专页", async () => {
      const stored = await chrome.storage.local.get(["catalogSheetUrl", "applyWelcomeWithCommentFlow"]);
      setApplyWelcome(stored.applyWelcomeWithCommentFlow !== false);
      const [nextState, rows] = await Promise.all([
        readPageStateWithRetry(pageId),
        typeof stored.catalogSheetUrl === "string" && stored.catalogSheetUrl
          ? fetchCatalog(sheetUrlToCsv(stored.catalogSheetUrl)).then((result) => parseCatalogCsv(result.text).filter((row) => row.enabled))
          : Promise.resolve([]),
      ]);
      setState(nextState); setCatalog(rows);
      setNotice({ kind: "success", text: rows.length ? `已载入 ${rows.length} 个可用资源` : "请先在扩展图标中设置控制台表格" });
    });
  }

  async function reloadCatalog() {
    try {
      const stored = await chrome.storage.local.get("catalogSheetUrl");
      const url = typeof stored.catalogSheetUrl === "string" ? stored.catalogSheetUrl.trim() : "";
      const rows = url
        ? parseCatalogCsv((await fetchCatalog(sheetUrlToCsv(url))).text).filter((row) => row.enabled)
        : [];
      setCatalog(rows);
      setNotice({ kind: "success", text: rows.length ? `资源控制台已更新：${rows.length} 个可用资源` : "资源控制台已清空" });
    } catch (error) {
      setNotice({ kind: "error", text: `资源控制台刷新失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function applySettings(row: CatalogRow) {
    await run(`应用 ${row.name}`, async () => {
      await applySettingsText(await fetchText(normalizePublicDriveUrl(row.url)));
    });
  }

  async function loadLocalSettings(file: File) {
    await run("应用本地设置", async () => applySettingsText(await file.text()));
  }

  async function exportSettings() {
    await run("导出专页设置", async () => {
      const current = await callBackgroundValue<PageAutomationState>({ action: "getBotcakePageState", pageId });
      const template = extractPageSettingsTemplate(current, `设置-${pageId}`);
      const bytes = new TextEncoder().encode(serializePageSettingsTemplate(template));
      await downloadBytes(bytes, `设置-${pageId}.json`, "application/json");
      setState(current);
      setNotice({ kind: "success", text: "已导出当前专页设置 JSON" });
    });
  }

  async function applySettingsText(text: string) {
    const template = parsePageSettingsTemplate(text);
    const updated = await callBackgroundValue<UpdatePageAutomationResult>({ action: "updateBotcakePageAutomation", pageId, payload: templateToUpdatePayload(template) });
    const fields = await callBackgroundValue<EnsureBotFieldsResult>({ action: "ensureBotcakeBotFields", pageId, fields: template.settings.botFields });
    setState(updated.state);
    setNotice({ kind: "success", text: `设置完成：更新 ${updated.changed.length} 项，新建机器人变量 ${fields.created.length} 个，恢复归档变量 ${fields.restored.length} 个` });
  }

  async function loadRemoteFlow(row: CatalogRow, target: FlowApplyTarget) {
    await run(`下载 ${row.name}`, async () => {
      const remote = await fetchBytes(normalizePublicDriveUrl(row.url));
      await selectFlowArchive(remote.bytes, row.name, target, target === "keyword" ? row : undefined);
    });
  }

  async function loadLocalFlow(file: File) {
    await run("打开本地流程", async () => selectFlowArchive(new Uint8Array(await file.arrayBuffer()), file.name, "comment"));
  }

  async function selectFlowArchive(bytes: Uint8Array, sourceName: string, target: FlowApplyTarget, targetKeywordRow?: CatalogRow) {
    const next = loadTemplateArchive(bytes, sourceName);
    setFlowTarget(target);
    setKeywordRow(targetKeywordRow);
    setLoaded(next); setValues(initialInputValues(next.template));
    if (next.template.inputs.length) {
      setView("inputs");
      setNotice({ kind: "success", text: `请填写 ${next.template.inputs.length} 个流程变量` });
      return;
    }
    await applyFlowDirect(next, {}, target, targetKeywordRow);
  }

  async function queueSelectedFlow() {
    if (!loaded) return;
    if (missingRequired) { setNotice({ kind: "error", text: `还有 ${missingRequired} 个必填变量未填写` }); return; }
    const label = flowTarget === "defaultReply" ? "准备默认回复流程" : flowTarget === "keyword" ? "准备关键词流程" : "准备评论私信流程";
    await run(label, async () => applyFlowDirect(loaded, values, flowTarget, keywordRow));
  }

  async function applyFlowDirect(next: LoadedTemplate, inputValues: Record<string, ImportInputValue>, target: FlowApplyTarget, targetKeywordRow?: CatalogRow) {
    const keyword = target === "keyword" ? targetKeywordRow : undefined;
    if (target === "keyword" && (!keyword?.keywords?.length || !keyword.name.trim())) {
      throw new Error("关键词模板缺少第三列关键词，多个关键词请用逗号分隔");
    }
    if (target === "comment") await chrome.storage.local.set({ applyWelcomeWithCommentFlow: applyWelcome });
    const prepared = await callBackgroundValue<PreparedBotcakeFlow>({
      action: "prepareBotcakeFlow",
      pageId,
      target,
      name: target === "keyword" ? keyword!.name : target === "defaultReply" ? (next.template.meta.name || "默认回复") : "评论",
      keywords: keyword?.keywords,
      enableAutoInbox: target === "comment",
    });
    if (Array.isArray(prepared.snapshot.post.blocks) && prepared.snapshot.post.blocks.length) {
      await callBackground({ action: "saveBackup", key: backupScopeKey(prepared), value: prepared.snapshot });
    }
    const compiled = await compileTemplate(next, inputValues, {
      getBotFields: () => callBackgroundValue<BotField[]>({ action: "getBotcakeBotFields", pageId }),
      createBotField: (name, type, value, description) => callBackgroundValue<BotField>({ action: "createBotcakeBotField", pageId, field: { name, type, value, description } }),
      getTags: () => callBackgroundValue<BotcakeTag[]>({ action: "getBotcakeTags", pageId }),
      createTag: (name) => callBackgroundValue<BotcakeTag>({ action: "createBotcakeTag", pageId, name }),
      uploadMedia: uploadServiceAdapter((media) => callBackgroundValue<Record<string, unknown>>({ action: "uploadBotcakeMedia", pageId, media })),
      fetchBytes,
      fetchText,
    }, prepared.snapshot);
    const savePayload = target === "keyword" ? { ...compiled.payload, name: keyword!.name } : target === "defaultReply" ? { ...compiled.payload, name: "默认回复" } : compiled.payload;
    const saved = await callBackgroundValue<{ success: boolean; result?: unknown }>({ action: "saveBotcakeFlow", pageId, payload: savePayload });
    if (!saved.success) throw new Error("Botcake 保存流程失败");
    await callBackgroundValue({
      action: "completeBotcakeFlow",
      pageId,
      payload: {
        target,
        flowId: prepared.snapshot.identity.flowId,
        applyWelcome: target === "comment" && applyWelcome,
        ...(prepared.keyword ? { keyword: { id: prepared.keyword.id, name: prepared.keyword.name, terms: prepared.keyword.terms } } : {}),
      },
    });
    const nextState = await callBackgroundValue<PageAutomationState>({ action: "getBotcakePageState", pageId });
    setState(nextState);
    setView("home");
    const details = [
      compiled.report.createdBotFields.length ? `新建变量 ${compiled.report.createdBotFields.length} 个` : "变量已映射",
      compiled.report.createdTags.length ? `新建标签 ${compiled.report.createdTags.length} 个` : compiled.report.mappedTags.length ? "标签已映射" : "无标签动作",
      compiled.report.uploadedMedia.length ? `上传素材 ${compiled.report.uploadedMedia.length} 个` : "无素材上传",
    ].join("，");
    setNotice({ kind: "success", text: `流程已直接替换：${details}，无需跳转页面` });
  }

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setNotice({ kind: "info", text: `${label}…` });
    try { await action(); } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(""); }
  }

  return <aside className={`bft-launch-card page-assistant ${view === "inputs" ? "show-inputs" : ""}`} style={style}>
    <header {...dragProps}>
      <div><strong>{view === "inputs" ? loaded?.template.meta.name : "Botcake 专页助手"}</strong><small>{view === "inputs" ? "填写流程需要的内容" : `专页 ${pageId}`}</small></div>
      {view === "home" && <div className="header-local-loads"><button type="button" onClick={() => void exportSettings()} disabled={Boolean(busy)}>导出专页<br />设置 JSON</button><label>本地加载<br />设置 JSON<input type="file" accept=".json,application/json" onChange={(event) => event.target.files?.[0] && void loadLocalSettings(event.target.files[0])} /></label><label>本地加载<br />流程 ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => event.target.files?.[0] && void loadLocalFlow(event.target.files[0])} /></label></div>}
      <div className="bft-header-actions">
        {view === "inputs" && <button onClick={() => setView("home")}>返回</button>}
        <button className="icon" aria-label="收起" onClick={onClose}>×</button>
      </div>
    </header>
    <div className={`page-assistant-notice ${notice.kind}`}>{busy && <span className="spinner" />}{notice.text}</div>
    <div className="page-assistant-viewport"><div className="page-assistant-slides">
      <div className="page-assistant-body page-home-view">
        <ResourceSection title="专页设置">{settingsRows.map((row) => <ResourceRow key={`${row.name}-${row.url}`} row={row} action="应用设置" disabled={Boolean(busy)} onClick={() => void applySettings(row)} />)}</ResourceSection>
        {!!flowRows.length && <section className="resource-section"><div className="resource-section-title"><h3>评论私信流程</h3><label className="welcome-toggle"><input type="checkbox" checked={applyWelcome} onChange={(event) => { setApplyWelcome(event.target.checked); void chrome.storage.local.set({ applyWelcomeWithCommentFlow: event.target.checked }); }} /><span>同步欢迎信息流程</span></label></div>
          {flowRows.map((row) => <ResourceRow key={`${row.name}-${row.url}`} row={row} action="应用评论私信" disabled={Boolean(busy)} onClick={() => void loadRemoteFlow(row, "comment")} />)}
        </section>}
        <ResourceSection title="默认回复流程">{defaultReplyRows.map((row) => <ResourceRow key={`${row.name}-${row.url}`} row={row} action="应用默认回复" disabled={Boolean(busy)} onClick={() => void loadRemoteFlow(row, "defaultReply")} />)}</ResourceSection>
        <ResourceSection title="关键词流程">{keywordRows.map((row) => <ResourceRow key={`${row.name}-${row.url}`} row={row} action="应用关键词流程" disabled={Boolean(busy) || !row.keywords?.length} onClick={() => void loadRemoteFlow(row, "keyword")} />)}</ResourceSection>
        {state?.defaultPrivateReply && <p className="current-flow-note">当前评论流程：{state.defaultPrivateReply.name}</p>}
        {state?.defaultReply && <p className="current-flow-note">当前默认回复：{state.defaultReply.name}</p>}
      </div>
      <div className="page-assistant-body page-input-view">
        <div className="input-intro"><strong>填写流程变量</strong><span>变量名称和说明来自资源包，完成后将在后台直接替换{flowTarget === "defaultReply" ? "默认回复" : flowTarget === "keyword" ? "关键词" : "评论私信"} Flow，不会跳转页面。</span></div>
        {loaded?.template.inputs.map((input) => <TemplateInputControl key={input.key} input={input} value={values[input.key] ?? {}} assets={loaded.assets} onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))} />)}
        <button className="primary sticky-apply" onClick={() => void queueSelectedFlow()} disabled={Boolean(busy) || !loaded}>应用{flowTarget === "defaultReply" ? "默认回复" : flowTarget === "keyword" ? "关键词流程" : "评论私信"}{missingRequired ? `（缺 ${missingRequired} 项）` : ""}</button>
      </div>
    </div></div>
  </aside>;
}

async function readPageStateWithRetry(pageId: string): Promise<PageAutomationState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await callBackgroundValue<PageAutomationState>({ action: "getBotcakePageState", pageId }); }
    catch (error) {
      lastError = error;
      if (attempt < 7) await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("无法读取当前专页设置");
}

function backupScopeKey(prepared: PreparedBotcakeFlow): string {
  return prepared.target === "defaultReply"
    ? `${prepared.snapshot.identity.pageId}:defaultReply`
    : `${prepared.snapshot.identity.pageId}:${prepared.snapshot.identity.flowId}`;
}

function ResourceSection({ title, children }: { title: string; children: ReactNode }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (!rows.length) return null;
  return <section className="resource-section"><h3>{title}</h3>{children}</section>;
}

function ResourceRow({ row, action, disabled, onClick }: { row: CatalogRow; action: string; disabled: boolean; onClick: () => void }) {
  const detail = row.kind === "keyword"
    ? row.keywords?.length ? `包含任一：${row.keywords.join("、")}` : "缺少第三列关键词"
    : row.description;
  return <div className="resource-row"><div><strong>{row.name}</strong>{detail && <small>{detail}</small>}</div><button onClick={onClick} disabled={disabled}>{action}</button></div>;
}
