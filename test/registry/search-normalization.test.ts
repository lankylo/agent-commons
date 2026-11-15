import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import {
  ContributionSearch,
  SEARCH_LIMITS,
  SEARCH_PROTECTED_TERMS,
  SEARCH_RELAXATION,
  SEARCH_STOP_WORDS,
  anyGroupExpression,
  groupExpression,
  normalizeQuery,
  relaxationLevels,
  singularPluralForms,
  strictExpression,
  tokenizeQuery,
  type SearchResult,
} from "../../src/registry/search";

// ---------- pure normalization (no D1) ----------

const groupsOf = (query: string) => {
  const t = tokenizeQuery(query);
  if (!t.ok) throw new Error(t.issue.code);
  return normalizeQuery(t.tokens);
};

describe("stop words", () => {
  it("is a fixed list that never contains negations or safety-significant terms", () => {
    for (const term of SEARCH_PROTECTED_TERMS)
      expect(SEARCH_STOP_WORDS.has(term), term).toBe(false);
    for (const word of ["no", "not", "without", "nor", "never", "t", "s", "get", "post"]) {
      expect(SEARCH_STOP_WORDS.has(word), word).toBe(false);
    }
    for (const word of ["the", "what", "how", "does", "i", "need", "my", "per", "and", "or"]) {
      expect(SEARCH_STOP_WORDS.has(word), word).toBe(true);
    }
    expect(SEARCH_STOP_WORDS.size).toBe(68);
  });

  it("drops framing words but keeps negations and safety terms", () => {
    expect(groupsOf("what is the approval side effect without no capability").groups).toEqual([
      ["approval", "approvals"],
      ["side", "sides"],
      ["effect", "effects"],
      ["without", "withouts"],
      ["no"],
      ["capability", "capabilities"],
    ]);
    expect(groupsOf("does not require human approval").groups.map((g) => g[0])).toEqual([
      "not",
      "require",
      "human",
      "approval",
    ]);
  });

  it("searches a query of only stop words literally, without expansion or relaxation", () => {
    const q = groupsOf("What is the?");
    expect(q).toEqual({ groups: [["what"], ["is"], ["the"]], literal: true });
    expect(relaxationLevels(q)).toEqual([]);
  });
});

describe("singular/plural forms", () => {
  it.each([
    ["limit", ["limit", "limits"]],
    ["limits", ["limits", "limit"]],
    ["request", ["request", "requests"]],
    ["requests", ["requests", "request"]],
    ["policy", ["policy", "policies"]],
    ["policies", ["policies", "policy"]],
    ["key", ["key", "keys"]],
    ["status", ["status", "statuses"]],
    ["statuses", ["statuses", "statuse", "status"]],
    ["caches", ["caches", "cache", "cach"]],
    ["box", ["box", "boxes"]],
    ["address", ["address", "addresses"]],
    ["analysis", ["analysis"]],
    ["api", ["api", "apis"]],
    ["us", ["us"]],
    ["429", ["429"]],
    ["v2", ["v2"]],
    ["café", ["café"]],
    ["データ", ["データ"]],
  ])("%s -> %j", (token, forms) => {
    expect(singularPluralForms(token)).toEqual(forms);
  });

  it("never yields more than the documented number of forms", () => {
    for (const t of ["boxes", "matches", "policies", "x", "limits", "buses"]) {
      expect(singularPluralForms(t).length).toBeLessThanOrEqual(SEARCH_RELAXATION.maxFormsPerGroup);
    }
  });

  it("merges tokens that share a form into one group", () => {
    expect(groupsOf("limit limits LIMIT").groups).toEqual([["limit", "limits"]]);
  });
});

