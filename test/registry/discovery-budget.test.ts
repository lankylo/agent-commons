import { describe, expect, it } from "vitest";
import { buildDiscoveryResponse } from "../../src/registry/discovery";
import { budgetDiscoveryResponse } from "../../src/registry/discovery-budget";
import type { ContributionId } from "../../src/registry/envelope";
import type { SearchResultItem } from "../../src/registry/search";

const item = (id: string, over: Partial<SearchResultItem> = {}): SearchResultItem => ({
  id,
  version: 1,
  family: "knowledge",
  contentType: "api-reference",
  title: `Title ${id}`,
  purpose: "Purpose",
  asOf: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z",
  reviewIntervalDays: 30,
  lastVerifiedAt: null,
  reliabilityScore: null,
  consumerCount: 0,
  freshness: "current",
  reviewDueAt: null,
  related: [],
  ...over,
});

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const sizeOf = (items: SearchResultItem[]) => bytes(buildDiscoveryResponse(items));
const items = [item("a"), item("b"), item("c")];

function ok(r: ReturnType<typeof budgetDiscoveryResponse>) {
  if (!r.ok) throw new Error("expected ok");
  return r;
}

describe("budgetDiscoveryResponse", () => {
  it("fits exactly at the boundary", () => {
    const r = ok(budgetDiscoveryResponse(items, sizeOf(items)));
    expect(r.response.resultCount).toBe(3);
    expect(r.budget).toEqual({
      maxUtf8Bytes: sizeOf(items),
      usedUtf8Bytes: sizeOf(items),
      omittedResultCount: 0,
    });
  });

  it("drops the last result one byte below the boundary", () => {
    const r = ok(budgetDiscoveryResponse(items, sizeOf(items) - 1));
    expect(r.response.results.map((x) => x.contributionId)).toEqual(["a", "b"]);
    expect(r.budget.omittedResultCount).toBe(1);
    expect(r.budget.usedUtf8Bytes).toBe(sizeOf(items.slice(0, 2)));
    expect(r.budget.usedUtf8Bytes).toBeLessThanOrEqual(r.budget.maxUtf8Bytes);
  });

  it("selects the largest ranked prefix and never skips to fit a later small item", () => {
    const big = item("big", { title: "x".repeat(500) });
    const list = [item("a"), big, item("c")];
    const max = sizeOf([list[0]!]) + 10;
    const r = ok(budgetDiscoveryResponse(list, max));
    expect(r.response.results.map((x) => x.contributionId)).toEqual(["a"]);
    expect(r.budget.omittedResultCount).toBe(2);
  });

  it("preserves ranked order and equals the plain mapper output for the prefix", () => {
    const list = [item("z"), item("m"), item("a")];
    const r = ok(budgetDiscoveryResponse(list, sizeOf(list.slice(0, 2))));
    expect(r.response).toEqual(buildDiscoveryResponse(list.slice(0, 2)));
    expect(Object.keys(r.response)).toEqual(["schemaVersion", "resultCount", "results"]);
  });

  it("handles empty input", () => {
    const empty = sizeOf([]);
    const r = ok(budgetDiscoveryResponse([], empty));
    expect(r.response.resultCount).toBe(0);
    expect(r.budget).toEqual({ maxUtf8Bytes: empty, usedUtf8Bytes: empty, omittedResultCount: 0 });
  });

  it("rejects invalid budgets", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "10" as unknown as number,
    ]) {
      const r = budgetDiscoveryResponse(items, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_budget");
    }
  });

  it("rejects a budget smaller than the empty envelope", () => {
    const r = budgetDiscoveryResponse(items, sizeOf([]) - 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("budget_too_small");
    const e = budgetDiscoveryResponse([], 1);
    if (!e.ok) expect(e.error.code).toBe("budget_too_small");
  });

  it("measures multibyte UTF-8 bytes, not characters", () => {
    const list = [item("a", { title: "日本語🙂é" }), item("b", { title: "日本語🙂é" })];
    const one = sizeOf(list.slice(0, 1));
    const chars = JSON.stringify(buildDiscoveryResponse(list.slice(0, 1))).length;
    expect(one).toBeGreaterThan(chars);
    const r = ok(budgetDiscoveryResponse(list, sizeOf(list) - 1));
    expect(r.response.resultCount).toBe(1);
    expect(r.budget.usedUtf8Bytes).toBe(one);
    expect(r.response.results[0]!.title).toBe("日本語🙂é");
  });

  it("deeply freezes the result, response and budget", () => {
    const list = [
      item("a", { related: [{ family: "execution", id: "e" as ContributionId, version: 1 }] }),
    ];
    const r = ok(budgetDiscoveryResponse(list, 100000));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.budget)).toBe(true);
    expect(Object.isFrozen(r.response)).toBe(true);
    expect(Object.isFrozen(r.response.results)).toBe(true);
    expect(Object.isFrozen(r.response.results[0])).toBe(true);
    expect(Object.isFrozen(r.response.results[0]!.related)).toBe(true);
    expect(Object.isFrozen(r.response.results[0]!.related[0])).toBe(true);
    const bad = budgetDiscoveryResponse(list, 1);
    expect(Object.isFrozen(bad)).toBe(true);
    if (!bad.ok) expect(Object.isFrozen(bad.error)).toBe(true);
  });
});
