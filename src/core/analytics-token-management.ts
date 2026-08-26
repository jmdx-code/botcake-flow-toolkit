import type { AnalyticsPage } from "../shared/types";

export type ManagedTokenPages = { id: string; pages: AnalyticsPage[] };

export function mergeManagedTokenPages(records: ManagedTokenPages[]): AnalyticsPage[] {
  const pages = new Map<string, AnalyticsPage>();
  for (const record of records) {
    for (const page of record.pages) {
      if (!/^\d{8,}$/.test(page.id)) continue;
      const current = pages.get(page.id);
      pages.set(page.id, {
        id: page.id,
        name: page.name || current?.name || `专页 ${page.id}`,
        avatarUrl: page.avatarUrl || current?.avatarUrl,
        platform: page.platform || current?.platform,
      });
    }
  }
  return [...pages.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
