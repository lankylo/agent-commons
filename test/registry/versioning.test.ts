import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId, OperatorId } from "../../src/identity/types";
import { canonicalJson, sha256Hex } from "../../src/registry/content-hash";
import {
  ContributionRegistry,
  type CreateContributionResult,
  type CreateVersionResult,
  type RegistryEnv,
  type VersionErrorCode,
} from "../../src/registry/creation";
import { getContentObject } from "../../src/storage/content-objects";

// Local D1 + R2 emulation (Miniflare), real migrations, throwaway persistence.
let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let bucket: R2Bucket;
let identity: IdentityRepository;
let registry: ContributionRegistry;
let agent: AgentId;
let agent2: AgentId; // second agent of the same operator
let operator: OperatorId;

const T1 = new Date("2026-11-11T12:00:00.000Z");
const T2 = new Date("2026-11-11T13:00:00.000Z");
let clock = T1;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-version-"));
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
  bucket = proxy.env.CONTENT_BUCKET;
  identity = new IdentityRepository(db);
  registry = new ContributionRegistry(proxy.env, { now: () => clock });
  const a = await actor(true);
  agent = a.agent;
  operator = a.operator;
  agent2 = (await identity.registerAgent(operator, { displayName: "Second" })).id;
}, 120_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function actor(allowListed: boolean) {
  const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
  if (allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(op.id)
      .run();
  }
  const ag = await identity.registerAgent(op.id, { displayName: "Agent" });
  return { agent: ag.id, operator: op.id };
}

