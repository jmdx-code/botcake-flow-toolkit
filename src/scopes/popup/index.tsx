import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseCatalogCsv, sheetUrlToCsv } from "../../core/catalog";
import type { BackgroundRequest, BackgroundResponse } from "../../shared/background-protocol";
import "./style.css";

const BOTCAKE_URL_RE = /^https:\/\/botcake\.io(?:\/|$)/;
const FLOW_URL_RE = /^https:\/\/botcake\.io\/\d+\/(?:flows\/\d+\/content|default\/edit)(?:[/?#]|$)/;

function PopupApp() {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [connection, setConnection] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [catalogStatus, setCatalogStatus] = useState("");
  const [tokenStatus, setTokenStatus] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([activeTab]) => {
      setTab(activeTab);
      if (!activeTab?.id || !activeTab.url || !BOTCAKE_URL_RE.test(activeTab.url)) return;
      try {
        await assertPageAssistantConnected(activeTab.id);
        setConnection("页面浮标已连接");
      } catch {
        try {
          await reinjectPageAssistant(activeTab.id);
          setConnection("页面浮标已重新连接");
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setConnection(/Could not load|找不到|不存在|动态模块|import/i.test(detail)
            ? "扩展文件已更新，请在扩展管理页重新加载扩展"
            : "页面浮标连接失败，请重新加载扩展后刷新 Botcake 页面");
        }
      }
    });
  }, []);

  useEffect(() => {
    void chrome.storage.local.get("catalogSheetUrl").then((value) => {
      setSheetUrl(String(value.catalogSheetUrl ?? ""));
      initialized.current = true;
    });
  }, []);

  useEffect(() => {
    if (!initialized.current) return;
    const timer = window.setTimeout(() => {
      if (sheetUrl.trim()) void saveAndReadCatalog(sheetUrl, false);
      else void chrome.storage.local.remove(["catalogSheetUrl", "catalogCsvCache"]).then(() => setCatalogStatus("已清空资源控制台"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [sheetUrl]);

  const isFlowPage = Boolean(tab?.url && FLOW_URL_RE.test(tab.url));
  const isBotcakePage = Boolean(tab?.url && BOTCAKE_URL_RE.test(tab.url));

  async function openTemplateEditor() {
    await chrome.runtime.openOptionsPage();
    window.close();
  }

  async function openAnalyticsDashboard() {
    await chrome.tabs.create({ url: "https://botcake.io/dashboard?botcake_flow_toolkit=analytics" });
    window.close();
  }

  async function openBotcake() {
    await chrome.tabs.create({ url: "https://botcake.io/dashboard?#_=" });
    window.close();
  }

  async function copyBotcakeToken() {
    setTokenLoading(true);
    setTokenStatus("正在读取 Botcake Token…");
    try {
      const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse>({ action: "getBotcakeAccessToken" });
      const token = response?.ok && "value" in response && typeof response.value === "string" ? response.value : "";
      if (!token) throw new Error(response?.ok ? "没有读取到有效 Token" : response?.error ?? "Token 读取失败");
      await copyText(token);
      setTokenStatus(`Token 已复制 · ••••${token.slice(-4)}`);
    } catch (error) {
      setTokenStatus(error instanceof Error ? error.message : String(error));
    } finally { setTokenLoading(false); }
  }

  async function saveAndReadCatalog(url: string, forceRefresh: boolean) {
    try {
      setCatalogStatus("正在读取控制台…");
      const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse>({ action: "fetchCatalog", url: sheetUrlToCsv(url), forceRefresh });
      if (!response?.ok || !("text" in response)) throw new Error(response?.ok ? "返回内容不是表格" : response?.error ?? "读取失败");
      const rows = parseCatalogCsv(response.text).filter((row) => row.enabled);
      const settings = rows.filter((row) => row.kind === "settings").length;
      const flows = rows.filter((row) => row.kind === "flow").length;
      const defaultReplies = rows.filter((row) => row.kind === "defaultReply").length;
      const keywords = rows.filter((row) => row.kind === "keyword").length;
      if (!rows.length) throw new Error("没有识别到以“设置”“流程”“默认回复”或“关键词”开头的资源");
      await chrome.storage.local.set({ catalogSheetUrl: url.trim() });
      const source = "cache" in response ? response.cache === "fresh" ? "缓存" : response.cache === "stale" ? "上次缓存（网络失败）" : "最新数据" : "数据";
      setCatalogStatus(`已保存：${settings} 个设置，${flows} 个流程，${defaultReplies} 个默认回复，${keywords} 个关键词 · ${source}`);
    } catch (error) {
      setCatalogStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return <main className="popup-shell">
    <header><div className="brand-mark"><img src={chrome.runtime.getURL("icons/icon-48.png")} alt="" /></div><div><strong>Botcake 流程助手</strong><span>{isFlowPage ? "已识别当前 Flow 页面" : isBotcakePage ? "Botcake 页面浮标已启用" : "当前页面不是 Botcake"}</span></div></header>
    <section className="launcher-list">
      <button className="launcher" onClick={openBotcake}><span className="launcher-icon">B</span><div><strong>打开 Botcake</strong><small>进入 Botcake 工作台</small></div></button>
      <button className="launcher" onClick={openAnalyticsDashboard}><span className="launcher-icon">▥</span><div><strong>引流数据中心</strong><small>查看多专页引流趋势和最近错误</small></div></button>
      <div className="launcher-row">
        <button className="launcher" onClick={openTemplateEditor}><span className="launcher-icon">✎</span><div><strong>模板编辑器</strong><small>打开 ZIP、编辑节点并导出模板</small></div></button>
        <button className="launcher token-launcher" disabled={tokenLoading} onClick={() => void copyBotcakeToken()} title="读取并复制当前登录的 Botcake Token"><span className="launcher-icon">⌘</span><div><strong>{tokenLoading ? "读取中…" : "获取 Token"}</strong><small>读取并复制</small></div></button>
      </div>
    </section>
    {tokenStatus && <p className={`popup-status token-status ${/失败|没有|无法|请先|错误/.test(tokenStatus) ? "error" : ""}`}>{tokenStatus}</p>}
    <section className="catalog-console">
      <label>资源控制台表格</label>
      <div className="catalog-input-row"><input value={sheetUrl} onChange={(event) => setSheetUrl(event.target.value)} placeholder="粘贴带 gid 的公开 Google 表格链接" /><button disabled={!sheetUrl.trim()} onClick={() => void saveAndReadCatalog(sheetUrl, true)}>重新读取</button></div>
      <small>前两列为名称、资源网盘链接；“关键词”资源第三列填写逗号分隔的多个关键词。</small>
      {catalogStatus && <p className={`catalog-status ${/失败|没有|错误|缺少/.test(catalogStatus) ? "error" : ""}`}>{catalogStatus}</p>}
    </section>
    {isBotcakePage && connection && <p className={`popup-status ${connection.includes("失败") ? "error" : ""}`}>{connection}</p>}
  </main>;
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("复制失败，请检查浏览器剪贴板权限");
  }
}

async function reinjectPageAssistant(tabId: number): Promise<void> {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  const scriptWorld = (script: (typeof scripts)[number]) => (script as typeof script & { world?: string }).world;
  const mainFiles = scripts.find((script) => scriptWorld(script) === "MAIN")?.js ?? [];
  const contentFiles = scripts.find((script) => scriptWorld(script) !== "MAIN")?.js ?? [];
  if (!mainFiles.length || !contentFiles.length) throw new Error("扩展注入脚本缺失");
  await chrome.scripting.executeScript({ target: { tabId }, files: mainFiles, world: "MAIN" });
  await chrome.scripting.executeScript({ target: { tabId }, files: contentFiles, world: "ISOLATED" });
  await waitForPageAssistant(tabId);
}

async function assertPageAssistantConnected(tabId: number): Promise<void> {
  const response = await chrome.tabs.sendMessage(tabId, { action: "ensureInjected" }) as { ok?: boolean; host?: boolean } | undefined;
  if (!response?.ok || !response.host) throw new Error("页面助手尚未挂载");
}

async function waitForPageAssistant(tabId: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await assertPageAssistantConnected(tabId);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("页面助手加载超时");
}

createRoot(document.getElementById("root")!).render(<PopupApp />);
