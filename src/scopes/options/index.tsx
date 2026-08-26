import React from "react";
import { createRoot } from "react-dom/client";

const analyticsView = new URLSearchParams(location.search).get("view") === "analytics";
const root = createRoot(document.getElementById("root")!);

if (analyticsView) {
  document.title = "Botcake 引流数据";
  document.documentElement.style.height = "100%";
  document.documentElement.style.overflow = "hidden";
  document.body.style.height = "100%";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  const rootElement = document.getElementById("root")!;
  rootElement.style.height = "100%";
  rootElement.style.overflow = "auto";
  void import("./AnalyticsDashboardApp").then(({ AnalyticsDashboardApp }) => {
    root.render(<React.StrictMode><AnalyticsDashboardApp /></React.StrictMode>);
  });
} else {
  document.title = "Botcake 模板编辑器";
  void Promise.all([
    import("@xyflow/react/dist/style.css"),
    import("./style.css"),
    import("./TemplateEditorApp"),
  ]).then(([, , { TemplateEditorApp }]) => {
    root.render(<React.StrictMode><TemplateEditorApp /></React.StrictMode>);
  });
}