let n = 0;
const knowledge = (): Record<string, unknown> => ({
  family: "knowledge",
  title: `Example API rate limits ${++n}`,
  purpose: "Record documented rate limits",
  contentType: "api-reference",
  evidence: [{ kind: "documentation", uri: `https://example.com/docs/limits/${n}` }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  facts: [
    { subject: "example-api", predicate: "rateLimitPerMinute", value: 60 + n, unit: "req/min" },
  ],
  summary: "Documented limits for the Example API.",
  sources: [
    {
      uri: "https://example.com/docs/limits",
      accessedAt: "2026-11-10T10:00:00Z",
      hash: { algorithm: "sha256", digest: "a".repeat(64) },
    },
  ],
  rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
  verification: { method: "owner-tested", declaredConfidence: 0.9 },
  asOf: "2026-11-10T10:00:00Z",
});

const execution = (related?: unknown): Record<string, unknown> => ({
  family: "execution",
  title: `Fetch an item from Example API ${++n}`,
  purpose: "Retrieve an item and confirm it exists",
  contentType: "api-recipe",
  evidence: [{ kind: "documentation", uri: "https://example.com/docs/items" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  ...(related === undefined ? {} : { related }),
  objective: `Fetch an item by id and verify its status ${n}`,
  inputs: [{ name: "itemId", type: "string", required: true }],
  outputs: [{ name: "status", type: "string", variable: "itemStatus" }],
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
      expected: "active",
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
  asOf: "2026-11-10T10:00:00Z",
});

function must(r: CreateContributionResult) {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.contribution;
}
function mustV(r: CreateVersionResult) {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.contribution;
}
const codeOf = (r: CreateVersionResult): VersionErrorCode | "ok" => (r.ok ? "ok" : r.error.code);
const count = async (table: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
const TABLES = [
  "contributions",
  "contribution_versions",
  "contribution_evidence",
  "contribution_references",
  "version_platform_state",
  "knowledge_versions",
  "knowledge_facts",
  "knowledge_sources",
  "execution_versions",
  "execution_target_domains",
];
const snapshot = async () =>
  Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));

const versionRow = (id: string, v: number) =>
  db
    .prepare("SELECT * FROM contribution_versions WHERE contribution_id = ? AND version = ?")
    .bind(id, v)
    .first<Record<string, unknown>>();

describe("Knowledge version 2", () => {
  it("assigns platform fields, keeps id/family, and stores all rows", async () => {
    clock = T1;
    const v1 = must(await registry.createContribution(agent, knowledge()));
    clock = T2;
    const input = knowledge();
    const v2 = mustV(await registry.createContributionVersion(agent2, v1.id, 1, input));

    expect(v2).toMatchObject({
      id: v1.id,
      version: 2,
      previousVersion: 1,
      family: "knowledge",
      contributor: { agentId: agent2, operatorId: operator },
      createdAt: T2.toISOString(),
    });
    expect(v2.contentHash).toBe(await sha256Hex(canonicalJson(input)));
    expect(v2.contentHash).not.toBe(v1.contentHash);

    const row = await versionRow(v1.id, 2);
    expect(row).toMatchObject({
      previous_version: 1,
      family: "knowledge",
      author_agent_id: agent2,
      author_operator_id: operator,
      content_hash: v2.contentHash,
      created_at: T2.toISOString(),
    });
    // Original contributor and creation time are permanent.
    expect(
      await db
        .prepare(
          "SELECT contributor_agent_id AS a, created_at AS c, family AS f FROM contributions WHERE id = ?",
        )
        .bind(v1.id)
        .first(),
    ).toEqual({ a: agent, c: T1.toISOString(), f: "knowledge" });

    for (const [table, expected] of [
      ["version_platform_state", 1],
      ["contribution_evidence", 1],
      ["knowledge_versions", 1],
      ["knowledge_facts", 1],
      ["knowledge_sources", 1],
    ] as const) {
      const c = await db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE contribution_id = ? AND version = 2`)
        .bind(v1.id)
        .first<{ c: number }>();
      expect(c!.c, table).toBe(expected);
    }
    // R2 holds the exact canonical bytes.
    const obj = await getContentObject(bucket, v2.contentHash);
    expect(new TextDecoder().decode(obj!.bytes)).toBe(canonicalJson(input));
  });

  it("builds a contiguous chain 1 -> 2 -> 3 -> 4 and leaves earlier versions unchanged", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    const before = await versionRow(v1.id, 1);
    const bytes1 = await getContentObject(bucket, v1.contentHash);
    for (let v = 1; v <= 3; v++) {
      const r = mustV(await registry.createContributionVersion(agent, v1.id, v, knowledge()));
      expect(r.version).toBe(v + 1);
    }
    const rows = await db
      .prepare(
        "SELECT version, previous_version AS p FROM contribution_versions WHERE contribution_id = ? ORDER BY version",
      )
      .bind(v1.id)
      .all<{ version: number; p: number | null }>();
    expect(rows.results).toEqual([
      { version: 1, p: null },
      { version: 2, p: 1 },
      { version: 3, p: 2 },
      { version: 4, p: 3 },
    ]);
    expect(await versionRow(v1.id, 1)).toEqual(before);
    const after = await getContentObject(bucket, v1.contentHash);
    expect(new TextDecoder().decode(after!.bytes)).toBe(new TextDecoder().decode(bytes1!.bytes));
  });
});

describe("Execution version 2 and references", () => {
  it("creates version 2 with steps, domains and resolved references", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const e1 = must(await registry.createContribution(agent, execution()));
    const related = [{ family: "knowledge", id: k.id, version: 1 }];
    const e2 = mustV(
      await registry.createContributionVersion(agent2, e1.id, 1, execution(related)),
    );
    expect(e2).toMatchObject({ version: 2, previousVersion: 1, family: "execution" });

    const exec = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM execution_versions WHERE contribution_id = ? AND version = 2",
      )
      .bind(e1.id)
      .first<{ c: number }>();
    expect(exec!.c).toBe(1);
    const ref = await db
      .prepare(
        "SELECT from_version, to_contribution_id, to_version, to_family FROM contribution_references WHERE from_contribution_id = ?",
      )
      .bind(e1.id)
      .all();
    expect(ref.results).toEqual([
      { from_version: 2, to_contribution_id: k.id, to_version: 1, to_family: "knowledge" },
    ]);
    const dom = await db
      .prepare(
        "SELECT domain FROM execution_target_domains WHERE contribution_id = ? AND version = 2",
      )
      .bind(e1.id)
      .all();
    expect(dom.results).toEqual([{ domain: "api.acme.com" }]);
  });

  it("resolves references to a new version of the referenced contribution", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const k2 = mustV(await registry.createContributionVersion(agent, k.id, 1, knowledge()));
    const e = must(await registry.createContribution(agent, execution()));
    const ok = await registry.createContributionVersion(
      agent,
      e.id,
      1,
      execution([{ family: "knowledge", id: k.id, version: k2.version }]),
    );
    expect(codeOf(ok)).toBe("ok");
  });

  it("rejects unresolved references, writing nothing", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const e = must(await registry.createContribution(agent, execution()));
    const before = await snapshot();
    for (const related of [
      [{ family: "knowledge", id: "does-not-exist-1", version: 1 }],
      [{ family: "knowledge", id: k.id, version: 9 }],
      [{ family: "knowledge", id: e.id, version: 1 }], // id of the other family
    ]) {
      expect(
        codeOf(await registry.createContributionVersion(agent, e.id, 1, execution(related))),
      ).toBe("unresolved_reference");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("checks current policy for new versions but not immutable-version integrity", async () => {
    const v1 = must(await registry.createContribution(agent, execution()));
    const restrictivePolicy = new ContributionRegistry(
      {
        ...proxy.env,
        EXECUTION_DOMAIN_POLICY_JSON: JSON.stringify({
          allowed: [{ domain: "httpbin.org", includeSubdomains: true }],
          denied: ["acme.com"],
        }),
      },
      { now: () => clock },
    );

    expect(
      codeOf(await restrictivePolicy.createContributionVersion(agent, v1.id, 1, execution())),
    ).toBe("invalid_content");

    const stored = await restrictivePolicy.getContributionVersion(v1.id, 1);
    expect(stored.ok).toBe(true);

    const missingPolicy = new ContributionRegistry({ DB: db, CONTENT_BUCKET: bucket });
    expect(
      codeOf(await missingPolicy.createContributionVersion(agent, v1.id, 1, execution())),
    ).toBe("execution_domain_policy_unavailable");
    expect(await versionRow(v1.id, 1)).toMatchObject({ version: 1 });
  });
});

describe("rejections", () => {
  it("rejects stale and future expected versions with the latest version", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    mustV(await registry.createContributionVersion(agent, v1.id, 1, knowledge()));
    const before = await snapshot();
    const stale = await registry.createContributionVersion(agent, v1.id, 1, knowledge());
    expect(stale.ok ? null : stale.error).toMatchObject({
      code: "version_conflict",
      latestVersion: 2,
    });
    expect(codeOf(await registry.createContributionVersion(agent, v1.id, 5, knowledge()))).toBe(
      "version_conflict",
    );
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(codeOf(await registry.createContributionVersion(agent, v1.id, bad, knowledge()))).toBe(
        "invalid_expected_version",
      );
    }
    expect(await snapshot()).toEqual(before);
  });

  it("lets exactly one of two concurrent updates win", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    const results = await Promise.all([
      registry.createContributionVersion(agent, v1.id, 1, knowledge()),
      registry.createContributionVersion(agent2, v1.id, 1, knowledge()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.ok ? "" : loser.error.code).toBe("version_conflict");
    const c = await db
      .prepare("SELECT COUNT(*) AS c FROM contribution_versions WHERE contribution_id = ?")
      .bind(v1.id)
      .first<{ c: number }>();
    expect(c!.c).toBe(2);
  });

  it("maps a race lost inside the D1 batch (primary key) to version_conflict and writes no rows", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true; // a competitor commits version 2 after our checks passed
              mustV(await registry.createContributionVersion(agent, v1.id, 1, knowledge()));
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const racing = new ContributionRegistry(
      { DB: racingDb, CONTENT_BUCKET: bucket },
      { now: () => clock },
    );
    const mine = await racing.createContributionVersion(agent, v1.id, 1, knowledge());
    expect(codeOf(mine)).toBe("version_conflict");
    const c = await db
      .prepare("SELECT COUNT(*) AS c FROM contribution_versions WHERE contribution_id = ?")
      .bind(v1.id)
      .first<{ c: number }>();
    expect(c!.c).toBe(2); // only the competitor's version; ours rolled back entirely
    const ev = await db
      .prepare("SELECT COUNT(*) AS c FROM contribution_evidence WHERE contribution_id = ?")
      .bind(v1.id)
      .first<{ c: number }>();
    expect(ev!.c).toBe(2); // v1 + competitor v2, nothing from the lost batch
  });

  it("rejects missing contributions", async () => {
    const before = await snapshot();
    expect(
      codeOf(
        await registry.createContributionVersion(agent, "no-such-contribution", 1, knowledge()),
      ),
    ).toBe("contribution_not_found");
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a family change in either direction", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const e = must(await registry.createContribution(agent, execution()));
    const before = await snapshot();
    expect(codeOf(await registry.createContributionVersion(agent, k.id, 1, execution()))).toBe(
      "family_mismatch",
    );
    expect(codeOf(await registry.createContributionVersion(agent, e.id, 1, knowledge()))).toBe(
      "family_mismatch",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("rejects an author from another operator, even if allow-listed", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    const other = await actor(true);
    const before = await snapshot();
    expect(
      codeOf(await registry.createContributionVersion(other.agent, v1.id, 1, knowledge())),
    ).toBe("operator_mismatch");
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unknown, revoked and suspended actors and a de-listed operator", async () => {
    const own = await actor(true);
    const v1 = must(await registry.createContribution(own.agent, knowledge()));
    const spare = await identity.registerAgent(own.operator, { displayName: "Spare" });
    const before = await snapshot();
    const attempt = (a: AgentId) => registry.createContributionVersion(a, v1.id, 1, knowledge());

    expect(codeOf(await attempt("ag_unknown" as AgentId))).toBe("actor_not_found");

    await identity.revokeAgent(spare.id);
    expect(codeOf(await attempt(spare.id))).toBe("actor_inactive");

    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 0 WHERE id = ?")
      .bind(own.operator)
      .run();
    expect(codeOf(await attempt(own.agent))).toBe("operator_not_allow_listed");
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(own.operator)
      .run();

    await identity.suspendOperator(own.operator);
    expect(codeOf(await attempt(own.agent))).toBe("actor_inactive");
    expect(await snapshot()).toEqual(before);
  });

  it("rejects invalid content and platform-set fields", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    const before = await snapshot();
    const bad = { ...knowledge(), title: "" };
    expect(codeOf(await registry.createContributionVersion(agent, v1.id, 1, bad))).toBe(
      "invalid_content",
    );
    expect(codeOf(await registry.createContributionVersion(agent, v1.id, 1, "nope"))).toBe(
      "family_mismatch",
    );
    for (const field of ["version", "id", "contentHash", "contributor", "createdAt"]) {
      expect(
        codeOf(
          await registry.createContributionVersion(agent, v1.id, 1, { ...knowledge(), [field]: 2 }),
        ),
      ).toBe("platform_field_rejected");
    }
    // Other caller-chosen link/author fields are unknown to the schema and also rejected.
    for (const field of ["previousVersion", "authorAgentId"]) {
      expect(
        codeOf(
          await registry.createContributionVersion(agent, v1.id, 1, { ...knowledge(), [field]: 1 }),
        ),
      ).toBe("invalid_content");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rejects duplicate hashes: of its own earlier version and of another contribution", async () => {
    const input1 = knowledge();
    const a = must(await registry.createContribution(agent, input1));
    const b = must(await registry.createContribution(agent, knowledge()));
    const before = await snapshot();

    const self = await registry.createContributionVersion(agent, a.id, 1, input1);
    expect(self.ok ? null : self.error).toMatchObject({
      code: "duplicate_content",
      existing: { contributionId: a.id, version: 1 },
    });
    const bInput = knowledge();
    const other = must(await registry.createContribution(agent, bInput));
    const dup = await registry.createContributionVersion(agent, b.id, 1, bInput);
    expect(dup.ok ? null : dup.error.code).toBe("duplicate_content");
    expect(dup.ok ? null : dup.error.existing).toEqual({ contributionId: other.id, version: 1 });
    expect(await count("contribution_versions")).toBe(before.contribution_versions! + 1);
  });

  it("does not reveal another operator's contribution on duplicate", async () => {
    const other = await actor(true);
    const theirs = knowledge();
    must(await registry.createContribution(other.agent, theirs));
    const mine = must(await registry.createContribution(agent, knowledge()));
    const r = await registry.createContributionVersion(agent, mine.id, 1, theirs);
    expect(r.ok ? null : r.error).toEqual({
      code: "duplicate_content",
      message: "identical content already exists",
    });
  });
});

describe("failure behavior (R2 first, then one atomic D1 batch)", () => {
  it("rolls back every row when the D1 batch fails; R2 orphan is harmless; retry succeeds", async () => {
    const v1 = must(await registry.createContribution(agent, execution()));
    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return (stmts: D1PreparedStatement[]) =>
            target.batch([
              ...stmts,
              target
                .prepare(
                  "INSERT INTO operators (id, kind, display_name, created_at) VALUES ('short', 'individual', 'x', ?)",
                )
                .bind(T1.toISOString()),
            ]);
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const broken = new ContributionRegistry(
      {
        DB: failingDb,
        CONTENT_BUCKET: bucket,
        EXECUTION_DOMAIN_POLICY_JSON: proxy.env.EXECUTION_DOMAIN_POLICY_JSON,
      },
      { now: () => clock },
    );
    const input = execution();
    const hash = await sha256Hex(canonicalJson(input));
    const before = await snapshot();

    expect(codeOf(await broken.createContributionVersion(agent, v1.id, 1, input))).toBe(
      "persistence_failed",
    );
    expect(await snapshot()).toEqual(before);
    expect(await bucket.head(`contributions/sha256/${hash}`)).not.toBeNull();

    const retry = mustV(await registry.createContributionVersion(agent, v1.id, 1, input));
    expect(retry.contentHash).toBe(hash);
  });

  it("writes nothing to D1 when R2 fails, and keeps earlier versions retrievable", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    const brokenBucket = new Proxy(bucket, {
      get(target, prop) {
        if (prop === "put") return () => Promise.reject(new Error("r2 down"));
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const broken = new ContributionRegistry(
      { DB: db, CONTENT_BUCKET: brokenBucket },
      { now: () => clock },
    );
    const before = await snapshot();
    expect(codeOf(await broken.createContributionVersion(agent, v1.id, 1, knowledge()))).toBe(
      "storage_failed",
    );
    expect(await snapshot()).toEqual(before);
    expect(await getContentObject(bucket, v1.contentHash)).not.toBeNull();
  });

  it("every stored version has its R2 object", async () => {
    const rows = await db
      .prepare("SELECT content_hash FROM contribution_versions")
      .all<{ content_hash: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results)
      expect(await bucket.head(`contributions/sha256/${r.content_hash}`)).not.toBeNull();
  });
});
