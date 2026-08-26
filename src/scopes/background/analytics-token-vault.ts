import type { AnalyticsPage } from "../../shared/types";
import { groupManagedTokenCandidates } from "../../core/analytics-token-management";

const VAULT_KEY_STORAGE = "analyticsTokenVaultKey";
const VAULT_DATA_STORAGE = "analyticsExternalPageTokensEncrypted";
const LEGACY_SESSION_STORAGE = "analyticsExternalPageTokens";
const PRIMARY_TOKEN_STORAGE = "analyticsPrimaryTokenEncrypted";
const MANAGED_TOKENS_STORAGE = "analyticsManagedTokensEncryptedV1";
const MANAGED_TOKENS_INITIALIZED = "analyticsManagedTokensInitializedV1";

type EncryptedToken = { iv: string; data: string };
type EncryptedManagedToken = EncryptedToken & { label: string; pages: AnalyticsPage[]; addedAt: number };
export type AnalyticsManagedTokenRecord = { id: string; token: string; label: string; pages: AnalyticsPage[]; addedAt: number };

export async function readAnalyticsPrimaryToken(): Promise<{ token: string; expiresAt: number } | undefined> {
  const stored = await chrome.storage.local.get([VAULT_KEY_STORAGE, PRIMARY_TOKEN_STORAGE]);
  const encrypted = stored[PRIMARY_TOKEN_STORAGE];
  if (!isEncryptedToken(encrypted)) return undefined;
  try {
    const key = await getVaultKey(stored[VAULT_KEY_STORAGE]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(fromBase64(encrypted.iv)) }, key, toArrayBuffer(fromBase64(encrypted.data)));
    const value = JSON.parse(new TextDecoder().decode(plain)) as { token?: unknown; expiresAt?: unknown };
    if (typeof value.token !== "string" || !isUsableToken(value.token) || typeof value.expiresAt !== "number") return undefined;
    return { token: value.token, expiresAt: value.expiresAt };
  } catch { return undefined; }
}

export async function writeAnalyticsPrimaryToken(token: string, expiresAt: number): Promise<void> {
  if (!isUsableToken(token)) return;
  const stored = await chrome.storage.local.get(VAULT_KEY_STORAGE);
  const key = await getVaultKey(stored[VAULT_KEY_STORAGE]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, new TextEncoder().encode(JSON.stringify({ token, expiresAt })));
  await chrome.storage.local.set({ [PRIMARY_TOKEN_STORAGE]: { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) } satisfies EncryptedToken });
}

export async function readAnalyticsExternalTokenCandidates(): Promise<Record<string, string[]>> {
  const managed = await readAnalyticsManagedTokens();
  return groupManagedTokenCandidates(managed);
}

export async function readAnalyticsManagedTokens(): Promise<AnalyticsManagedTokenRecord[]> {
  const initialized = (await chrome.storage.local.get(MANAGED_TOKENS_INITIALIZED))[MANAGED_TOKENS_INITIALIZED] === true;
  if (!initialized) {
    const legacy = await readLegacyExternalTokens();
    const grouped = new Map<string, AnalyticsManagedTokenRecord>();
    for (const [pageId, token] of Object.entries(legacy)) {
      const id = await tokenIdentifier(token);
      const current = grouped.get(id) ?? { id, token, label: tokenLabel(token), pages: [], addedAt: Date.now() };
      current.pages.push({ id: pageId, name: `专页 ${pageId}` });
      grouped.set(id, current);
    }
    await writeAnalyticsManagedTokens([...grouped.values()]);
    await chrome.storage.local.remove(VAULT_DATA_STORAGE);
    return [...grouped.values()];
  }
  const stored = await chrome.storage.local.get([VAULT_KEY_STORAGE, MANAGED_TOKENS_STORAGE]);
  const encrypted = stored[MANAGED_TOKENS_STORAGE];
  if (!encrypted || typeof encrypted !== "object" || Array.isArray(encrypted)) return [];
  const key = await getVaultKey(stored[VAULT_KEY_STORAGE]);
  const records: AnalyticsManagedTokenRecord[] = [];
  for (const [id, value] of Object.entries(encrypted as Record<string, unknown>)) {
    if (!isEncryptedManagedToken(value)) continue;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(fromBase64(value.iv)) }, key, toArrayBuffer(fromBase64(value.data)));
      const token = new TextDecoder().decode(plain);
      if (!isUsableToken(token)) continue;
      records.push({ id, token, label: value.label || tokenLabel(token), pages: normalizePages(value.pages), addedAt: value.addedAt });
    } catch { /* 单个 Token 损坏时忽略 */ }
  }
  return records.sort((a, b) => a.addedAt - b.addedAt);
}

export async function writeAnalyticsManagedTokens(records: AnalyticsManagedTokenRecord[]): Promise<void> {
  const stored = await chrome.storage.local.get(VAULT_KEY_STORAGE);
  const key = await getVaultKey(stored[VAULT_KEY_STORAGE]);
  const encrypted: Record<string, EncryptedManagedToken> = {};
  for (const record of records) {
    if (!isUsableToken(record.token)) continue;
    const id = record.id || await tokenIdentifier(record.token);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, new TextEncoder().encode(record.token));
    encrypted[id] = {
      iv: toBase64(iv), data: toBase64(new Uint8Array(data)), label: record.label || tokenLabel(record.token),
      pages: normalizePages(record.pages), addedAt: Number.isFinite(record.addedAt) ? record.addedAt : Date.now(),
    };
  }
  await chrome.storage.local.set({ [MANAGED_TOKENS_STORAGE]: encrypted, [MANAGED_TOKENS_INITIALIZED]: true });
}

