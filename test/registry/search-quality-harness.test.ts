import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CRITERIA,
  BENCHMARK_CASES,
  checkAcceptance,
  evaluateCase,
  runBenchmark,
  summarize,
  type BenchmarkCase,
} from "./search-quality-benchmark";

const c = (over: Partial<BenchmarkCase> = {}): BenchmarkCase => ({
  id: "t",
  categories: ["keyword"],
  request: { query: "x" },
  relevant: [
    { key: "k-httpbin", maxRank: 1 },
    { key: "e-httpbin", maxRank: 3 },
  ],
  acceptable: ["k-httpbin-post"],
  ...over,
});

describe("evaluateCase", () => {
  it("scores a perfect answer", () => {
    const o = evaluateCase(c(), ["k-httpbin", "e-httpbin"]);
    expect(o).toMatchObject({ top1: true, top3: true, passed: true, zeroResults: false });
    expect([o.missed, o.misplaced, o.unexpected, o.orderViolations]).toEqual([[], [], [], []]);
  });

  it("reports missed, misplaced and unexpected results separately", () => {
    const o = evaluateCase(c(), ["e-github-rate", "k-httpbin-post", "k-http-etag", "e-httpbin"]);
    expect(o.missed).toEqual(["k-httpbin"]);
    expect(o.misplaced).toEqual(["e-httpbin"]); // rank 4 > maxRank 3
    expect(o.unexpected).toEqual(["e-github-rate", "k-http-etag"]);
    expect(o).toMatchObject({ top1: false, top3: false, passed: false });
    expect(evaluateCase(c(), ["k-httpbin"]).missed).toEqual(["e-httpbin"]);
  });

  it("counts an acceptable extra as neither unexpected nor relevant", () => {
    const o = evaluateCase(c(), ["k-httpbin-post", "k-httpbin", "e-httpbin"]);
    expect(o.unexpected).toEqual([]);
    expect(o.top1).toBe(false);
    expect(o.misplaced).toEqual(["k-httpbin"]);
  });

  it("top-3 needs min(relevant, 3) relevant results among the first three", () => {
    const many = c({
      relevant: ["k-httpbin", "e-httpbin", "k-httpbin-post", "e-httpbin-post"].map((key) => ({
        key: key as never,
        maxRank: 9,
      })),
      acceptable: [],
    });
    expect(evaluateCase(many, ["k-httpbin", "e-httpbin", "k-httpbin-post"]).top3).toBe(true);
    expect(evaluateCase(many, ["k-httpbin", "e-httpbin", "e-github-rate"]).top3).toBe(false);
  });

  it("flags ordering violations only when both items are returned", () => {
    const ordered = c({ orderedBefore: [["k-httpbin", "e-httpbin"]] });
    expect(evaluateCase(ordered, ["e-httpbin", "k-httpbin"]).orderViolations).toEqual([
      ["k-httpbin", "e-httpbin"],
    ]);
    expect(evaluateCase(ordered, ["k-httpbin", "e-httpbin"]).orderViolations).toEqual([]);
    expect(evaluateCase(ordered, ["e-httpbin"]).orderViolations).toEqual([]);
  });

  it("treats zero results as correct for no-result cases and any result as unexpected", () => {
    const none = c({ relevant: [], acceptable: [], expectNone: true });
    expect(evaluateCase(none, [])).toMatchObject({ passed: true, zeroResults: true, top1: false });
    const o = evaluateCase(none, ["k-httpbin"]);
    expect(o).toMatchObject({ passed: false, unexpected: ["k-httpbin"] });
  });
});

describe("summarize and checkAcceptance", () => {
  const cases = [c(), c({ relevant: [], acceptable: [], expectNone: true })];

  it("aggregates top-k, missed, unexpected and zero-result counts", () => {
    const outcomes = [evaluateCase(cases[0], []), evaluateCase(cases[1], ["k-httpbin"])];
    expect(summarize(cases, outcomes)).toMatchObject({
      cases: 2,
      positiveCases: 1,
      noResultCases: 1,
      top1Successes: 0,
      top3Successes: 0,
      relevantExpected: 2,
      missedRelevant: 2,
      returnedTotal: 1,
      unexpectedResults: 1,
      zeroResultPositiveCases: 1,
      nonEmptyNoResultCases: 1,
      casesPassed: 0,
    });
  });

  it("meets the criteria for a perfect run and names every failed criterion otherwise", () => {
    const good = summarize(cases, [
      evaluateCase(cases[0], ["k-httpbin", "e-httpbin"]),
      evaluateCase(cases[1], []),
    ]);
    expect(checkAcceptance(good)).toEqual({ met: true, failures: [] });
    const bad = summarize(cases, [
      evaluateCase(cases[0], []),
      evaluateCase(cases[1], ["k-httpbin"]),
    ]);
    expect(checkAcceptance(bad).failures).toEqual([
      "top-1 rate",
      "top-3 rate",
      "missed relevant results",
      "zero-result positive queries",
      "results for no-result queries",
      "unexpected results",
    ]);
  });

  it("states thresholds explicitly", () => {
    expect(ACCEPTANCE_CRITERIA).toMatchObject({ minTop1Rate: 0.8, minTop3Rate: 0.9 });
  });
});

describe("runBenchmark", () => {
  it("runs an oracle search that returns exactly the relevant keys in rank order", async () => {
    const byRequest = new Map(BENCHMARK_CASES.map((x) => [x.request, x]));
    const { summary, verdict } = await runBenchmark(async (req) =>
      (byRequest.get(req)?.relevant ?? []).map((r) => r.key),
    );
    expect(summary.casesPassed).toBe(BENCHMARK_CASES.length);
    expect(verdict).toEqual({ met: true, failures: [] });
  });

  it("fails every positive case for a search that returns nothing", async () => {
    const { summary, verdict } = await runBenchmark(async () => []);
    expect(summary.zeroResultPositiveCases).toBe(summary.positiveCases);
    expect(verdict.met).toBe(false);
  });

  it("covers every required category with at least 16 cases", () => {
    expect(BENCHMARK_CASES.length).toBeGreaterThanOrEqual(16);
    const seen = new Set(BENCHMARK_CASES.flatMap((x) => x.categories));
    for (const cat of [
      "knowledge-lookup",
      "execution-lookup",
      "keyword",
      "natural",
      "mixed-family",
      "family-filter",
      "metadata-filter",
      "compatibility-filter",
      "safety-filter",
      "freshness",
      "ranking",
      "no-result",
    ]) {
      expect(seen.has(cat as never), cat).toBe(true);
    }
    expect(new Set(BENCHMARK_CASES.map((x) => x.id)).size).toBe(BENCHMARK_CASES.length);
  });
});
