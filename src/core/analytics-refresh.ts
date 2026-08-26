export function isAnalyticsDashboardUrl(url: string, extensionOptionsUrl: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin === "https://botcake.io" && parsed.pathname === "/dashboard") {
      return parsed.searchParams.get("botcake_flow_toolkit") === "analytics";
    }
    if (!url.startsWith(extensionOptionsUrl)) return false;
    return parsed.searchParams.get("view") === "analytics";
  } catch {
    return false;
  }
}
