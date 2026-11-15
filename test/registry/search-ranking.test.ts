import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import {
  ContributionSearch,
  EVIDENCE_TIERS,
  SEARCH_RANKING,
  type SearchResult,
  type SearchResultItem,
} from "../../src/registry/search";

// Local Miniflare D1 + R2 with the real migrations; no network, no remote resources.
let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let search: ContributionSearch;
let agent: AgentId;
let clock = new Date("2026-11-11T12:00:00.000Z");
let searchNow = new Date("2026-11-15T00:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-search-ranking-"));
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
  db = proxy.env.DB;
  registry = new ContributionRegistry(proxy.env, { now: () => clock });
  search = new ContributionSearch({ DB: db }, { now: () => searchNow });
  const identity = new IdentityRepository(db);
  const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  agent = (await identity.registerAgent(op.id, { displayName: "Agent" })).id;
}, 180_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  evidence: [{ kind: "documentation", uri: "https://example.com/docs" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  asOf: "2026-11-10T10:00:00Z",
};
const source = (n: number) => ({
  uri: `https://example.com/src/${n}`,
  accessedAt: "2026-11-10T10:00:00Z",
  hash: { algorithm: "sha256", digest: String(n % 10).repeat(64) },
});
let serial = 0;
function knowledge(word: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  serial += 1;
  return {
    ...base,
    family: "knowledge",
    title: `${word} reference ${serial}`,
    purpose: "Record documented quotas",
    contentType: "api-reference",
    summary: `Quotas ${serial}.`,
    facts: [{ subject: "gateway", predicate: "quota", value: `tier-${serial}` }],
    sources: [source(1)],
    rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
    verification: { method: "source-checked" },
    ...over,
  };
}
function execution(word: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  serial += 1;
  return {
    ...base,
    family: "execution",
    title: `${word} recipe ${serial}`,
    purpose: "Retrieve a record and confirm it",
    contentType: "api-recipe",
    objective: `Fetch item ${serial} and verify its status`,
    inputs: [{ name: "itemId", type: "string", required: true }],
    outputs: [{ name: "status", type: "integer", variable: "itemStatus" }],
    targetDomains: ["api.acme.com"],
    compatibility: { requiredCapabilities: ["http-client"] },
    steps: [
      {
        id: "fetch",
        type: "http_request",
        method: "GET",
        domain: "api.acme.com",
        path: "/v1/items",
        query: { id: { input: "itemId" } },
        expectStatus: [200],
        saveAs: "itemBody",
      },
      {
        id: "pick",
        type: "extract_field",
        from: "itemBody",
        pointer: "/status",
        saveAs: "itemStatus",
      },
      {
        id: "check",
        type: "assert",
        source: { variable: "itemStatus" },
        operator: "equals",
        expected: serial,
      },
    ],
    successChecks: ["check"],
    safety: {
      sideEffect: "read-only",
      requiresHumanApproval: false,
      maxRequests: 1,
      timeoutSeconds: 30,
      onFailure: "stop",
    },
    verification: { method: "owner-tested", testedAt: "2026-11-10T10:00:00Z" },
    ...over,
  };
}

async function create(input: Record<string, unknown>, at?: string): Promise<string> {
  if (at) clock = new Date(at);
  const r = await registry.createContribution(agent, input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.contribution.id;
}
async function platform(
  id: string,
  state: { reliabilityScore?: number | null; lastVerifiedAt?: string | null },
  version = 1,
) {
  await db
    .prepare(
      `UPDATE version_platform_state SET reliability_score = ?, last_verified_at = ?
        WHERE contribution_id = ? AND version = ?`,
    )
    .bind(state.reliabilityScore ?? null, state.lastVerifiedAt ?? null, id, version)
    .run();
}
function ok(r: SearchResult): readonly SearchResultItem[] {
  if (!r.ok) throw new Error(`search failed: ${JSON.stringify(r.error)}`);
  return r.results;
}
const run = async (req: Record<string, unknown>) => ok(await search.search(req));
const found = async (req: Record<string, unknown>) => (await run(req)).map((r) => r.id);
const at = (iso: string) => (searchNow = new Date(iso));

describe("ranking contract constants", () => {
  it("documents family-aware evidence tiers on a common scale", () => {
    expect(EVIDENCE_TIERS).toEqual({
      knowledge: { "cross-source": 2, "source-checked": 1, "owner-tested": 1, unverified: 0 },
      execution: { "owner-tested": 2, simulated: 1, unverified: 0 },
    });
    expect(SEARCH_RANKING.maxCorroboration).toBe(4);
  });
});

describe("freshness", () => {
  it("is current strictly before reviewDueAt and stale from it, for both families", async () => {
    const k = await create(knowledge("brambling"), "2026-11-11T00:00:00.000Z");
    const e = await create(execution("brambling"), "2026-11-11T00:00:00.000Z");
    const due = "2026-12-10T10:00:00.000Z"; // asOf + 30 days
    at("2026-12-10T09:59:59.999Z");
    for (const r of await run({ query: "brambling" })) {
      expect([r.freshness, r.reviewDueAt]).toEqual(["current", due]);
    }
    at(due);
    const stale = await run({ query: "brambling" });
    expect(stale.map((r) => r.id).sort()).toEqual([k, e].sort());
    for (const r of stale) expect([r.freshness, r.reviewDueAt]).toEqual(["stale", due]);
    at("2026-11-15T00:00:00.000Z");
  });

  it("uses the later of asOf and lastVerifiedAt as the anchor", async () => {
    const id = await create(knowledge("hawfinch"));
    at("2026-12-20T00:00:00.000Z");
    expect((await run({ query: "hawfinch" }))[0].freshness).toBe("stale");
    await platform(id, { lastVerifiedAt: "2026-12-01T00:00:00.000Z" });
    const [r] = await run({ query: "hawfinch" });
    expect([r.freshness, r.reviewDueAt]).toEqual(["current", "2026-12-31T00:00:00.000Z"]);
    // An older verification never shortens the review window.
    await platform(id, { lastVerifiedAt: "2026-01-01T00:00:00Z" });
    const [older] = await run({ query: "hawfinch" });
    expect([older.freshness, older.reviewDueAt]).toEqual(["stale", "2026-12-10T10:00:00.000Z"]);
    at("2026-11-15T00:00:00.000Z");
  });

  it("depends only on the injected reference time", async () => {
    await create(knowledge("siskin", { reviewIntervalDays: 1 }));
    at("2026-11-11T09:00:00.000Z");
    expect((await run({ query: "siskin" }))[0].freshness).toBe("current");
    at("2026-11-11T10:00:00.000Z");
    expect((await run({ query: "siskin" }))[0].freshness).toBe("stale");
    at("2026-11-15T00:00:00.000Z");
  });
});

describe("ranking", () => {
  it("demotes stale results below current ones in each family and across families", async () => {
    // Stale: highest evidence tiers, newest; current: lowest tiers, oldest.
    const kStale = await create(
      knowledge("linnet", { verification: { method: "cross-source" }, reviewIntervalDays: 1 }),
      "2026-11-12T00:00:00.000Z",
    );
    const eStale = await create(execution("linnet", { reviewIntervalDays: 1 }));
    const kCurrent = await create(
      knowledge("linnet", { verification: { method: "unverified" } }),
      "2026-11-11T00:00:00.000Z",
    );
    const eCurrent = await create(execution("linnet", { verification: { method: "unverified" } }));
    const k = await run({ query: "linnet", family: "knowledge" });
    expect(k.map((r) => [r.id, r.freshness])).toEqual([
      [kCurrent, "current"],
      [kStale, "stale"],
    ]);
    expect(await found({ query: "linnet", family: "execution" })).toEqual([eCurrent, eStale]);
    const all = await run({ query: "linnet" });
    expect(all.slice(0, 2).map((r) => r.freshness)).toEqual(["current", "current"]);
    expect(
      all
        .slice(2)
        .map((r) => r.id)
        .sort(),
    ).toEqual([kStale, eStale].sort());
  });

  it("orders current results by family-aware evidence tier", async () => {
    clock = new Date("2026-11-11T00:00:00.000Z");
    const k = {
      unverified: await create(knowledge("redpoll", { verification: { method: "unverified" } })),
      owner: await create(knowledge("redpoll", { verification: { method: "owner-tested" } })),
      cross: await create(knowledge("redpoll", { verification: { method: "cross-source" } })),
    };
    const e = {
      unverified: await create(execution("redpoll", { verification: { method: "unverified" } })),
      simulated: await create(
        execution("redpoll", {
          verification: { method: "simulated", testedAt: "2026-11-10T10:00:00Z" },
        }),
      ),
      owner: await create(execution("redpoll")),
    };
    expect(await found({ query: "redpoll", family: "knowledge" })).toEqual([
      k.cross,
      k.owner,
      k.unverified,
    ]);
    expect(await found({ query: "redpoll", family: "execution" })).toEqual([
      e.owner,
      e.simulated,
      e.unverified,
    ]);
    // Mixed families compare on the common tier scale, then contribution id within a tie.
    const tier = (a: string, b: string) => [a, b].sort();
    expect(await found({ query: "redpoll" })).toEqual([
      ...tier(k.cross, e.owner),
      ...tier(k.owner, e.simulated),
      ...tier(k.unverified, e.unverified),
    ]);
  });

  it("puts null reliability after any score and orders scores descending", async () => {
    clock = new Date("2026-11-11T00:00:00.000Z");
    const none = await create(knowledge("twite"));
    const low = await create(knowledge("twite"));
    const high = await create(knowledge("twite"));
    const zero = await create(knowledge("twite"));
    await platform(low, { reliabilityScore: 0.2 });
    await platform(high, { reliabilityScore: 0.9 });
    await platform(zero, { reliabilityScore: 0 });
    const [first] = await run({ query: "twite" });
    expect(first.reliabilityScore).toBe(0.9);
    expect(await found({ query: "twite" })).toEqual([high, low, zero, none]);
    // Reliability never lifts a stale result above a current one.
    const staleScored = await create(knowledge("twite", { reviewIntervalDays: 1 }));
    await platform(staleScored, { reliabilityScore: 1 });
    expect(await found({ query: "twite" })).toEqual([high, low, zero, none, staleScored]);
  });

  it("ranks Knowledge corroboration by distinct sources beyond the first, capped", async () => {
    clock = new Date("2026-11-11T00:00:00.000Z");
    const one = await create(knowledge("ortolan"));
    const two = await create(knowledge("ortolan", { sources: [source(1), source(2)] }));
    const five = await create(
      knowledge("ortolan", { sources: [1, 2, 3, 4, 5].map((n) => source(n)) }),
    );
    const six = await create(
      knowledge("ortolan", { sources: [1, 2, 3, 4, 5, 6].map((n) => source(n)) }),
    );
    // five and six both hit the cap (4), so they tie; same creation time, so contribution id.
    expect(await found({ query: "ortolan" })).toEqual([...[five, six].sort(), two, one]);
  });

  it("breaks full ties by latest creation time, then contribution id, deterministically", async () => {
    const older = await create(knowledge("dunnock"), "2026-11-11T00:00:00.000Z");
    const same = [
      await create(knowledge("dunnock"), "2026-11-11T06:00:00.000Z"),
      await create(knowledge("dunnock")),
    ];
    const newer = await create(knowledge("dunnock"), "2026-11-12T00:00:00.000Z");
    const expected = [newer, ...[...same].sort(), older];
    expect(await found({ query: "dunnock" })).toEqual(expected);
    expect(await found({ query: "dunnock" })).toEqual(expected);
  });

  it("applies ranking before the result limit", async () => {
    // Newest by creation time but stale or lower tier; the limit must not keep them first.
    const best = await create(
      knowledge("wryneck", { verification: { method: "cross-source" } }),
      "2026-11-11T00:00:00.000Z",
    );
    await create(knowledge("wryneck", { reviewIntervalDays: 1 }), "2026-11-13T00:00:00.000Z");
    const mid = await create(knowledge("wryneck"), "2026-11-12T00:00:00.000Z");
    expect(await found({ query: "wryneck", limit: 1 })).toEqual([best]);
    expect(await found({ query: "wryneck", limit: 2 })).toEqual([best, mid]);
  });
});

describe("latest-version rule", () => {
  it("ranks and reports freshness from the latest version only", async () => {
    clock = new Date("2026-11-11T00:00:00.000Z");
    const id = await create(
      knowledge("bunting", {
        verification: { method: "cross-source" },
        asOf: "2026-01-01T00:00:00Z",
      }),
    );
    const rival = await create(knowledge("bunting"));
    await platform(id, { reliabilityScore: 1 }, 1);
    // v1 is stale; v2 is current but unverified with no reliability score.
    expect(await found({ query: "bunting" })).toEqual([rival, id]);
    clock = new Date("2026-11-12T00:00:00.000Z");
    const v2 = await registry.createContributionVersion(
      agent,
      id,
      1,
      knowledge("bunting", { verification: { method: "unverified" } }),
    );
    if (!v2.ok) throw new Error(JSON.stringify(v2.error));
    const results = await run({ query: "bunting" });
    expect(results.map((r) => [r.id, r.version, r.freshness, r.reliabilityScore])).toEqual([
      [rival, 1, "current", null],
      [id, 2, "current", null],
    ]);
    expect(results[1].reviewDueAt).toBe("2026-12-10T10:00:00.000Z");
  });
});