export async function createAnalyticsManagedToken(token: string, pages: AnalyticsPage[], addedAt = Date.now()): Promise<AnalyticsManagedTokenRecord> {
  const normalized = token.trim();
  if (!isUsableToken(normalized)) throw new Error("Token 格式无效");
  return { id: await tokenIdentifier(normalized), token: normalized, label: tokenLabel(normalized), pages: normalizePages(pages), addedAt };
}

async function readLegacyExternalTokens(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get([VAULT_KEY_STORAGE, VAULT_DATA_STORAGE]);
  const encrypted = stored[VAULT_DATA_STORAGE];
  const result: Record<string, string> = {};
  if (encrypted && typeof encrypted === "object" && !Array.isArray(encrypted)) {
    const key = await getVaultKey(stored[VAULT_KEY_STORAGE]);
    for (const [pageId, value] of Object.entries(encrypted as Record<string, unknown>)) {
      if (!/^\d{8,}$/.test(pageId) || !isEncryptedToken(value)) continue;
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(fromBase64(value.iv)) }, key, toArrayBuffer(fromBase64(value.data)));
        const token = new TextDecoder().decode(plain);
        if (isUsableToken(token)) result[pageId] = token;
      } catch { /* 单条缓存损坏时忽略，不影响其他专页 */ }
    }
  }
  const legacy = await chrome.storage.session.get(LEGACY_SESSION_STORAGE);
  const legacyTokens = normalizeTokenMap(legacy[LEGACY_SESSION_STORAGE]);
  if (Object.keys(legacyTokens).length) {
    Object.assign(result, legacyTokens);
    await writeAnalyticsExternalTokens(result);
    await chrome.storage.session.remove(LEGACY_SESSION_STORAGE);
  }
  return result;
}

export async function mergeAnalyticsExternalTokens(updates: Record<string, string>): Promise<void> {
  const current = await readAnalyticsManagedTokens();
  for (const [pageId, token] of Object.entries(updates)) {
    if (!/^\d{8,}$/.test(pageId) || !isUsableToken(token)) continue;
    const id = await tokenIdentifier(token);
    const record = current.find((item) => item.id === id) ?? await createAnalyticsManagedToken(token, []);
    if (!record.pages.some((page) => page.id === pageId)) record.pages.push({ id: pageId, name: `专页 ${pageId}` });
    if (!current.some((item) => item.id === id)) current.push(record);
  }
  await writeAnalyticsManagedTokens(current);
}

async function writeAnalyticsExternalTokens(tokens: Record<string, string>): Promise<void> {
  const stored = await chrome.storage.local.get(VAULT_KEY_STORAGE);
  const key = await getVaultKey(stored[VAULT_KEY_STORAGE]);
  const encrypted: Record<string, EncryptedToken> = {};
  for (const [pageId, token] of Object.entries(tokens)) {
    if (!/^\d{8,}$/.test(pageId) || !isUsableToken(token)) continue;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, new TextEncoder().encode(token));
    encrypted[pageId] = { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }
  await chrome.storage.local.set({ [VAULT_DATA_STORAGE]: encrypted });
}

async function getVaultKey(encoded: unknown): Promise<CryptoKey> {
  let raw: Uint8Array;
  if (typeof encoded === "string") {
    try { raw = fromBase64(encoded); } catch { raw = new Uint8Array(); }
  } else raw = new Uint8Array();
  if (raw.byteLength !== 32) {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await chrome.storage.local.set({ [VAULT_KEY_STORAGE]: toBase64(raw) });
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function isEncryptedToken(value: unknown): value is EncryptedToken {
  return Boolean(value && typeof value === "object" && typeof (value as EncryptedToken).iv === "string" && typeof (value as EncryptedToken).data === "string");
}

function isEncryptedManagedToken(value: unknown): value is EncryptedManagedToken {
  return isEncryptedToken(value)
    && typeof (value as EncryptedManagedToken).label === "string"
    && Array.isArray((value as EncryptedManagedToken).pages)
    && typeof (value as EncryptedManagedToken).addedAt === "number";
}

function normalizePages(value: unknown): AnalyticsPage[] {
  if (!Array.isArray(value)) return [];
  const pages = new Map<string, AnalyticsPage>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const page = item as Partial<AnalyticsPage>;
    const id = String(page.id ?? "").trim();
    if (!/^\d{8,}$/.test(id)) continue;
    pages.set(id, {
      id,
      name: typeof page.name === "string" && page.name.trim() ? page.name.trim() : `专页 ${id}`,
      avatarUrl: typeof page.avatarUrl === "string" ? page.avatarUrl : undefined,
      platform: typeof page.platform === "string" ? page.platform : undefined,
    });
  }
  return [...pages.values()];
}

async function tokenIdentifier(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.trim()));
  return [...new Uint8Array(digest)].slice(0, 12).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function tokenLabel(token: string): string {
  const normalized = token.trim();
  return `Token ••••${normalized.slice(-4)}`;
}

function normalizeTokenMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [pageId, token] of Object.entries(value as Record<string, unknown>)) if (/^\d{8,}$/.test(pageId) && typeof token === "string" && isUsableToken(token)) result[pageId] = token;
  return result;
}

function isUsableToken(token: string): boolean { return token.trim().length >= 20 && !/\s/.test(token); }
function toBase64(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
