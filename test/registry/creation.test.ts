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
  type CreationErrorCode,
  type RegistryEnv,
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
let operator: OperatorId;

const FIXED = new Date("2026-11-11T12:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-create-"));
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
  registry = new ContributionRegistry(proxy.env, { now: () => FIXED });
  ({ agent, operator } = await actor(true));
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
  evidence: [{ kind: "documentation", uri: "https://example.com/docs/limits" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  facts: [
    { subject: "example-api", predicate: "rateLimitPerMinute", value: 60, unit: "req/min" },
    { subject: "example-api", predicate: "authRequired", value: true },
  ],
  records: [{ endpoint: "/v1/items", method: "GET", limit: 60 }],
  summary: "Documented limits for the Example API.",
  explanation: "Limits apply per API key.",
  sources: [
    {
      uri: "https://example.com/docs/limits",
      accessedAt: "2026-11-10T10:00:00Z",
      sourceDate: "2026-10-01T00:00:00Z",
      hash: { algorithm: "sha256", digest: "a".repeat(64) },
      snapshotRef: "snapshot-001",
    },
  ],
  rights: { sourceLicense: "CC-BY-4.0", rightsHolder: "Example Inc", permittedUse: "summary" },
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
  objective: "Fetch an item by id and verify its status",
  inputs: [{ name: "itemId", type: "string", required: true }],
  outputs: [{ name: "status", type: "string", variable: "itemStatus" }],
  targetDomains: ["api.example.com", "cdn.example.com"],
  compatibility: {
    requiredCapabilities: ["http-client"],
    targetVersions: [{ domain: "api.example.com", version: "v1" }],
  },
  steps: [
    {
      id: "fetch",
      type: "http_request",
      method: "GET",
      domain: "api.example.com",
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
  verification: {
    method: "owner-tested",
    testedAt: "2026-11-10T10:00:00Z",
    declaredConfidence: 0.8,
  },
  asOf: "2026-11-10T10:00:00Z",
});

function must(r: CreateContributionResult) {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.contribution;
}
function codeOf(r: CreateContributionResult): CreationErrorCode | "ok" {
  return r.ok ? "ok" : r.error.code;
}
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

describe("valid Knowledge creation", () => {
  it("assigns platform fields and stores normalized rows", async () => {
    const input = knowledge();
    const c = must(await registry.createContribution(agent, input));
    expect(c.version).toBe(1);
    expect(c.family).toBe("knowledge");
    expect(c.contributor).toEqual({ agentId: agent, operatorId: operator });
    expect(c.createdAt).toBe(FIXED.toISOString());
    expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]{7,63}$/);

    const canonical = canonicalJson(input);
    expect(c.contentHash).toBe(await sha256Hex(canonical));
    expect(c.payloadBytes).toBe(new TextEncoder().encode(canonical).byteLength);

    const v = await db
      .prepare("SELECT * FROM contribution_versions WHERE contribution_id = ?")
      .bind(c.id)
      .first<Record<string, unknown>>();
    expect(v).toMatchObject({
      version: 1,
      previous_version: null,
      family: "knowledge",
      author_agent_id: agent,
      author_operator_id: operator,
      content_hash: c.contentHash,
      payload_bytes: c.payloadBytes,
      title: input.title,
      content_type: "api-reference",
      license: "CC-BY-4.0",
      review_interval_days: 30,
      as_of: "2026-11-10T10:00:00Z",
      created_at: FIXED.toISOString(),
    });
    const kv = await db
      .prepare("SELECT * FROM knowledge_versions WHERE contribution_id = ?")
      .bind(c.id)
      .first<Record<string, unknown>>();
    expect(kv).toMatchObject({
      summary: "Documented limits for the Example API.",
      source_license: "CC-BY-4.0",
      rights_holder: "Example Inc",
      permitted_use: "summary",
      verification_method: "owner-tested",
      declared_confidence: 0.9,
      records_json: '[{"endpoint":"/v1/items","limit":60,"method":"GET"}]',
    });
    const facts = await db
      .prepare(
        "SELECT ordinal, subject, value_json, unit FROM knowledge_facts WHERE contribution_id = ? ORDER BY ordinal",
      )
      .bind(c.id)
      .all();
    expect(facts.results).toEqual([
      { ordinal: 0, subject: "example-api", value_json: "60", unit: "req/min" },
      { ordinal: 1, subject: "example-api", value_json: "true", unit: null },
    ]);
    const src = await db
      .prepare(
        "SELECT uri, hash_digest, snapshot_ref FROM knowledge_sources WHERE contribution_id = ?",
      )
      .bind(c.id)
      .all();
    expect(src.results).toEqual([
      {
        uri: "https://example.com/docs/limits",
        hash_digest: "a".repeat(64),
        snapshot_ref: "snapshot-001",
      },
    ]);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS c FROM contribution_evidence WHERE contribution_id = ?")
        .bind(c.id)
        .first<{ c: number }>())!.c,
    ).toBe(1);
    const ps = await db
      .prepare("SELECT * FROM version_platform_state WHERE contribution_id = ?")
      .bind(c.id)
      .first();
    expect(ps).toMatchObject({
      version: 1,
      last_verified_at: null,
      reliability_score: null,
      consumer_count: 0,
    });
    const parent = await db
      .prepare(
        "SELECT family, contributor_agent_id, contributor_operator_id FROM contributions WHERE id = ?",
      )
      .bind(c.id)
      .first();
    expect(parent).toEqual({
      family: "knowledge",
      contributor_agent_id: agent,
      contributor_operator_id: operator,
    });
  });

  it("stores immutable canonical content in R2 at the hash-derived key", async () => {
    const input = knowledge();
    const c = must(await registry.createContribution(agent, input));
    expect(c.contentKey).toBe(`contributions/sha256/${c.contentHash}`);
    const obj = await getContentObject(bucket, c.contentHash);
    expect(obj).not.toBeNull();
    expect(new TextDecoder().decode(obj!.bytes)).toBe(canonicalJson(input));
    expect(obj).toMatchObject({
      family: "knowledge",
      contentType: "api-reference",
      sha256: c.contentHash,
    });
    // No platform fields in the stored body.
    const body = JSON.parse(new TextDecoder().decode(obj!.bytes)) as Record<string, unknown>;
    for (const k of ["id", "version", "contentHash", "contributor", "createdAt"])
      expect(body).not.toHaveProperty(k);
  });
});

