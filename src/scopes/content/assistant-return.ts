const OPEN_ASSISTANT_HASH = "#bft-open-assistant";
const OPEN_ON_ARRIVAL_KEY = "botcake-flow-toolkit:open-assistant-on-arrival";

/** 保存站内相对地址，避免把扩展自身的一次性打开标记带回去。 */
export function captureAssistantReturnUrl(): string {
  const hash = location.hash === OPEN_ASSISTANT_HASH ? "" : location.hash;
  return `${location.pathname}${location.search}${hash}`;
}

/** 只允许返回同一专页下的 Botcake 页面。 */
export function resolveAssistantReturnUrl(value: string | undefined, pageId: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith(`/${pageId}/`)) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function requestAssistantOpenOnArrival(): void {
  try { sessionStorage.setItem(OPEN_ON_ARRIVAL_KEY, "1"); } catch { /* ignore unavailable session storage */ }
}

export function consumeAssistantOpenOnArrival(): boolean {
  try {
    const requested = sessionStorage.getItem(OPEN_ON_ARRIVAL_KEY) === "1";
    if (requested) sessionStorage.removeItem(OPEN_ON_ARRIVAL_KEY);
    return requested;
  } catch {
    return false;
  }
}

export function reloadWithAssistantOpen(delay = 0): void {
  window.setTimeout(() => {
    requestAssistantOpenOnArrival();
    location.reload();
  }, delay);
}