describe("generated FTS expressions", () => {
  it("quotes every form; operators and syntax only come from the generator", () => {
    const q = groupsOf('github* "rate" limits NOT title:^near(x) OR AND');
    expect(strictExpression(q.groups)).toBe(
      '("github" OR "githubs") AND ("rate" OR "rates") AND ("limits" OR "limit") AND ' +
        '("not" OR "nots") AND ("title" OR "titles") AND ("near" OR "nears") AND "x"',
    );
    expect(anyGroupExpression([["a"], ["b", "bs"]])).toBe('"a" OR ("b" OR "bs")');
  });

  it("rejects tokens that are not plain letters, marks or numbers", () => {
    for (const bad of ['a"b', "a*", "a b", "", "x:y", "(x)"]) {
      expect(() => groupExpression([bad])).toThrow(RangeError);
    }
  });
});

describe("relaxation plan", () => {
  const plan = (n: number) =>
    relaxationLevels({
      groups: Array.from({ length: n }, (_, i) => [`t${i}`]),
      literal: false,
    });

  it("relaxes at most two groups and always requires at least three", () => {
    expect([1, 2, 3].map(plan)).toEqual([[], [], []]);
    expect(plan(4)).toEqual([3]);
    expect(plan(5)).toEqual([4, 3]);
    expect(plan(SEARCH_LIMITS.maxTokens)).toEqual([11, 10]);
    for (let n = 1; n <= SEARCH_LIMITS.maxTokens; n++) {
      const levels = plan(n);
      expect(levels.length + 1).toBeLessThanOrEqual(SEARCH_RELAXATION.maxSearchQueries);
      for (const required of levels) {
        expect(required).toBeGreaterThanOrEqual(SEARCH_RELAXATION.minRequiredGroups);
        expect(n - required).toBeLessThanOrEqual(SEARCH_RELAXATION.maxDroppedGroups);
      }
    }
  });
});

// ---------- D1 behaviour ----------

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let search: ContributionSearch;
let clock = new Date("2026-11-11T12:00:00.000Z");
const searchSql: string[] = [];
const ids: Record<string, string> = {};

