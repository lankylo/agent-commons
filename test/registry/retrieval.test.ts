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
} from "../../src/registry/creation";
import type { RetrieveResult } from "../../src/registry/retrieval";
import { contentObjectKey } from "../../src/storage/content-objects";

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
  dir = mkdtempSync(join(tmpdir(), "registry-retrieval-"));
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
  targetDomains: ["api.example.com"],
  compatibility: { requiredCapabilities: ["http-client"] },
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

const ok = (r: RetrieveResult) => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.contribution;
};
const codeOf = (r: RetrieveResult) => (r.ok ? "ok" : r.error.code);
const enc = (s: string) => new TextEncoder().encode(s);

/** Overwrite the R2 object for a hash (simulates storage tampering). */
async function tamper(
  hash: string,
  bytes: Uint8Array,
  meta: { family: string; contentType: string; sha256: string },
) {
  await bucket.put(contentObjectKey(hash), bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: meta,
  });
}

describe("retrieval of Knowledge and Execution", () => {
  it("returns the validated input plus platform metadata for Knowledge", async () => {
    clock = T1;
    const input = knowledge();
    const c = must(await registry.createContribution(agent, input));
    const got = ok(await registry.getContributionVersion(c.id, 1));
    expect(got).toMatchObject({
      id: c.id,
      version: 1,
      previousVersion: null,
      family: "knowledge",
      contentHash: c.contentHash,
      payloadBytes: c.payloadBytes,
      author: { agentId: agent, operatorId: operator },
      contributor: { agentId: agent, operatorId: operator },
      createdAt: T1.toISOString(),
      contributionCreatedAt: T1.toISOString(),
      platformState: {
        lastVerifiedAt: null,
        reliabilityScore: null,
        consumerCount: 0,
        updatedAt: T1.toISOString(),
      },
    });
    expect(canonicalJson(got.content)).toBe(canonicalJson(input));
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.content)).toBe(true);
  });

  it("returns an Execution contribution with its cross-family reference", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const input = execution([{ family: "knowledge", id: k.id, version: 1 }]);
    const x = must(await registry.createContribution(agent, input));
    const got = ok(await registry.getContributionVersion(x.id, 1));
    expect(got.family).toBe("execution");
    expect(canonicalJson(got.content)).toBe(canonicalJson(input));
    expect(got.content.related).toEqual([{ family: "knowledge", id: k.id, version: 1 }]);
  });
});