describe("valid Execution creation", () => {
  it("stores normalized rows, JSON columns and target domains", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const input = execution([{ family: "knowledge", id: k.id, version: 1 }]);
    const c = must(await registry.createContribution(agent, input));
    expect(c.family).toBe("execution");
    const ev = await db
      .prepare("SELECT * FROM execution_versions WHERE contribution_id = ?")
      .bind(c.id)
      .first<Record<string, unknown>>();
    expect(ev).toMatchObject({
      objective: "Fetch an item by id and verify its status",
      side_effect: "read-only",
      requires_human_approval: 0,
      max_requests: 1,
      timeout_seconds: 30,
      on_failure: "stop",
      verification_method: "owner-tested",
      tested_at: "2026-11-10T10:00:00Z",
      declared_confidence: 0.8,
      success_checks_json: '["check"]',
    });
    expect(JSON.parse(ev!.steps_json as string)).toEqual(input.steps as unknown[]);
    expect(JSON.parse(ev!.compatibility_json as string)).toEqual(input.compatibility);
    const domains = await db
      .prepare(
        "SELECT domain FROM execution_target_domains WHERE contribution_id = ? ORDER BY domain",
      )
      .bind(c.id)
      .all();
    expect(domains.results.map((r) => r.domain)).toEqual(["api.example.com", "cdn.example.com"]);
    const ref = await db
      .prepare("SELECT * FROM contribution_references WHERE from_contribution_id = ?")
      .bind(c.id)
      .all();
    expect(ref.results).toEqual([
      {
        from_contribution_id: c.id,
        from_version: 1,
        from_family: "execution",
        ordinal: 0,
        to_contribution_id: k.id,
        to_version: 1,
        to_family: "knowledge",
      },
    ]);
    const obj = await getContentObject(bucket, c.contentHash);
    expect(obj).toMatchObject({ family: "execution", contentType: "api-recipe" });
  });
});

