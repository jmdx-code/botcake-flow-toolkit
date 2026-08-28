import { describe, expect, it } from "vitest";
import { buildCreateBotcakeTagForm } from "./botcake-tags";

describe("buildCreateBotcakeTagForm", () => {
  it("uses the nested multipart field expected by Botcake", () => {
    const form = buildCreateBotcakeTagForm("B");

    expect([...form.entries()]).toEqual([["selectedTag[name]", "B"]]);
    expect(form.get("name")).toBeNull();
  });
});