describe("exact versions", () => {
  it("retrieves versions 1 and 2 exactly; earlier version stays immutable", async () => {
    clock = T1;
    const in1 = knowledge();
    const v1 = must(await registry.createContribution(agent, in1));
    const before = ok(await registry.getContributionVersion(v1.id, 1));
    clock = T2;
    const in2 = knowledge();
    mustV(await registry.createContributionVersion(agent2, v1.id, 1, in2));

    const a = ok(await registry.getContributionVersion(v1.id, 1));
    const b = ok(await registry.getContributionVersion(v1.id, 2));
    expect(canonicalJson(a.content)).toBe(canonicalJson(in1));
    expect(canonicalJson(b.content)).toBe(canonicalJson(in2));
    expect(a).toEqual(before);
    expect(b).toMatchObject({
      version: 2,
      previousVersion: 1,
      author: { agentId: agent2, operatorId: operator },
      contributor: { agentId: agent, operatorId: operator },
      createdAt: T2.toISOString(),
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe("missing identifiers", () => {
  it("distinguishes missing contribution, missing version and invalid requests", async () => {
    const c = must(await registry.createContribution(agent, knowledge()));
    expect(codeOf(await registry.getContributionVersion("no-such-id", 1))).toBe(
      "contribution_not_found",
    );
    expect(codeOf(await registry.getContributionVersion(c.id, 2))).toBe("version_not_found");
    expect(codeOf(await registry.getContributionVersion(c.id, 0))).toBe("invalid_request");
    expect(codeOf(await registry.getContributionVersion(c.id, 1.5))).toBe("invalid_request");
    expect(codeOf(await registry.getContributionVersion("", 1))).toBe("invalid_request");
  });
});

describe("integrity failures", () => {
  it("reports missing R2 content", async () => {
    const c = must(await registry.createContribution(agent, knowledge()));
    await bucket.delete(contentObjectKey(c.contentHash));
    expect(codeOf(await registry.getContributionVersion(c.id, 1))).toBe("content_missing");
  });

  it("reports corrupted bytes", async () => {
    const c = must(await registry.createContribution(agent, execution()));
    await tamper(c.contentHash, enc('{"tampered":true}'), {
      family: "execution",
      contentType: "api-recipe",
      sha256: c.contentHash,
    });
    expect(codeOf(await registry.getContributionVersion(c.id, 1))).toBe("content_corrupted");
  });

  it("reports family and content-type metadata mismatches", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    const bytes = new Uint8Array(
      await (await bucket.get(contentObjectKey(k.contentHash)))!.arrayBuffer(),
    );
    await tamper(k.contentHash, bytes, {
      family: "execution",
      contentType: "api-reference",
      sha256: k.contentHash,
    });
    expect(codeOf(await registry.getContributionVersion(k.id, 1))).toBe("metadata_inconsistent");

    await tamper(k.contentHash, bytes, {
      family: "knowledge",
      contentType: "other-type",
      sha256: k.contentHash,
    });
    expect(codeOf(await registry.getContributionVersion(k.id, 1))).toBe("metadata_inconsistent");

    await tamper(k.contentHash, bytes, {
      family: "knowledge",
      contentType: "api-reference",
      sha256: k.contentHash,
    });
    expect(ok(await registry.getContributionVersion(k.id, 1)).id).toBe(k.id);
  });

  it("reports a D1 row that disagrees with the verified content", async () => {
    const k = must(await registry.createContribution(agent, knowledge()));
    await db.prepare("DROP TRIGGER contribution_versions_no_update").run();
    await db
      .prepare("UPDATE contribution_versions SET title = 'changed' WHERE contribution_id = ?")
      .bind(k.id)
      .run();
    expect(codeOf(await registry.getContributionVersion(k.id, 1))).toBe("metadata_inconsistent");
  });

  /** Point D1 at crafted bytes whose hash is genuine, so only later checks can catch them. */
  async function craft(family: "knowledge" | "execution", text: string) {
    const c = must(
      await registry.createContribution(agent, family === "knowledge" ? knowledge() : execution()),
    );
    const hash = await sha256Hex(text);
    await db.prepare("DROP TRIGGER IF EXISTS contribution_versions_no_update").run();
    await db
      .prepare(
        "UPDATE contribution_versions SET content_hash = ?, payload_bytes = ? WHERE contribution_id = ?",
      )
      .bind(hash, enc(text).byteLength, c.id)
      .run();
    await tamper(hash, enc(text), {
      family,
      contentType: family === "knowledge" ? "api-reference" : "api-recipe",
      sha256: hash,
    });
    return c.id;
  }

  it("reports hash-valid content that is not JSON, not canonical or not valid", async () => {
    expect(
      codeOf(await registry.getContributionVersion(await craft("knowledge", "not json"), 1)),
    ).toBe("content_corrupted");
    const pretty = JSON.stringify(knowledge(), null, 2);
    expect(codeOf(await registry.getContributionVersion(await craft("knowledge", pretty), 1))).toBe(
      "content_corrupted",
    );
    const invalid = canonicalJson({ ...knowledge(), reviewIntervalDays: 99999 });
    expect(
      codeOf(await registry.getContributionVersion(await craft("knowledge", invalid), 1)),
    ).toBe("content_corrupted");
    const badExec = canonicalJson({ ...execution(), steps: [] });
    expect(
      codeOf(await registry.getContributionVersion(await craft("execution", badExec), 1)),
    ).toBe("content_corrupted");
  });

  it("errors expose only a code and generic message", async () => {
    const c = must(await registry.createContribution(agent, knowledge()));
    await bucket.delete(contentObjectKey(c.contentHash));
    const r = await registry.getContributionVersion(c.id, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.error).sort()).toEqual(["code", "message"]);
      expect(r.error.message).not.toContain(c.contentHash);
      expect(r.error.message).not.toContain(c.id);
    }
  });
});
