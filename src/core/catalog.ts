import Papa from "papaparse";
import type { CatalogRow } from "../shared/types";

export function sheetUrlToCsv(url: string): string {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) throw new Error("请输入带 gid 的 Google 表格链接");
  const gid = parsed.searchParams.get("gid") ?? parsed.hash.match(/gid=(\d+)/)?.[1];
  if (!gid) throw new Error("表格链接缺少 gid");
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}

export function normalizePublicDriveUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === "docs.google.com") {
    const documentMatch = parsed.pathname.match(/\/document\/d\/([^/]+)/);
    if (documentMatch) return `https://docs.google.com/document/d/${documentMatch[1]}/export?format=txt`;
  }
  if (!parsed.hostname.endsWith("drive.google.com")) return url;
  const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
  const id = fileMatch?.[1] ?? parsed.searchParams.get("id");
  if (!id) return url;
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

export function parseCatalogCsv(csv: string): CatalogRow[] {
  const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: true });
  if (parsed.errors.length && !parsed.data.length) throw new Error(`CSV 解析失败：${parsed.errors[0].message}`);
  const rows = parsed.data.map((row) => row.map((value) => String(value ?? "").trim()));
  if (!rows.length) return [];
  const headers = isHeaderRow(rows[0]) ? rows.shift()!.map((value) => value.trim()) : undefined;
  return rows.flatMap((columns) => {
    const normalized = headers
      ? normalizeKeys(Object.fromEntries(headers.map((key, index) => [key, columns[index] ?? ""])))
      : {};
    const name = pick(normalized, "name", "模板名称", "名称", "模板", "选项") || columns[0] || "";
    const url = pick(normalized, "url", "资源网盘链接", "资源包链接", "链接", "zip", "流程") || columns[1] || "";
    if (!name || !url) return [];
    const kind = catalogKind(name);
    if (!kind) return [];
    const enabledRaw = (pick(normalized, "enabled", "启用", "状态") || (!headers ? columns[4] ?? "" : "")).toLowerCase();
    const keywordsRaw = kind === "keyword"
      ? pick(normalized, "keywords", "关键词", "触发关键词") || columns[2] || ""
      : "";
    return [{
      name,
      kind,
      url,
      version: pick(normalized, "version", "版本") || (!headers && kind !== "keyword" ? columns[2] : "") || undefined,
      description: pick(normalized, "description", "说明", "描述") || (!headers ? columns[3] : "") || undefined,
      ...(kind === "keyword" ? { keywords: parseKeywordTerms(keywordsRaw) } : {}),
      enabled: !["0", "false", "否", "停用", "disabled"].includes(enabledRaw),
    }];
  });
}

export function catalogKind(name: string): CatalogRow["kind"] | undefined {
  const normalized = name.trim();
  if (normalized.startsWith("设置")) return "settings";
  if (normalized.startsWith("默认回复")) return "defaultReply";
  if (normalized.startsWith("关键词")) return "keyword";
  if (normalized.startsWith("流程")) return "flow";
  return undefined;
}

export function parseKeywordTerms(value: string): string[] {
  return [...new Set(value
    .split(/[,，]/)
    .map((term) => term.trim())
    .filter(Boolean))];
}

function normalizeKeys(row: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim(), String(value ?? "").trim()]));
}

function isHeaderRow(row: string[]): boolean {
  const keys = new Set(row.map((value) => value.trim().toLocaleLowerCase()));
  const nameHeaders = ["name", "模板名称", "名称", "模板", "选项"];
  const urlHeaders = ["url", "资源网盘链接", "资源包链接", "链接", "zip", "流程"];
  return nameHeaders.some((key) => keys.has(key)) && urlHeaders.some((key) => keys.has(key));
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) if (row[key]) return row[key];
  return "";
}
