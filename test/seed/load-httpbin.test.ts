import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { canonicalJson, sha256Hex } from "../../src/registry/content-hash";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import {
  HTTPBIN_EXECUTION_SEED,
  HTTPBIN_KNOWLEDGE_SEED,
  executionWithKnowledgeRef,
} from "../../src/seed/httpbin";
import { seedHttpbinContributions } from "../../src/seed/load-httpbin";

// Local Miniflare D1 + R2 with the real migrations; no network, no remote resources.
let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let bucket: R2Bucket;
let identity: IdentityRepository;
let registry: ContributionRegistry;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seed-httpbin-"));
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
  registry = new ContributionRegistry(proxy.env, {
    now: () => new Date("2026-11-11T12:00:00.000Z"),
  });
}, 120_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  "operators",
  "agents",
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
const state = async () => {
  const counts = Object.fromEntries(
    await Promise.all(
      TABLES.map(async (t) => [
        t,
        (await db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>())!.c,
      ]),
    ),
  );
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { counts, keys: keys.sort() };
};

let n = 0;
async function contributor(opts: { allowListed: boolean; revoke?: boolean }): Promise<AgentId> {
  const op = await identity.createOperator({
    kind: "organization",
    displayName: `Seed Op ${++n}`,
  });
  const agent = await identity.registerAgent(op.id, { displayName: `Seed Agent ${n}` });
  if (opts.allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(op.id)
      .run();
  }
  if (opts.revoke) {
    await db.prepare("UPDATE agents SET status = 'revoked' WHERE id = ?").bind(agent.id).run();
  }
  return agent.id;
}

const ids = async () =>
  (
    await db
      .prepare("SELECT id, family FROM contributions ORDER BY family")
      .all<{ id: string; family: string }>()
  ).results;

describe("seedHttpbinContributions (local D1/R2)", () => {
  it("rejects inactive and non-allow-listed contributors without touching storage", async () => {
    const notListed = await contributor({ allowListed: false });
    const revoked = await contributor({ allowListed: true, revoke: true });
    const before = await state();
    expect(await seedHttpbinContributions(registry, notListed)).toMatchObject({
      ok: false,
      step: "knowledge",
      error: { code: "operator_not_allow_listed" },
    });
    expect(await seedHttpbinContributions(registry, revoked)).toMatchObject({
      ok: false,
      step: "knowledge",
      error: { code: "actor_inactive" },
    });
    expect(await state()).toEqual(before);
  });

  it("seeds fresh, retrieves both, and is idempotent; resumes from Knowledge-only", async () => {
    const agentId = await contributor({ allowListed: true });
    const base = await state();

    // Partial state first: Knowledge exists, Execution does not.
    const k = await registry.createContribution(agentId, HTTPBIN_KNOWLEDGE_SEED);
    if (!k.ok) throw new Error(JSON.stringify(k.error));
    const partial = await state();
    expect(partial.counts.contributions).toBe(base.counts.contributions + 1);

    const resumed = await seedHttpbinContributions(registry, agentId);
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
    expect(resumed.knowledge).toEqual({ id: k.contribution.id, version: 1, created: false });
    expect(resumed.execution).toMatchObject({ version: 1, created: true });
    const full = await state();
    expect(full.counts.contributions).toBe(base.counts.contributions + 2);
    expect(full.counts.contribution_versions).toBe(base.counts.contribution_versions + 2);
    expect(full.counts.knowledge_versions).toBe(base.counts.knowledge_versions + 1);
    expect(full.counts.execution_versions).toBe(base.counts.execution_versions + 1);
    expect(full.keys.length).toBe(base.keys.length + 2);
    // Operators/agents untouched by seeding.
    expect(full.counts.operators).toBe(partial.counts.operators);
    expect(full.counts.agents).toBe(partial.counts.agents);

    // Both retrievable and validated by existing retrieval; exact reference; labels.
    const kGot = await registry.getContributionVersion(resumed.knowledge.id, 1);
    const eGot = await registry.getContributionVersion(resumed.execution.id, 1);
    if (!kGot.ok || !eGot.ok) throw new Error("retrieval failed");
    expect(kGot.contribution).toMatchObject({
      family: "knowledge",
      version: 1,
      contentHash: await sha256Hex(canonicalJson(HTTPBIN_KNOWLEDGE_SEED)),
      contributor: { agentId },
      content: { licensing: { license: "ISC" } },
    });
    const eInput = executionWithKnowledgeRef({
      family: "knowledge",
      id: resumed.knowledge.id as never,
      version: 1,
    });
    expect(eGot.contribution).toMatchObject({
      family: "execution",
      version: 1,
      contentHash: await sha256Hex(canonicalJson(eInput)),
      contributor: { agentId },
      content: {
        related: [{ family: "knowledge", id: resumed.knowledge.id, version: 1 }],
        licensing: { license: "ISC" },
        verification: { method: "owner-tested" },
      },
    });
    expect(HTTPBIN_EXECUTION_SEED.verification.method).toBe("owner-tested");
    expect(eGot.contribution.platformState.reliabilityScore).toBeNull();

    // Second run: same IDs/versions, nothing new in D1 or R2.
    const again = await seedHttpbinContributions(registry, agentId);
    expect(again).toEqual({
      ok: true,
      knowledge: { id: resumed.knowledge.id, version: 1, created: false },
      execution: { id: resumed.execution.id, version: 1, created: false },
    });
    expect(await state()).toEqual(full);
    expect((await ids()).length).toBe(2 + base.counts.contributions);
  });
});

describe("seedHttpbinContributions on a fresh registry", () => {
  it("creates exactly one Knowledge and one Execution contribution at version 1", async () => {
    // Separate throwaway instance so counts are absolute.
    const d2 = mkdtempSync(join(tmpdir(), "seed-httpbin-fresh-"));
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
        d2,
      ],
      { stdio: "pipe" },
    );
    const p2 = await getPlatformProxy<RegistryEnv>({
      configPath: "wrangler.registry-local.jsonc",
      persist: { path: join(d2, "v3") },
    });
    try {
      const idr = new IdentityRepository(p2.env.DB);
      const op = await idr.createOperator({ kind: "organization", displayName: "Fresh Op" });
      const agent = await idr.registerAgent(op.id, { displayName: "Fresh Agent" });
      await p2.env.DB.prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
        .bind(op.id)
        .run();
      const reg = new ContributionRegistry(p2.env);
      const res = await seedHttpbinContributions(reg, agent.id);
      expect(res).toMatchObject({
        ok: true,
        knowledge: { version: 1, created: true },
        execution: { version: 1, created: true },
      });
      const rows = await p2.env.DB.prepare(
        "SELECT family, COUNT(*) AS c, MAX(version) AS v FROM contribution_versions GROUP BY family ORDER BY family",
      ).all();
      expect(rows.results).toEqual([
        { family: "execution", c: 1, v: 1 },
        { family: "knowledge", c: 1, v: 1 },
      ]);
      expect(
        (await p2.env.DB.prepare("SELECT COUNT(*) AS c FROM contributions").first<{ c: number }>())!
          .c,
      ).toBe(2);
      expect((await p2.env.CONTENT_BUCKET.list()).objects).toHaveLength(2);
    } finally {
      await p2.dispose();
      rmSync(d2, { recursive: true, force: true });
    }
  }, 120_000);
});
