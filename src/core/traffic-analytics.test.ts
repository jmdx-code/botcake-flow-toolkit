import { describe, expect, it } from "vitest";
import { aggregateCustomerTraffic, countCustomerTrafficThroughTime, parseAnalyticsTimestamp } from "./traffic-analytics";

describe("traffic analytics", () => {
  it("normalizes second, millisecond and ISO timestamps", () => {
    expect(parseAnalyticsTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseAnalyticsTimestamp("1700000000000")).toBe(1_700_000_000_000);
    expect(parseAnalyticsTimestamp("2026-08-23T00:00:00Z")).toBe(Date.parse("2026-08-23T00:00:00Z"));
  });

  it("buckets events by Hong Kong hour and deduplicates the same customer event", () => {
    const timestamp = Date.parse("2026-08-22T16:30:00Z");
    const result = aggregateCustomerTraffic([
      { id: "a", last_subscribed_at: timestamp },
      { id: "a", last_subscribed_at: timestamp },
      { id: "b", last_subscribed_at: "2026-08-22T17:10:00Z" },
    ], {
      timezone: "Asia/Hong_Kong",
      startDate: "2026-08-22",
      endDate: "2026-08-23",
      today: "2026-08-23",
      yesterday: "2026-08-22",
    });
    expect(result.todayHours[0]).toBe(1);
    expect(result.todayHours[1]).toBe(1);
    expect(result.todayTotal).toBe(2);
    expect(result.rangeTotal).toBe(2);
    expect(result.daily).toEqual([{ date: "2026-08-22", count: 0 }, { date: "2026-08-23", count: 2 }]);
  });

  it("keeps today and yesterday hourly counts separate", () => {
    const result = aggregateCustomerTraffic([
      { id: "today", last_subscribed_at: "2026-08-23T02:00:00Z" },
      { id: "yesterday", last_subscribed_at: "2026-08-22T02:00:00Z" },
    ], {
      timezone: "Asia/Hong_Kong",
      startDate: "2026-08-22",
      endDate: "2026-08-23",
      today: "2026-08-23",
      yesterday: "2026-08-22",
    });
    expect(result.todayHours[10]).toBe(1);
    expect(result.yesterdayHours[10]).toBe(1);
    expect(result.todayTotal).toBe(1);
    expect(result.yesterdayTotal).toBe(1);
  });

  it("counts gender only inside the selected range and after deduplication", () => {
    const result = aggregateCustomerTraffic([
      { id: "f", gender: "female", last_subscribed_at: "2026-08-23T02:00:00Z" },
      { id: "f", gender: "female", last_subscribed_at: "2026-08-23T02:00:00Z" },
      { id: "m", gender: "male", last_subscribed_at: "2026-08-23T03:00:00Z" },
      { id: "u", last_subscribed_at: "2026-08-23T04:00:00Z" },
      { id: "old", gender: "female", last_subscribed_at: "2026-08-20T04:00:00Z" },
    ], {
      timezone: "Asia/Hong_Kong",
      startDate: "2026-08-23",
      endDate: "2026-08-23",
      today: "2026-08-23",
      yesterday: "2026-08-22",
    });
    expect(result.gender).toEqual({ female: 1, male: 1, unknown: 1 });
  });

  it("supports Botcake numeric gender values", () => {
    const result = aggregateCustomerTraffic([
      { id: "m", gender: 1, last_subscribed_at: "2026-08-23T02:00:00Z" },
      { id: "f", gender: 2, last_subscribed_at: "2026-08-23T03:00:00Z" },
    ], {
      timezone: "Asia/Hong_Kong",
      startDate: "2026-08-23",
      endDate: "2026-08-23",
      today: "2026-08-23",
      yesterday: "2026-08-22",
    });
    expect(result.gender).toEqual({ female: 1, male: 1, unknown: 0 });
  });

  it("compares yesterday only through the current local time", () => {
    const result = countCustomerTrafficThroughTime([
      { id: "before", last_subscribed_at: "2026-08-25T04:29:59Z" },
      { id: "at", last_subscribed_at: "2026-08-25T04:30:00Z" },
      { id: "at", last_subscribed_at: "2026-08-25T04:30:00Z" },
      { id: "after", last_subscribed_at: "2026-08-25T04:30:01Z" },
      { id: "wrong-day", last_subscribed_at: "2026-08-26T04:00:00Z" },
    ], {
      timezone: "Asia/Hong_Kong",
      date: "2026-08-25",
      cutoffTimestamp: Date.parse("2026-08-26T04:30:00Z"),
    });
    expect(result).toBe(2);
  });
});
