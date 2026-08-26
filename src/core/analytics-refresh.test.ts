import { describe, expect, it } from "vitest";
import { isAnalyticsDashboardUrl } from "./analytics-refresh";

const extensionOptionsUrl = "chrome-extension://extension-id/src/scopes/options/index.html";

describe("analytics auto refresh route detection", () => {
  it("recognizes the current Botcake dashboard route", () => {
    expect(isAnalyticsDashboardUrl(
      "https://botcake.io/dashboard?botcake_flow_toolkit=analytics",
      extensionOptionsUrl,
    )).toBe(true);
  });

  it("keeps compatibility with the legacy extension options route", () => {
    expect(isAnalyticsDashboardUrl(
      `${extensionOptionsUrl}?view=analytics`,
      extensionOptionsUrl,
    )).toBe(true);
  });

  it("does not treat an ordinary Botcake dashboard as the analytics view", () => {
    expect(isAnalyticsDashboardUrl("https://botcake.io/dashboard", extensionOptionsUrl)).toBe(false);
  });
});
