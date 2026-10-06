export function isAllowedBackgroundSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  try {
    const url = new URL(sender.url ?? "");
    // Options pages may themselves be open in a browser tab.
    if (url.protocol === "chrome-extension:" && url.hostname === extensionId) return true;
    return Boolean(sender.tab) && sender.frameId === 0 && url.origin === "https://botcake.io";
  } catch { return false; }
}
