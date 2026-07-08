import { describe, expect, it } from "bun:test";

import { isNoise } from "../noise-filter.js";

describe("noise-filter denial/meta length gating", () => {
  it("filters a short pure denial", () => {
    expect(isNoise("I don't recall that.")).toBe(true);
  });

  it("filters a short pure meta-question", () => {
    expect(isNoise("Do you remember my deploy setup?")).toBe(true);
  });

  it("keeps long substantive text containing a denial phrase", () => {
    const text =
      "I don't recall the exact commit hash, but the production outage was caused by " +
      "the schema migration dropping the composite index; we fixed it by re-creating " +
      "the index concurrently and adding a migration lint step to CI so it cannot recur.";
    expect(isNoise(text)).toBe(false);
  });

  it("keeps long substantive text containing a meta-question phrase", () => {
    const text =
      "Earlier you asked: did I mention the deploy window? For the record, deploys " +
      "happen Tuesdays at 10:00 UTC, the approver is the on-call lead, and the " +
      "rollback playbook lives in OPERATIONS.md under the fast-rollback section.";
    expect(isNoise(text)).toBe(false);
  });

  it("filters a short Chinese denial", () => {
    expect(isNoise("我不记得了，抱歉。")).toBe(true);
  });

  it("keeps long Chinese content containing a denial-like phrase", () => {
    const text =
      "虽然我不记得具体的提交号，但当时生产事故的根因是数据库迁移删除了复合索引，" +
      "我们通过并发重建索引修复了问题，并在 CI 中增加了迁移检查步骤防止再次发生。";
    expect(isNoise(text)).toBe(false);
  });

  it("still filters anchored boilerplate regardless of gating", () => {
    expect(isNoise("HEARTBEAT ping from scheduler")).toBe(true);
  });
});