describe("rejections", () => {
  it("rejects duplicate content without writing anything", async () => {
    const input = knowledge();
    const first = must(await registry.createContribution(agent, input));
    const before = await snapshot();
    const second = await registry.createContribution(agent, structuredClone(input));
    expect(codeOf(second)).toBe("duplicate_content");
    expect(!second.ok && second.error.existing).toEqual({ contributionId: first.id, version: 1 });
    expect(await snapshot()).toEqual(before);
  });

  it("does not reveal another operator's contribution on duplicate", async () => {
    const input = knowledge();
    must(await registry.createContribution(agent, input));
    const other = await actor(true);
    const r = await registry.createContribution(other.agent, structuredClone(input));
    expect(codeOf(r)).toBe("duplicate_content");
    expect(!r.ok && r.error.existing).toBeUndefined();
  });

  it("rejects unresolved references (unknown id, wrong version, id of the other family)", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const e = must(await registry.createContribution(agent, execution()));
    const before = await snapshot();
    const refs = [
      [{ family: "knowledge", id: "does-not-exist-1", version: 1 }],
      [{ family: "knowledge", id: k.id, version: 2 }],
      [{ family: "knowledge", id: e.id, version: 1 }], // e is an execution contribution
    ];
    for (const related of refs) {
      expect(codeOf(await registry.createContribution(agent, execution(related)))).toBe(
        "unresolved_reference",
      );
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rejects invalid content and unknown families", async () => {
    const before = await snapshot();
    const bad = knowledge();
    delete bad.title;
    expect(codeOf(await registry.createContribution(agent, bad))).toBe("invalid_content");
    expect(
      codeOf(
        await registry.createContribution(agent, { ...knowledge(), reviewIntervalDays: 100000 }),
      ),
    ).toBe("invalid_content");
    expect(
      codeOf(
        await registry.createContribution(agent, {
          ...execution(),
          steps: [{ id: "x", type: "shell" }],
        }),
      ),
    ).toBe("invalid_content");
    expect(
      codeOf(await registry.createContribution(agent, { ...knowledge(), family: "other" })),
    ).toBe("invalid_content");
    for (const junk of [null, "text", 5, [], undefined]) {
      expect(codeOf(await registry.createContribution(agent, junk))).toBe("invalid_content");
    }
    const r = await registry.createContribution(agent, bad);
    expect(!r.ok && r.error.errors?.some((e) => e.startsWith("title"))).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects caller-selected platform fields", async () => {
    const before = await snapshot();
    const fields: Record<string, unknown> = {
      id: "caller-chosen-id",
      version: 7,
      contentHash: "b".repeat(64),
      contributor: { agentId: "x", operatorId: "y" },
      createdAt: "2020-01-01T00:00:00Z",
      lastVerifiedAt: "2020-01-01T00:00:00Z",
      reliabilityScore: 1,
      consumerCount: 99,
    };
    for (const [k, v] of Object.entries(fields)) {
      for (const base of [knowledge(), execution()]) {
        const r = await registry.createContribution(agent, { ...base, [k]: v });
        expect(codeOf(r)).toBe("platform_field_rejected");
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unknown, revoked and suspended actors", async () => {
    const before = await snapshot();
    expect(codeOf(await registry.createContribution("ag_missing00" as AgentId, knowledge()))).toBe(
      "actor_not_found",
    );

    const revoked = await actor(true);
    await identity.revokeAgent(revoked.agent);
    expect(codeOf(await registry.createContribution(revoked.agent, knowledge()))).toBe(
      "actor_inactive",
    );

    const suspended = await actor(true);
    await identity.suspendOperator(suspended.operator);
    expect(codeOf(await registry.createContribution(suspended.agent, knowledge()))).toBe(
      "actor_inactive",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("requires the operator allow-list flag (default off)", async () => {
    const before = await snapshot();
    const blocked = await actor(false);
    expect(codeOf(await registry.createContribution(blocked.agent, knowledge()))).toBe(
      "operator_not_allow_listed",
    );
    expect(await snapshot()).toEqual(before);
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(blocked.operator)
      .run();
    expect(codeOf(await registry.createContribution(blocked.agent, knowledge()))).toBe("ok");
  });
});

describe("failure atomicity and R2-before-D1 ordering", () => {
  it("rolls back every row when the D1 batch fails, leaving only a harmless R2 orphan; retry reuses it", async () => {
    // Append a statement that violates a CHECK so the whole batch must roll back.
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
                .bind(FIXED.toISOString()),
            ]);
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const broken = new ContributionRegistry(
      { DB: failingDb, CONTENT_BUCKET: bucket },
      { now: () => FIXED },
    );
    const input = knowledge();
    const hash = await sha256Hex(canonicalJson(input));
    const before = await snapshot();

    expect(codeOf(await broken.createContribution(agent, input))).toBe("persistence_failed");
    expect(await snapshot()).toEqual(before); // atomic: nothing partial
    expect(await bucket.head(`contributions/sha256/${hash}`)).not.toBeNull(); // orphan exists, unreferenced
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS c FROM contribution_versions WHERE content_hash = ?")
        .bind(hash)
        .first<{ c: number }>())!.c,
    ).toBe(0);

    const retry = must(await registry.createContribution(agent, input));
    expect(retry.contentHash).toBe(hash);
  });

  it("writes nothing to D1 when the R2 write fails (D1 never points to a missing object)", async () => {
    const brokenBucket = new Proxy(bucket, {
      get(target, prop) {
        if (prop === "put") return () => Promise.reject(new Error("r2 down"));
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const broken = new ContributionRegistry(
      { DB: db, CONTENT_BUCKET: brokenBucket },
      { now: () => FIXED },
    );
    const before = await snapshot();
    expect(codeOf(await broken.createContribution(agent, knowledge()))).toBe("storage_failed");
    expect(await snapshot()).toEqual(before);
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
