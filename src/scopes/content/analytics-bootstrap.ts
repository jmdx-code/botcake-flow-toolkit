const ANALYTICS_BOOTSTRAP_ID = "botcake-analytics-bootstrap-host";
const analyticsView = new URLSearchParams(location.search).get("botcake_flow_toolkit") === "analytics";

if (analyticsView && !document.getElementById(ANALYTICS_BOOTSTRAP_ID)) {
  const host = document.createElement("div");
  host.id = ANALYTICS_BOOTSTRAP_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial;position:fixed;inset:0;z-index:2147483647;display:grid;background:#f5f8f8;color:#17242c;font-family:Inter,"Microsoft YaHei","PingFang SC",system-ui,sans-serif;place-items:center}
    .boot{display:grid;gap:12px;justify-items:center;color:#6b7b85;font-size:12px}
    .mark{position:relative;width:34px;height:34px;border:3px solid #d6e9e7;border-top-color:#07827b;border-radius:50%;animation:spin .8s linear infinite}
    strong{color:#17242c;font-size:14px}
    @keyframes spin{to{transform:rotate(360deg)}}
  `;
  const loading = document.createElement("div");
  loading.className = "boot";
  loading.setAttribute("role", "status");
  loading.innerHTML = '<span class="mark" aria-hidden="true"></span><strong>正在打开引流数据</strong><span>正在准备看板资源…</span>';
  shadow.append(style, loading);
  document.documentElement.appendChild(host);
  document.documentElement.style.setProperty("overflow", "hidden", "important");
}
