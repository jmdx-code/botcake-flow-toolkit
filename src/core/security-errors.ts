/** Keep actionable API errors without echoing the request credential. */
export function redactCredential(detail: string, token: string): string {
  let result = detail;
  for (const value of new Set([token, encodeURIComponent(token)])) {
    if (value) result = result.split(value).join("[REDACTED]");
  }
  result = result.replace(/(\b(?:access_token|refresh_token|token_jwt|token|authorization|api[_-]?key|password|client_secret)["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?([^\s"'&,}]+)/gi, "$1[REDACTED]");
  return result.slice(0, 500);
}
