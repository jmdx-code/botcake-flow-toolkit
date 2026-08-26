import type { AnalyticsPage } from "../shared/types";

export type ManagedTokenPages = { id: string; pages: AnalyticsPage[] };
export type ManagedTokenGrant = ManagedTokenPages & { token: string };

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

export function groupManagedTokenCandidates(records: ManagedTokenGrant[]): Record<string, string[]> {
  const candidates: Record<string, string[]> = {};
  for (const record of records) {
    const token = record.token.trim();
    if (!token) continue;
    for (const page of record.pages) {
      if (!/^\d{8,}$/.test(page.id)) continue;
      const pageTokens = candidates[page.id] ??= [];
      if (!pageTokens.includes(token)) pageTokens.push(token);
    }
  }
  return candidates;
}

export async function runWithTokenFallback<T>(
  tokens: string[],
  task: (token: string) => Promise<T>,
  shouldFallback: (reason: unknown) => boolean,
): Promise<T> {
  if (!tokens.length) throw new Error("没有可用的 Botcake Token");
  let lastError: unknown;
  for (let index = 0; index < tokens.length; index += 1) {
    try {
      return await task(tokens[index]);
    } catch (reason) {
      lastError = reason;
      if (index === tokens.length - 1 || !shouldFallback(reason)) throw reason;
    }
  }
  throw lastError;
}
