import type { AnalyticsDailyPoint } from "../shared/types";

export type TrafficAggregate = {
  todayHours: number[];
  yesterdayHours: number[];
  daily: AnalyticsDailyPoint[];
  todayTotal: number;
  yesterdayTotal: number;
  rangeTotal: number;
  gender: { female: number; male: number; unknown: number };
};

export function aggregateCustomerTraffic(
  customers: Record<string, unknown>[],
  options: { timezone: string; startDate: string; endDate: string; today: string; yesterday: string },
): TrafficAggregate {
  assertTimezone(options.timezone);
  const todayHours = Array(24).fill(0) as number[];
  const yesterdayHours = Array(24).fill(0) as number[];
  const daily = enumerateIsoDates(options.startDate, options.endDate).map((date) => ({ date, count: 0 }));
  const dailyMap = new Map(daily.map((point) => [point.date, point]));
  const seen = new Set<string>();
  const gender = { female: 0, male: 0, unknown: 0 };

  for (const customer of customers) {
    const subscribedAt = parseAnalyticsTimestamp(customer.last_subscribed_at ?? customer.subscribed_at ?? customer.inserted_at);
    if (!Number.isFinite(subscribedAt) || subscribedAt <= 0) continue;
    const customerId = String(customer.id ?? customer.psid ?? "");
    const key = `${customerId}:${subscribedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = analyticsDateParts(subscribedAt, options.timezone);
    if (parts.date === options.today) todayHours[parts.hour] += 1;
    if (parts.date === options.yesterday) yesterdayHours[parts.hour] += 1;
    const point = dailyMap.get(parts.date);
    if (point) {
      point.count += 1;
      gender[normalizeGender(customer.gender)] += 1;
    }
  }

  return {
    todayHours,
    yesterdayHours,
    daily,
    todayTotal: todayHours.reduce(sumNumbers, 0),
    yesterdayTotal: yesterdayHours.reduce(sumNumbers, 0),
    rangeTotal: daily.reduce((sum, point) => sum + point.count, 0),
    gender,
  };
}

export function countCustomerTrafficThroughTime(
  customers: Record<string, unknown>[],
  options: { timezone: string; date: string; cutoffTimestamp: number },
): number {
  assertTimezone(options.timezone);
  const cutoff = analyticsDateParts(options.cutoffTimestamp, options.timezone);
  const cutoffSeconds = cutoff.hour * 3600 + cutoff.minute * 60 + cutoff.second;
  const seen = new Set<string>();
  let total = 0;
  for (const customer of customers) {
    const subscribedAt = parseAnalyticsTimestamp(customer.last_subscribed_at ?? customer.subscribed_at ?? customer.inserted_at);
    if (!Number.isFinite(subscribedAt) || subscribedAt <= 0) continue;
    const customerId = String(customer.id ?? customer.psid ?? "");
    const key = `${customerId}:${subscribedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = analyticsDateParts(subscribedAt, options.timezone);
    const seconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
    if (parts.date === options.date && seconds <= cutoffSeconds) total += 1;
  }
  return total;
}

function normalizeGender(value: unknown): "female" | "male" | "unknown" {
  if (value === 1 || value === "1") return "male";
  if (value === 2 || value === "2") return "female";
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["female", "f", "woman", "women", "女"].includes(normalized)) return "female";
  if (["male", "m", "man", "men", "男"].includes(normalized)) return "male";
  return "unknown";
}

export function parseAnalyticsTimestamp(value: unknown): number {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

export function dateInAnalyticsTimezone(timestamp: number, timezone: string): string {
  return analyticsDateParts(timestamp, timezone).date;
}

export function addAnalyticsDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

export function enumerateIsoDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let current = start, guard = 0; current <= end && guard < 3660; current = addAnalyticsDays(current, 1), guard += 1) dates.push(current);
  return dates;
}

export function assertTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(); }
  catch { throw new Error("所选时区无效"); }
}

function analyticsDateParts(timestamp: number, timezone: string): { date: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    hour: Math.min(23, Math.max(0, Number(read("hour")) || 0)),
    minute: Math.min(59, Math.max(0, Number(read("minute")) || 0)),
    second: Math.min(59, Math.max(0, Number(read("second")) || 0)),
  };
}

function sumNumbers(sum: number, value: number): number { return sum + value; }
