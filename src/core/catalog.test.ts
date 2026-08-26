import { describe, expect, it } from "vitest";
import { parseCatalogCsv } from "./catalog";

describe("parseCatalogCsv", () => {
  it("保留无表头两列表格的第一条资源", () => {
    const rows = parseCatalogCsv([
      "设置-默认设置,https://example.com/settings.json",
      "流程-流程1号,https://example.com/flow.zip",
      "默认回复-1号,https://example.com/default.zip",
      "关键词-咨询,https://example.com/keyword.zip,价格，费用,说明",
    ].join("\n"));

    expect(rows.map((row) => [row.name, row.kind])).toEqual([
      ["设置-默认设置", "settings"],
      ["流程-流程1号", "flow"],
      ["默认回复-1号", "defaultReply"],
      ["关键词-咨询", "keyword"],
    ]);
    expect(rows[3]).toMatchObject({ keywords: ["价格", "费用"], version: undefined });
  });

  it("识别带表头和扩展列的目录", () => {
    const rows = parseCatalogCsv([
      "名称,资源网盘链接,版本,说明,启用",
      "流程-测试,https://example.com/flow.zip,v2,测试流程,否",
      "设置-正式,https://example.com/settings.json,v1,正式设置,是",
    ].join("\n"));

    expect(rows[0]).toMatchObject({ name: "流程-测试", version: "v2", description: "测试流程", enabled: false });
    expect(rows[1]).toMatchObject({ name: "设置-正式", enabled: true });
  });

  it("识别带表头的关键词第三列并去重空项", () => {
    const rows = parseCatalogCsv([
      "名称,资源网盘链接,关键词",
      "关键词-客服咨询,https://example.com/keyword.zip,\"价格,费用\"",
      "关键词-售后,https://example.com/after.zip,退货，退款，退货",
    ].join("\n"));

    expect(rows[0]).toMatchObject({ name: "关键词-客服咨询", kind: "keyword", keywords: ["价格", "费用"] });
    expect(rows[1]).toMatchObject({ keywords: ["退货", "退款"] });
  });
});
