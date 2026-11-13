import { describe, expect, it } from "vitest";
import {
  buildDiscoveryResponse,
  DISCOVERY_ITEM_KEYS,
  DISCOVERY_RESPONSE_VERSION,
} from "../../src/registry/discovery";
import type { SearchResultItem } from "../../src/registry/search";

const item = (over: Partial<SearchResultItem> = {}): SearchResultItem => ({
  id: "c-1",
  version: 2,
  family: "knowledge",
  contentType: "api-reference",
  title: "Title",
  purpose: "Purpose",
  asOf: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z",
  reviewIntervalDays: 30,
  lastVerifiedAt: "2026-11-05T00:00:00.000Z",
  reliabilityScore: 0.8,
  consumerCount: 3,
  freshness: "current",
  reviewDueAt: "2026-12-05T00:00:00.000Z",
  related: [],
  ...over,
});

const sortedKeys = [...DISCOVERY_ITEM_KEYS].sort();

describe("buildDiscoveryResponse", () => {
  it("maps both families with the exact allow-listed keys", () => {
    const res = buildDiscoveryResponse([
      item(),
      item({ id: "c-2", family: "execution", contentType: "diagnostic-recipe" }),
    ]);
    expect(res.schemaVersion).toBe(DISCOVERY_RESPONSE_VERSION);
    expect(res.resultCount).toBe(2);
    expect(res.results.map((r) => r.family)).toEqual(["knowledge", "execution"]);
    for (const r of res.results) expect(Object.keys(r).sort()).toEqual(sortedKeys);
    expect(res.results[0]).toEqual({
      contributionId: "c-1",
      version: 2,
      family: "knowledge",
      contentType: "api-reference",
      title: "Title",
      purpose: "Purpose",
      asOf: "2026-11-01T00:00:00.000Z",
      freshness: "current",
      reviewDueAt: "2026-12-05T00:00:00.000Z",
      lastVerifiedAt: "2026-11-05T00:00:00.000Z",
      reliabilityScore: 0.8,
      consumerCount: 3,
      related: [],
    });
  });

  it("preserves ranked order exactly, including stale before current", () => {
    const input = [
      item({ id: "c-3", freshness: "stale" }),
      item({ id: "c-1" }),
      item({ id: "c-2", family: "execution" }),
    ];
    const res = buildDiscoveryResponse(input);
    expect(res.results.map((r) => r.contributionId)).toEqual(["c-3", "c-1", "c-2"]);
    expect(res.results[0]?.freshness).toBe("stale");
    expect(res.results[1]?.freshness).toBe("current");
  });

  it("keeps null reliability, verification and review-due values", () => {
    const [r] = buildDiscoveryResponse([
      item({ reliabilityScore: null, lastVerifiedAt: null, reviewDueAt: null, freshness: "stale" }),
    ]).results;
    expect(r?.reliabilityScore).toBeNull();
    expect(r?.lastVerifiedAt).toBeNull();
    expect(r?.reviewDueAt).toBeNull();
  });

  it("handles empty input", () => {
    expect(buildDiscoveryResponse([])).toEqual({
      schemaVersion: DISCOVERY_RESPONSE_VERSION,
      resultCount: 0,
      results: [],
    });
  });

  it("drops unknown extra fields and exposes no paid-content fields", () => {
    const polluted = {
      ...item(),
      searchText: "secret indexed text",
      summary: "S",
      explanation: "E",
      facts: [1],
      sources: ["u"],
      objective: "O",
      steps: [1],
      content: "R2",
      contentHash: "abc",
      authorAgentId: "ag_1",
      operatorId: "op_1",
      createdAt: "x",
      reviewIntervalDays: 9,
    } as SearchResultItem;
    const json = JSON.stringify(buildDiscoveryResponse([polluted, polluted]));
    for (const leaked of [
      "secret indexed text",
      "explanation",
      "facts",
      "sources",
      "objective",
      "steps",
      "R2",
      "contentHash",
      "ag_1",
      "op_1",
      "createdAt",
      "reviewIntervalDays",
    ])
      expect(json).not.toContain(leaked);
  });

  it("round-trips through JSON unchanged", () => {
    const res = buildDiscoveryResponse([item(), item({ family: "execution", id: "c-2" })]);
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });

  it("is deterministic and deeply frozen without mutating input", () => {
    const input = [item()];
    const snapshot = JSON.stringify(input);
    const a = buildDiscoveryResponse(input);
    expect(JSON.stringify(buildDiscoveryResponse(input))).toBe(JSON.stringify(a));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.results)).toBe(true);
    expect(Object.isFrozen(a.results[0])).toBe(true);
  });

  it("rejects an unsupported family", () => {
    expect(() => buildDiscoveryResponse([item({ family: "other" as never })])).toThrow();
  });
});
