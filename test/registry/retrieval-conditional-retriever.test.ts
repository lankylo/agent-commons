import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId, OperatorId } from "../../src/identity/types";
import {
  ContributionRegistry,
  type CreateContributionResult,
  type CreateVersionResult,
  type RegistryEnv,
} from "../../src/registry/creation";
import {
  ContributionRetriever,
  type ConditionalRetrieveResult,
  type RetrieveResult,
} from "../../src/registry/retrieval";
import {
  RETRIEVAL_NOT_MODIFIED_KEYS,
  RETRIEVAL_NOT_MODIFIED_VERSION,
  type RetrievalValidator,
} from "../../src/registry/retrieval-conditional";
import {
  buildRetrievalResponse,
  RETRIEVAL_RESPONSE_VERSION,
} from "../../src/registry/retrieval-response";
import { contentObjectKey } from "../../src/storage/content-objects";

// Local D1 + R2 emulation (Miniflare), real migrations, throwaway persistence.
let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let bucket: R2Bucket;
let registry: ContributionRegistry;
let retriever: ContributionRetriever;
let agent: AgentId;
let operator: OperatorId;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-conditional-"));
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
  const identity = new IdentityRepository(db);
  registry = new ContributionRegistry(proxy.env, {
    now: () => new Date("2026-11-13T12:00:00.000Z"),
  });
  retriever = new ContributionRetriever(proxy.env);
  const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  operator = op.id;
  agent = (await identity.registerAgent(op.id, { displayName: "Agent" })).id;
}, 120_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const EXPLANATION = "UNIQUE-UNTRUSTED-EXPLANATION";
const TITLE = "UNIQUE-CONTENT-TITLE";
let n = 0;
const knowledge = (): Record<string, unknown> => ({
  family: "knowledge",
  title: `${TITLE} knowledge ${++n}`,
  purpose: "Record documented rate limits",
  contentType: "api-reference",
  evidence: [{ kind: "documentation", uri: `https://httpbin.org/docs/limits/${n}` }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  facts: [
    { subject: "example-api", predicate: "rateLimitPerMinute", value: 60 + n, unit: "req/min" },
  ],
  summary: "Documented limits for the Example API.",
  explanation: EXPLANATION,
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

const execution = (related?: unknown): Record<string, unknown> => ({
  family: "execution",
  title: `${TITLE} execution ${++n}`,
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
const okPlain = (r: RetrieveResult) => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.contribution;
};
const okCond = (r: ConditionalRetrieveResult) => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.response;
};
const v = (c: { id: string; version: number; contentHash: string }): RetrievalValidator => ({
  contributionId: c.id,
  version: c.version,
  contentHash: c.contentHash,
});

/** Knowledge v1 plus an Execution v1 that references it (so `related` is non-empty). */
async function pair() {
  const k = must(await registry.createContribution(agent, knowledge()));
  const x = must(
    await registry.createContribution(
      agent,
      execution([{ family: "knowledge", id: k.id, version: 1 }]),
    ),
  );
  return { k, x };
}

/** The complete response the unconditional path would produce. */
async function fullResponse(id: string, version: number) {
  return buildRetrievalResponse(okPlain(await retriever.getContributionVersion(id, version)));
}

function expectNotModifiedOnly(
  response: unknown,
  expected: { id: string; version: number; contentHash: string },
  forbidden: readonly string[],
) {
  expect(response).toEqual({
    schemaVersion: RETRIEVAL_NOT_MODIFIED_VERSION,
    contributionId: expected.id,
    version: expected.version,
    contentHash: expected.contentHash,
  });
  expect(Object.keys(response as object).sort()).toEqual([...RETRIEVAL_NOT_MODIFIED_KEYS].sort());
  expect(Object.isFrozen(response)).toBe(true);
  const json = JSON.stringify(response);
  for (const s of forbidden) expect(json).not.toContain(s);
  for (const key of [
    "content",
    "untrustedExplanation",
    "author",
    "contributor",
    "platformState",
    "related",
    "family",
    "payloadBytes",
  ]) {
    expect(json).not.toContain(`"${key}"`);
  }
}

describe("exact validator match", () => {
  it("returns only retrieval-not-modified/v1 for Knowledge", async () => {
    const { k, x } = await pair();
    // Knowledge whose own related list points at the Execution.
    const k2 = must(
      await registry.createContribution(agent, {
        ...knowledge(),
        related: [{ family: "execution", id: x.id, version: 1 }],
      }),
    );
    const r = okCond(await retriever.getConditionalContributionVersion(k2.id, 1, v(k2)));
    expectNotModifiedOnly(r, k2, [EXPLANATION, TITLE, agent, operator, x.id, k.id]);
  });

  it("returns only retrieval-not-modified/v1 for Execution", async () => {
    const { k, x } = await pair();
    const r = okCond(await retriever.getConditionalContributionVersion(x.id, 1, v(x)));
    expectNotModifiedOnly(r, x, [TITLE, agent, operator, k.id, "api.acme.com"]);
  });

  it("leaves getContributionVersion unchanged", async () => {
    const { k } = await pair();
    const before = okPlain(await retriever.getContributionVersion(k.id, 1));
    await retriever.getConditionalContributionVersion(k.id, 1, v(k));
    const after = okPlain(await retriever.getContributionVersion(k.id, 1));
    expect(after).toEqual(before);
    expect(after.family === "knowledge" && after.content.explanation).toBe(EXPLANATION);
  });
});

describe("absent or mismatched validator returns the complete response", () => {
  it("absent validator (undefined or null) for both families", async () => {
    const { k, x } = await pair();
    for (const c of [k, x]) {
      const full = await fullResponse(c.id, 1);
      expect(full.schemaVersion).toBe(RETRIEVAL_RESPONSE_VERSION);
      expect(okCond(await retriever.getConditionalContributionVersion(c.id, 1))).toEqual(full);
      expect(okCond(await retriever.getConditionalContributionVersion(c.id, 1, null))).toEqual(
        full,
      );
    }
    const kr = okCond(await retriever.getConditionalContributionVersion(k.id, 1));
    expect(kr.schemaVersion === RETRIEVAL_RESPONSE_VERSION && kr.family).toBe("knowledge");
    if (kr.schemaVersion === RETRIEVAL_RESPONSE_VERSION && kr.family === "knowledge") {
      expect(kr.untrustedExplanation).toEqual({ label: "untrusted", text: EXPLANATION });
    }
    const xr = okCond(await retriever.getConditionalContributionVersion(x.id, 1));
    expect(xr.schemaVersion === RETRIEVAL_RESPONSE_VERSION && xr.related).toEqual([
      { family: "knowledge", id: k.id, version: 1 },
    ]);
  });

  it("every single-field mismatch for both families", async () => {
    const { k, x } = await pair();
    for (const c of [k, x]) {
      const full = await fullResponse(c.id, 1);
      const exact = v(c);
      const mismatches: RetrievalValidator[] = [
        { ...exact, contributionId: c === k ? x.id : k.id },
        { ...exact, contributionId: c.id.toUpperCase() },
        { ...exact, contributionId: ` ${c.id}` },
        { ...exact, version: 2 },
        { ...exact, version: "1" as unknown as number },
        { ...exact, contentHash: (c === k ? x : k).contentHash },
        { ...exact, contentHash: c.contentHash.toUpperCase() },
        { ...exact, contentHash: `sha256:${c.contentHash}` },
      ];
      for (const m of mismatches) {
        expect(okCond(await retriever.getConditionalContributionVersion(c.id, 1, m))).toEqual(full);
      }
    }
  });

  it("a validator for another exact version of the same contribution does not match", async () => {
    const v1 = must(await registry.createContribution(agent, knowledge()));
    const v2 = mustV(await registry.createContributionVersion(agent, v1.id, 1, knowledge()));
    expect(okCond(await retriever.getConditionalContributionVersion(v1.id, 2, v(v1)))).toEqual(
      await fullResponse(v1.id, 2),
    );
    expect(okCond(await retriever.getConditionalContributionVersion(v1.id, 1, v(v2)))).toEqual(
      await fullResponse(v1.id, 1),
    );
    expectNotModifiedOnly(
      okCond(await retriever.getConditionalContributionVersion(v1.id, 2, v(v2))),
      v2,
      [EXPLANATION, TITLE],
    );
  });
});

describe("structured errors are preserved", () => {
  const codeOf = (r: ConditionalRetrieveResult | RetrieveResult) => (r.ok ? "ok" : r.error.code);

  it("returns the same errors as getContributionVersion for missing identifiers", async () => {
    const c = must(await registry.createContribution(agent, knowledge()));
    const cases: [string, number, string][] = [
      ["no-such-id", 1, "contribution_not_found"],
      [c.id, 2, "version_not_found"],
      [c.id, 0, "invalid_request"],
      ["", 1, "invalid_request"],
    ];
    for (const [id, ver, code] of cases) {
      const plain = await retriever.getContributionVersion(id, ver);
      const cond = await retriever.getConditionalContributionVersion(id, ver, {
        contributionId: id,
        version: ver,
        contentHash: c.contentHash,
      });
      expect(codeOf(cond)).toBe(code);
      expect(cond).toEqual(plain);
    }
  });

  /** A matching validator must never hide an integrity failure. */
  async function expectFailureNotConcealed(
    c: { id: string; version: number; contentHash: string },
    code: string,
  ) {
    const plain = await retriever.getContributionVersion(c.id, 1);
    expect(codeOf(plain)).toBe(code);
    for (const validator of [v(c), undefined]) {
      const cond = await retriever.getConditionalContributionVersion(c.id, 1, validator);
      expect(cond).toEqual(plain);
      if (!cond.ok) expect(Object.keys(cond.error).sort()).toEqual(["code", "message"]);
    }
  }

  async function tamper(hash: string, bytes: Uint8Array, family: string, contentType: string) {
    await bucket.put(contentObjectKey(hash), bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { family, contentType, sha256: hash },
    });
  }
  const storedBytes = async (hash: string) =>
    new Uint8Array(await (await bucket.get(contentObjectKey(hash)))!.arrayBuffer());

  it("missing R2 content (both families)", async () => {
    const { k, x } = await pair();
    await bucket.delete(contentObjectKey(k.contentHash));
    await bucket.delete(contentObjectKey(x.contentHash));
    await expectFailureNotConcealed(k, "content_missing");
    await expectFailureNotConcealed(x, "content_missing");
  });

  it("corrupted R2 bytes (both families)", async () => {
    const { k, x } = await pair();
    const bad = new TextEncoder().encode('{"tampered":true}');
    await tamper(k.contentHash, bad, "knowledge", "api-reference");
    await tamper(x.contentHash, bad, "execution", "api-recipe");
    await expectFailureNotConcealed(k, "content_corrupted");
    await expectFailureNotConcealed(x, "content_corrupted");
  });

  it("inconsistent R2 metadata (both families)", async () => {
    const { k, x } = await pair();
    await tamper(k.contentHash, await storedBytes(k.contentHash), "execution", "api-reference");
    await tamper(x.contentHash, await storedBytes(x.contentHash), "execution", "other-type");
    await expectFailureNotConcealed(k, "metadata_inconsistent");
    await expectFailureNotConcealed(x, "metadata_inconsistent");
  });

  it("D1 rows that disagree with the verified content (both families)", async () => {
    const { k, x } = await pair();
    await db.prepare("DROP TRIGGER IF EXISTS contribution_versions_no_update").run();
    await db
      .prepare("UPDATE contribution_versions SET title = 'changed' WHERE contribution_id IN (?, ?)")
      .bind(k.id, x.id)
      .run();
    await expectFailureNotConcealed(k, "metadata_inconsistent");
    await expectFailureNotConcealed(x, "metadata_inconsistent");
  });
});
