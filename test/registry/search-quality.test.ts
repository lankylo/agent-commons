import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import { ContributionSearch } from "../../src/registry/search";
import { seedHttpbinContributions } from "../../src/seed/load-httpbin";
import {
  BENCHMARK_CASES,
  BENCHMARK_NOW,
  CORPUS_KEYS,
  CORPUS_START,
  EXECUTION_CORPUS,
  KNOWLEDGE_CORPUS,
  runBenchmark,
  type CorpusKey,
} from "./search-quality-benchmark";

// Local Miniflare D1 + R2 with the real migrations; no network, no remote resources, no LLM.
let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let search: ContributionSearch;
const keyById = new Map<string, CorpusKey>();
const idByKey = new Map<string, string>();
let clock = new Date(CORPUS_START);

const keyOf = (id: string): CorpusKey => {
  const key = keyById.get(id);
  if (!key) throw new Error(`result ${id} is not part of the benchmark corpus`);
  return key;
};
async function searchKeys(request: Readonly<Record<string, unknown>>): Promise<CorpusKey[]> {
  const r = await search.search(request);
  if (!r.ok) throw new Error(`invalid benchmark request: ${JSON.stringify(r.error)}`);
  return r.results.map((item) => keyOf(item.id));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-search-quality-"));
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.d1-local.jsonc",
      "--persist-to",
      dir,
    ],
    { stdio: "pipe" },
  );
  proxy = await getPlatformProxy<RegistryEnv>({
    configPath: "wrangler.registry-local.jsonc",
    persist: { path: join(dir, "v3") },
  });
  const db = proxy.env.DB;
  const registry = new ContributionRegistry(proxy.env, { now: () => clock });
  // The search service is given D1 only: the benchmark cannot depend on R2 content.
  search = new ContributionSearch({ DB: db }, { now: () => new Date(BENCHMARK_NOW) });
  const identity = new IdentityRepository(db);
  const op = await identity.createOperator({ kind: "organization", displayName: "Benchmark Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const agent: AgentId = (await identity.registerAgent(op.id, { displayName: "Bench" })).id;

  const seeded = await seedHttpbinContributions(registry, agent);
  if (!seeded.ok) throw new Error(`seed failed: ${JSON.stringify(seeded.error)}`);
  keyById.set(seeded.knowledge.id, "k-httpbin");
  keyById.set(seeded.execution.id, "e-httpbin");
  const keys = CORPUS_KEYS.filter((k) => k !== "k-httpbin" && k !== "e-httpbin");
  const inputs = [...KNOWLEDGE_CORPUS, ...EXECUTION_CORPUS];
  expect(inputs).toHaveLength(keys.length);
  for (const [i, input] of inputs.entries()) {
    clock = new Date(Date.parse(CORPUS_START) + (i + 1) * 60_000);
    const r = await registry.createContribution(agent, input);
    if (!r.ok) throw new Error(`${keys[i]}: ${JSON.stringify(r.error)}`);
    keyById.set(r.contribution.id, keys[i]);
  }
  for (const [id, key] of keyById) idByKey.set(key, id);
}, 240_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("benchmark corpus", () => {
  it("is fully created: httpbin seeds plus schema-valid Knowledge and Execution items", () => {
    expect(keyById.size).toBe(CORPUS_KEYS.length);
    expect([...idByKey.keys()].sort()).toEqual([...CORPUS_KEYS].sort());
  });

  it("has at least 16 cases and every expectation names a corpus item", () => {
    expect(BENCHMARK_CASES.length).toBeGreaterThanOrEqual(16);
    const known = new Set<string>(CORPUS_KEYS);
    for (const c of BENCHMARK_CASES) {
      for (const r of c.relevant) expect(known.has(r.key), c.id).toBe(true);
      for (const key of c.acceptable ?? []) expect(known.has(key), c.id).toBe(true);
      expect(c.expectNone === true, c.id).toBe(c.relevant.length === 0);
    }
  });
});

describe("observed search behaviour", () => {
  it("is deterministic across repeated runs", async () => {
    const a = await runBenchmark(searchKeys);
    const b = await runBenchmark(searchKeys);
    expect(b.outcomes).toEqual(a.outcomes);
  });

  it("after identifier index terms all 25 cases pass with no misses", async () => {
    const { outcomes, summary, verdict } = await runBenchmark(searchKeys);
    expect(summary).toEqual({
      cases: 25,
      positiveCases: 22,
      noResultCases: 3,
      top1Successes: 22,
      top3Successes: 22,
      relevantExpected: 33,
      missedRelevant: 0,
      misplacedRelevant: 0,
      returnedTotal: 39,
      unexpectedResults: 0,
      orderViolations: 0,
      zeroResultPositiveCases: 0,
      nonEmptyNoResultCases: 0,
      casesPassed: 25,
    });
    expect(outcomes.filter((o) => !o.passed)).toEqual([]);
    expect(outcomes.find((o) => o.id.startsWith("K2"))?.returned).toEqual(["k-httpbin"]);
    // K4 and E2 are now found through stop words, plural forms and bounded relaxation.
    const returned = (id: string) => outcomes.find((o) => o.id.startsWith(id))?.returned;
    expect(returned("K4")).toEqual(["k-github-rate", "k-github-rate-old"]);
    expect(returned("E2")).toEqual(["e-github-rate"]);
    expect(verdict.met).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("returns current before stale, family-correct and filter-correct results", async () => {
    expect(await searchKeys({ query: "github rate" })).toEqual([
      "k-github-rate",
      "e-github-rate",
      "k-github-rate-old",
    ]);
    expect(await searchKeys({ query: "httpbin", family: "execution" })).toEqual([
      "e-httpbin-post",
      "e-httpbin",
      "e-httpbin-headers-old",
    ]);
    expect(
      await searchKeys({
        query: "github",
        family: "execution",
        filters: { sideEffect: "read-only" },
      }),
    ).toEqual(["e-github-rate"]);
    expect(
      await searchKeys({
        query: "github",
        family: "execution",
        filters: { requiresHumanApproval: true },
      }),
    ).toEqual(["e-github-issue", "e-github-delete"]);
  });

  it("drops stop words and matches singular and plural forms", async () => {
    // Plural forms: "limit" and "limits" now find the same Knowledge and Execution items.
    const both = ["k-github-rate", "e-github-rate", "k-github-rate-old"];
    expect(await searchKeys({ query: "github rate limits" })).toEqual(both);
    expect(await searchKeys({ query: "github rate limit" })).toEqual(both);
    // A stop word no longer makes an otherwise matching query return nothing.
    expect(await searchKeys({ query: "the github rate limits" })).toEqual(both);
  });

  it("K2 is found: camelCase predicates are indexed as separate components", async () => {
    expect(
      await searchKeys({ query: "what status code and fields does httpbin get return" }),
    ).toEqual(["k-httpbin"]);
    expect(await searchKeys({ query: "httpbin get return" })).toEqual(["k-httpbin"]);
  });

  it("prints the report when SEARCH_QUALITY_REPORT is set", async () => {
    if (!process.env.SEARCH_QUALITY_REPORT) return;
    const { outcomes, summary, verdict } = await runBenchmark(searchKeys);
    console.log(JSON.stringify({ summary, verdict, outcomes }, null, 1));
  });
});
