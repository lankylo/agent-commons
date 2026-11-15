import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../../src/identity/credentials";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId, OperatorId } from "../../src/identity/types";
import { canonicalJson, sha256Hex } from "../../src/registry/content-hash";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import { getContentObject } from "../../src/storage/content-objects";

// Phase 2 end-to-end integration across identity, credentials, registry creation,
// versioning, retrieval, D1 and R2. Real migrations, local Miniflare emulation only.
let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let bucket: R2Bucket;
let identity: IdentityRepository;
let credentials: CredentialService;
let registry: ContributionRegistry;

const T1 = new Date("2026-11-11T12:00:00.000Z");
const T2 = new Date("2026-11-11T13:00:00.000Z");
let clock = T1;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-phase2-"));
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
  credentials = new CredentialService(db, { now: () => clock });
  registry = new ContributionRegistry(proxy.env, { now: () => clock });
}, 120_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const knowledge = (): Record<string, unknown> => ({
  family: "knowledge",
  title: `Example API rate limits ${++n}`,
  purpose: "Record documented rate limits",
  contentType: "api-reference",
  evidence: [{ kind: "documentation", uri: `https://httpbin.org/docs/limits/${n}` }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  facts: [
    { subject: "example-api", predicate: "rateLimitPerMinute", value: 60 + n, unit: "req/min" },
  ],
  summary: "Documented limits for the Example API.",
  sources: [
    {
      uri: "https://httpbin.org/docs/limits",
      accessedAt: "2026-11-10T10:00:00Z",
      hash: { algorithm: "sha256", digest: "a".repeat(64) },
    },
  ],
  rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
  verification: { method: "owner-tested", declaredConfidence: 0.9 },
  asOf: "2026-11-10T10:00:00Z",
});

const execution = (related: unknown): Record<string, unknown> => ({
  family: "execution",
  title: `Fetch an item from Example API ${++n}`,
  purpose: "Retrieve an item and confirm it exists",
  contentType: "api-recipe",
  evidence: [{ kind: "documentation", uri: "https://example.com/docs/items" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  related,
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

describe("Phase 2 identity -> registry workflow", () => {
  it("creates, versions, retrieves and verifies both families end to end", async () => {
    // 1. Operator and agent. 2. Credential issued and verified.
    const op = await identity.createOperator({
      kind: "organization",
      displayName: "Integration Op",
    });
    const agent = await identity.registerAgent(op.id, { displayName: "Integration Agent" });
    expect(await identity.resolveAgent(agent.id)).toMatchObject({ operator: { id: op.id } });
    const { token } = await credentials.issueCredential(agent.id, { label: "integration" });
    const verified = await credentials.verifyCredential(token);
    expect(verified).toMatchObject({ ok: true, agentId: agent.id, operatorId: op.id });
    if (!verified.ok) throw new Error("credential verification failed");
    const actor: AgentId = verified.agentId; // registry actor comes from the verified credential

    // Allow-list is off by default: creation is refused until local admin setup enables it.
    const k1Input = knowledge();
    const refused = await registry.createContribution(actor, k1Input);
    expect(refused).toMatchObject({ ok: false, error: { code: "operator_not_allow_listed" } });
    expect(await count("contributions")).toBe(0);

    // 3. Local administrative setup (the same direct update the existing tests use).
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(op.id)
      .run();

    // 4. Knowledge v1. 5. Execution v1 referencing the exact Knowledge ID and version.
    clock = T1;
    const k1 = await registry.createContribution(actor, k1Input);
    if (!k1.ok) throw new Error(JSON.stringify(k1.error));
    const e1Input = execution([{ family: "knowledge", id: k1.contribution.id, version: 1 }]);
    const e1 = await registry.createContribution(actor, e1Input);
    if (!e1.ok) throw new Error(JSON.stringify(e1.error));

    // 6. Second immutable version of each; Execution v2 references Knowledge v2.
    clock = T2;
    const k2Input = knowledge();
    const k2 = await registry.createContributionVersion(actor, k1.contribution.id, 1, k2Input);
    if (!k2.ok) throw new Error(JSON.stringify(k2.error));
    const e2Input = execution([{ family: "knowledge", id: k1.contribution.id, version: 2 }]);
    const e2 = await registry.createContributionVersion(actor, e1.contribution.id, 1, e2Input);
    if (!e2.ok) throw new Error(JSON.stringify(e2.error));

    // 7. Retrieve every exact version and verify identity, provenance, hashes, references, D1, R2.
    const cases = [
      { id: k1.contribution.id, version: 1, family: "knowledge", input: k1Input, ref: null },
      { id: k1.contribution.id, version: 2, family: "knowledge", input: k2Input, ref: null },
      { id: e1.contribution.id, version: 1, family: "execution", input: e1Input, ref: 1 },
      { id: e1.contribution.id, version: 2, family: "execution", input: e2Input, ref: 2 },
    ] as const;

    for (const c of cases) {
      const got = await registry.getContributionVersion(c.id, c.version);
      if (!got.ok) throw new Error(JSON.stringify(got.error));
      const r = got.contribution;
      const expectedHash = await sha256Hex(canonicalJson(c.input));
      expect(r).toMatchObject({
        id: c.id,
        version: c.version,
        family: c.family,
        previousVersion: c.version === 1 ? null : 1,
        contentHash: expectedHash,
        author: { agentId: agent.id, operatorId: op.id },
        contributor: { agentId: agent.id, operatorId: op.id },
        createdAt: (c.version === 1 ? T1 : T2).toISOString(),
        contributionCreatedAt: T1.toISOString(),
        platformState: { reliabilityScore: null, consumerCount: 0, lastVerifiedAt: null },
      });
      expect(canonicalJson(r.content)).toBe(canonicalJson(c.input));

      // D1 version row.
      expect(
        await db
          .prepare(
            "SELECT family, content_hash, author_agent_id, author_operator_id, previous_version FROM contribution_versions WHERE contribution_id = ? AND version = ?",
          )
          .bind(c.id, c.version)
          .first(),
      ).toEqual({
        family: c.family,
        content_hash: expectedHash,
        author_agent_id: agent.id,
        author_operator_id: op.id,
        previous_version: c.version === 1 ? null : 1,
      });

      // R2 object: exact canonical bytes under the hash-derived key.
      const obj = await getContentObject(bucket, expectedHash);
      expect(new TextDecoder().decode(obj!.bytes)).toBe(canonicalJson(c.input));

      // References: exact ID and version in D1 and in the retrieved content.
      const refs = await db
        .prepare(
          "SELECT to_contribution_id, to_version, to_family FROM contribution_references WHERE from_contribution_id = ? AND from_version = ?",
        )
        .bind(c.id, c.version)
        .all();
      if (c.ref === null) {
        expect(refs.results).toEqual([]);
      } else {
        const expected = [{ family: "knowledge", id: k1.contribution.id, version: c.ref }];
        expect(refs.results).toEqual([
          { to_contribution_id: k1.contribution.id, to_version: c.ref, to_family: "knowledge" },
        ]);
        expect(r.content.related).toEqual(expected);
      }
    }

    // Hashes are distinct across versions; contribution rows keep original contributor and family.
    const hashes = new Set([
      k1.contribution.contentHash,
      k2.contribution.contentHash,
      e1.contribution.contentHash,
      e2.contribution.contentHash,
    ]);
    expect(hashes.size).toBe(4);
    for (const [id, family] of [
      [k1.contribution.id, "knowledge"],
      [e1.contribution.id, "execution"],
    ] as const) {
      expect(
        await db
          .prepare("SELECT contributor_agent_id AS a, family AS f FROM contributions WHERE id = ?")
          .bind(id)
          .first(),
      ).toEqual({ a: agent.id, f: family });
    }
    expect(await count("contribution_versions")).toBe(4);

    // 8. Rejections leave D1 untouched.
    const before = await snapshot();

    // Duplicate content (exact resubmission of an existing version's content).
    const dupCreate = await registry.createContribution(actor, k1Input);
    expect(dupCreate).toMatchObject({ ok: false, error: { code: "duplicate_content" } });
    const dupVersion = await registry.createContributionVersion(
      actor,
      k1.contribution.id,
      2,
      k1Input,
    );
    expect(dupVersion).toMatchObject({ ok: false, error: { code: "duplicate_content" } });

    // Unresolved references: unknown id, nonexistent version.
    for (const related of [
      [{ family: "knowledge", id: "does-not-exist", version: 1 }],
      [{ family: "knowledge", id: k1.contribution.id, version: 9 }],
    ]) {
      expect(await registry.createContribution(actor, execution(related))).toMatchObject({
        ok: false,
        error: { code: "unresolved_reference" },
      });
    }

    // Stale expected-version write (v2 already exists; expecting 1).
    expect(
      await registry.createContributionVersion(actor, k1.contribution.id, 1, knowledge()),
    ).toMatchObject({ ok: false, error: { code: "version_conflict" } });

    expect(await snapshot()).toEqual(before);

    // Inactive actors: revoked agent and suspended operator are rejected for create and version.
    const revokedAgent = await identity.registerAgent(op.id, { displayName: "To revoke" });
    const revokedToken = (await credentials.issueCredential(revokedAgent.id, { label: "r" })).token;
    await identity.revokeAgent(revokedAgent.id);
    expect(await credentials.verifyCredential(revokedToken)).toEqual({
      ok: false,
      reason: "agent_revoked",
    });
    expect(await registry.createContribution(revokedAgent.id, knowledge())).toMatchObject({
      ok: false,
      error: { code: "actor_inactive" },
    });
    expect(
      await registry.createContributionVersion(revokedAgent.id, k1.contribution.id, 2, knowledge()),
    ).toMatchObject({ ok: false, error: { code: "actor_inactive" } });

    await identity.suspendOperator(op.id as OperatorId);
    expect(await credentials.verifyCredential(token)).toEqual({
      ok: false,
      reason: "operator_suspended",
    });
    expect(await registry.createContribution(actor, knowledge())).toMatchObject({
      ok: false,
      error: { code: "actor_inactive" },
    });
    expect(
      await registry.createContributionVersion(actor, k1.contribution.id, 2, knowledge()),
    ).toMatchObject({ ok: false, error: { code: "actor_inactive" } });

    expect(await snapshot()).toEqual(before);

    // Retrieval of stored history still works after the operator is suspended.
    expect(await registry.getContributionVersion(k1.contribution.id, 1)).toMatchObject({
      ok: true,
    });
  });
});