const base = {
  evidence: [{ kind: "documentation", uri: "https://httpbin.org/docs" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  asOf: "2026-11-10T10:00:00Z",
};
const knowledge = (title: string, summary: string, method: string): Record<string, unknown> => ({
  ...base,
  family: "knowledge",
  title,
  purpose: "Record documented behaviour",
  contentType: "api-reference",
  summary,
  facts: [{ subject: "narwhal-gateway", predicate: "documented", value: true }],
  explanation: "Untrusted contributor prose; narwhal ingest quota header zzzhidden.",
  sources: [
    {
      uri: "https://httpbin.org/src",
      accessedAt: "2026-11-10T10:00:00Z",
      hash: { algorithm: "sha256", digest: "b".repeat(64) },
    },
  ],
  rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
  verification: { method },
});
const execution = (
  title: string,
  objective: string,
  sideEffect: string,
  approval: boolean,
): Record<string, unknown> => ({
  ...base,
  family: "execution",
  title,
  purpose: "Operate gateway endpoint",
  contentType: "api-recipe",
  objective,
  inputs: [],
  outputs: [{ name: "status", type: "integer", variable: "status" }],
  targetDomains: ["narwhal.acme.com"],
  compatibility: { requiredCapabilities: ["http-client"] },
  steps: [
    {
      id: "call",
      type: "http_request",
      method: "GET",
      domain: "narwhal.acme.com",
      path: "/v1/ingest",
      expectStatus: [200],
      saveAs: "body",
    },
    { id: "pick", type: "extract_field", from: "body", pointer: "/status", saveAs: "status" },
    { id: "check", type: "assert", source: { variable: "status" }, operator: "exists" },
  ],
  successChecks: ["check"],
  safety: {
    sideEffect,
    requiresHumanApproval: approval,
    maxRequests: 1,
    timeoutSeconds: 30,
    onFailure: "stop",
  },
  verification: { method: "owner-tested", testedAt: "2026-11-10T10:00:00Z" },
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-search-normalization-"));
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
  // D1 only, with every search statement recorded so the query bound can be asserted.
  const recording = {
    prepare: (sql: string) => {
      if (sql.includes("contribution_search MATCH")) searchSql.push(sql);
      return db.prepare(sql);
    },
  } as unknown as D1Database;
  search = new ContributionSearch(
    { DB: recording },
    { now: () => new Date("2026-11-15T00:00:00.000Z") },
  );
  const identity = new IdentityRepository(db);
  const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const agent: AgentId = (await identity.registerAgent(op.id, { displayName: "Agent" })).id;
  const corpus: [string, Record<string, unknown>][] = [
    [
      "kLimits",
      knowledge(
        "Narwhal ingest request limits",
        "Narwhal ingest accepts 100 requests per minute.",
        "owner-tested",
      ),
    ],
    [
      "kQuota",
      knowledge(
        "Narwhal ingest batch policy",
        "Batches over the narwhal ingest quota are rejected.",
        "cross-source",
      ),
    ],
    [
      "eQuota",
      execution(
        "Check narwhal ingest quota",
        "Read the narwhal ingest quota header",
        "read-only",
        false,
      ),
    ],
    [
      "ePurge",
      execution(
        "Purge narwhal ingest batch",
        "Delete one stored batch",
        "irreversible-write",
        true,
      ),
    ],
  ];
  for (const [i, [name, input]] of corpus.entries()) {
    clock = new Date(Date.parse("2026-11-11T12:00:00.000Z") + i * 60_000);
    const r = await registry.createContribution(agent, input);
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    ids[name] = r.contribution.id;
  }
}, 180_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  searchSql.length = 0;
});

const names = (r: SearchResult): string[] => {
  if (!r.ok) throw new Error(`search failed: ${JSON.stringify(r.error)}`);
  const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
  return r.results.map((x) => byId.get(x.id) ?? x.id);
};
const found = async (req: Record<string, unknown>) => names(await search.search(req));

describe("search with stop words and plural forms", () => {
  it("ignores question framing that previously made strict AND return nothing", async () => {
    expect(await found({ query: "what are the narwhal request limits?" })).toEqual(["kLimits"]);
    expect(await found({ query: "how many requests does narwhal ingest accept" })).toEqual([
      "kLimits",
    ]);
    expect(searchSql).toHaveLength(2); // both found by the strict search
  });

  it("matches singular and plural forms in both directions", async () => {
    expect(await found({ query: "narwhal limit" })).toEqual(["kLimits"]);
    expect(await found({ query: "narwhal limits" })).toEqual(["kLimits"]);
    expect(await found({ query: "narwhal request" })).toEqual(["kLimits"]);
    expect(await found({ query: "narwhal requests" })).toEqual(["kLimits"]);
    const batch = await found({ query: "narwhal batch" });
    expect(batch.sort()).toEqual(["ePurge", "kQuota"]);
    expect((await found({ query: "narwhal batches" })).sort()).toEqual(batch);
  });

  it("handles a query of only stop words as a literal strict search, not an error", async () => {
    // "the" occurs in kQuota's summary and eQuota's objective.
    expect((await found({ query: "the" })).sort()).toEqual(["eQuota", "kQuota"]);
    expect(await found({ query: "what is the" })).toEqual([]);
    expect(searchSql).toHaveLength(2); // no relaxation for literal queries
  });

  it("keeps negations as required terms", async () => {
    expect(await found({ query: "narwhal without quota" })).toEqual([]);
    expect(await found({ query: "no narwhal quota" })).toEqual([]);
    expect(await found({ query: "narwhal quota" })).not.toEqual([]);
  });
});

describe("strict-first bounded relaxation", () => {
  it("returns the strict result when it is non-empty, without relaxing", async () => {
    expect(await found({ query: "narwhal ingest quota header" })).toEqual(["eQuota"]);
    expect(searchSql).toHaveLength(1);
  });

  it("relaxes one group only when the strict search is empty", async () => {
    expect(await found({ query: "narwhal ingest quota header zzzone" })).toEqual(["eQuota"]);
    expect(searchSql).toHaveLength(2);
  });

  it("relaxes a second group only when one is not enough, with the unchanged ranking", async () => {
    const relaxed = await found({ query: "narwhal ingest quota zzzone zzztwo" });
    expect(searchSql).toHaveLength(SEARCH_RELAXATION.maxSearchQueries);
    expect(relaxed).toEqual(await found({ query: "narwhal ingest quota" }));
    expect(relaxed.sort()).toEqual(["eQuota", "kQuota"]);
  });

  it("never relaxes more than two groups or falls back to one broad token", async () => {
    expect(await found({ query: "narwhal ingest zzzone zzztwo zzzthree" })).toEqual([]);
    expect(searchSql).toHaveLength(3);
    searchSql.length = 0;
    expect(await found({ query: "narwhal zzzone zzztwo" })).toEqual([]);
    expect(await found({ query: "narwhal zzzone" })).toEqual([]);
    expect(searchSql).toHaveLength(2); // fewer than four groups: strict only
  });

  it("bounds the number of search queries for the largest query", async () => {
    const words = Array.from({ length: SEARCH_LIMITS.maxTokens }, (_, i) => `zzz${i}`).join(" ");
    expect(await found({ query: words })).toEqual([]);
    expect(searchSql).toHaveLength(SEARCH_RELAXATION.maxSearchQueries);
  });

  it("applies family, content type and metadata filters to relaxed searches", async () => {
    const q = "narwhal ingest quota zzzone zzztwo";
    expect(await found({ query: q, family: "knowledge" })).toEqual(["kQuota"]);
    expect(await found({ query: q, contentType: "api-recipe" })).toEqual(["eQuota"]);
    expect(
      await found({ query: q, family: "execution", filters: { sideEffect: "read-only" } }),
    ).toEqual(["eQuota"]);
    expect(
      await found({ query: q, family: "execution", filters: { requiresHumanApproval: true } }),
    ).toEqual([]);
  });

  it("applies the result limit after ranking and is deterministic across calls", async () => {
    const q = "narwhal ingest quota zzzone zzztwo";
    const all = await found({ query: q });
    expect(await found({ query: q })).toEqual(all);
    expect(await found({ query: q, limit: 1 })).toEqual(all.slice(0, 1));
  });

  it("never matches Knowledge explanation text, even when relaxed", async () => {
    expect(await found({ query: "zzzhidden" })).toEqual([]);
    expect(await found({ query: "previous instructions narwhal zzzhidden" })).toEqual([]);
  });
});

describe("unsafe and invalid input", () => {
  it("keeps FTS syntax, operators, wildcards and column selectors inert", async () => {
    for (const query of [
      'narwhal* OR "ingest" NEAR(quota) indexed_text:header zzzone',
      "NOT narwhal",
      "narwh* ingest*",
      '"narwhal" AND ^ingest - quota : {header}',
      "'; DROP TABLE contributions; -- narwhal ingest quota",
    ]) {
      const r = await search.search({ query });
      expect(r.ok, query).toBe(true);
    }
    expect(await found({ query: "NOT narwhal" })).toEqual([]); // "not" is a required term
    expect(await found({ query: "narwh* ingest*" })).toEqual([]); // no prefix matching
    expect(await found({ query: "-narwhal ingest limits" })).toEqual(["kLimits"]);
  });

  it("keeps the validation limits: stop words still count as tokens", async () => {
    const issue = async (query: string) => {
      const r = await search.search({ query });
      return r.ok ? null : r.error.issues.map((i) => i.code);
    };
    expect(
      await issue(Array.from({ length: SEARCH_LIMITS.maxTokens + 1 }, () => "the").join(" ")),
    ).toEqual(["too_many_tokens"]);
    expect(await issue(" ?! ")).toEqual(["query_empty"]);
    expect(await issue("x".repeat(SEARCH_LIMITS.maxTokenLength + 1))).toEqual(["token_too_long"]);
    expect(searchSql).toHaveLength(0);
  });

  it("returns an empty result for unmatched natural queries", async () => {
    expect(await found({ query: "how do I scale a kraken octopus squid fleet" })).toEqual([]);
  });
});
