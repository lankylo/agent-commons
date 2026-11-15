import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import { QualityReviewer, type DecideResult } from "../../src/registry/quality-review";
import { QualityStateStore, type QualityState } from "../../src/registry/quality-state";
import { contentObjectKey } from "../../src/storage/content-objects";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let bucket: R2Bucket;
let registry: ContributionRegistry;
let agent: AgentId;
const store = () => new QualityStateStore(db);
const reviewer = (id = "reviewer-1") => new QualityReviewer(proxy.env, id);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "quality-review-"));
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
  const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  agent = (await identity.registerAgent(op.id, { displayName: "Agent" })).id;
  registry = new ContributionRegistry(proxy.env);
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

async function newVersion(kind: "knowledge" | "execution" = "knowledge") {
  const r = await registry.createContribution(
    agent,
    kind === "knowledge" ? knowledge() : execution(),
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.contribution;
}
const fail = (r: DecideResult) => (r.ok ? "ok" : r.error.code);
const platformState = async (id: string) =>
  db.prepare("SELECT * FROM version_platform_state WHERE contribution_id = ?").bind(id).first();
const decisionCount = async (id: string) =>
  (await db
    .prepare("SELECT count(*) AS c FROM version_quality_decisions WHERE contribution_id = ?")
    .bind(id)
    .first<{ c: number }>())!.c;

describe("inspection", () => {
  it("returns integrity-checked content, pending state and empty history for both families", async () => {
    for (const kind of ["knowledge", "execution"] as const) {
      const c = await newVersion(kind);
      const r = await reviewer().inspect(c.id, 1);
      if (!r.ok) throw new Error("expected ok");
      expect(r.state).toBe("pending");
      expect(r.decisions).toEqual([]);
      expect(r.contribution.family).toBe(kind);
      expect(r.contribution.contentHash).toBe(c.contentHash);
    }
  });
  it("reports unknown and invalid targets, missing and corrupted content", async () => {
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code);
    expect(code(await reviewer().inspect("nope", 1))).toBe("contribution_not_found");
    const c = await newVersion();
    expect(code(await reviewer().inspect(c.id, 2))).toBe("version_not_found");
    expect(code(await reviewer().inspect(c.id, 0))).toBe("invalid_request");
    await bucket.put(contentObjectKey(c.contentHash), new TextEncoder().encode("{}"), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { family: "knowledge", contentType: "api-reference", sha256: c.contentHash },
    });
    expect(code(await reviewer().inspect(c.id, 1))).toBe("content_corrupted");
    await bucket.delete(contentObjectKey(c.contentHash));
    expect(code(await reviewer().inspect(c.id, 1))).toBe("content_missing");
  });
});

describe("transitions", () => {
  it("approves pending to listed_unverified, records history, and never touches platform state", async () => {
    const c = await newVersion();
    const before = await platformState(c.id);
    const r = await reviewer("rev.alpha").decide(c.id, 1, "listed_unverified", "  looks sound  ");
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.decision).toMatchObject({
      fromState: "pending",
      toState: "listed_unverified",
      reviewerId: "rev.alpha",
      reason: "looks sound",
    });
    expect((await store().get(c.id, 1))?.state).toBe("listed_unverified");
    expect(await platformState(c.id)).toEqual(before);
    expect(before).toMatchObject({ last_verified_at: null, reliability_score: null });
    const i = await reviewer().inspect(c.id, 1);
    expect(i.ok && i.decisions).toEqual([r.decision]);
  });
  it("rejects pending", async () => {
    const c = await newVersion("execution");
    expect((await reviewer().decide(c.id, 1, "rejected", "unsafe")).ok).toBe(true);
    expect((await store().get(c.id, 1))?.state).toBe("rejected");
  });
  it("withdraws listed_unverified, even if content is later unavailable; history stays ordered", async () => {
    const c = await newVersion();
    await reviewer("a").decide(c.id, 1, "listed_unverified", "ok");
    await bucket.delete(contentObjectKey(c.contentHash));
    const w = await reviewer("b").decide(c.id, 1, "withdrawn", "retired");
    expect(w.ok).toBe(true);
    const h = await reviewer().history(c.id, 1);
    expect(h.map((d) => [d.fromState, d.toState, d.reviewerId])).toEqual([
      ["pending", "listed_unverified", "a"],
      ["listed_unverified", "withdrawn", "b"],
    ]);
    expect(h[0]!.decidedAt <= h[1]!.decidedAt).toBe(true);
  });
  it("rejects every other transition and records nothing", async () => {
    const all: QualityState[] = ["pending", "listed_unverified", "rejected", "withdrawn"];
    const allowed = new Set([
      "pending>listed_unverified",
      "pending>rejected",
      "listed_unverified>withdrawn",
    ]);
    for (const from of all) {
      for (const to of all) {
        if (allowed.has(`${from}>${to}`)) continue;
        const c = await newVersion();
        if (from === "listed_unverified" || from === "withdrawn")
          await reviewer().decide(c.id, 1, "listed_unverified", "x");
        if (from === "withdrawn") await reviewer().decide(c.id, 1, "withdrawn", "x");
        if (from === "rejected") await reviewer().decide(c.id, 1, "rejected", "x");
        const n = await decisionCount(c.id);
        expect(fail(await reviewer().decide(c.id, 1, to, "x"))).toBe("invalid_transition");
        expect(await decisionCount(c.id)).toBe(n);
        expect((await store().get(c.id, 1))?.state).toBe(from);
      }
    }
  });
  it("rejects duplicate decisions and bad input", async () => {
    const c = await newVersion();
    expect((await reviewer().decide(c.id, 1, "rejected", "no")).ok).toBe(true);
    expect(fail(await reviewer().decide(c.id, 1, "rejected", "again"))).toBe("invalid_transition");
    expect(fail(await reviewer().decide(c.id, 1, "listed_unverified", "flip"))).toBe(
      "invalid_transition",
    );
    expect(await decisionCount(c.id)).toBe(1);
    const d = await newVersion();
    expect(fail(await reviewer().decide(d.id, 1, "rejected", ""))).toBe("invalid_reason");
    expect(fail(await reviewer().decide(d.id, 1, "rejected", "x".repeat(501)))).toBe(
      "invalid_reason",
    );
    expect(fail(await reviewer().decide(d.id, 1, "rejected", "a\nb"))).toBe("invalid_reason");
    expect(fail(await reviewer("").decide(d.id, 1, "rejected", "x"))).toBe("invalid_reviewer");
    expect(fail(await reviewer("bad id!").decide(d.id, 1, "rejected", "x"))).toBe(
      "invalid_reviewer",
    );
    expect(fail(await reviewer().decide(d.id, 1, "bogus" as never, "x"))).toBe("invalid_request");
    expect(fail(await reviewer().decide(d.id, 9, "rejected", "x"))).toBe("version_not_found");
    expect(await decisionCount(d.id)).toBe(0);
    expect((await store().get(d.id, 1))?.state).toBe("pending");
  });
  it("cannot approve missing or corrupted content", async () => {
    const m = await newVersion();
    await bucket.delete(contentObjectKey(m.contentHash));
    expect(fail(await reviewer().decide(m.id, 1, "listed_unverified", "x"))).toBe(
      "content_unavailable",
    );
    const k = await newVersion("execution");
    await bucket.put(contentObjectKey(k.contentHash), new TextEncoder().encode("{}"), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { family: "execution", contentType: "api-recipe", sha256: k.contentHash },
    });
    expect(fail(await reviewer().decide(k.id, 1, "listed_unverified", "x"))).toBe(
      "content_unavailable",
    );
    for (const c of [m, k]) {
      expect((await store().get(c.id, 1))?.state).toBe("pending");
      expect(await decisionCount(c.id)).toBe(0);
    }
  });
});

describe("racing decisions", () => {
  it("lets exactly one of concurrent conflicting decisions win", async () => {
    const c = await newVersion();
    const results = await Promise.all([
      reviewer("r1").decide(c.id, 1, "listed_unverified", "approve"),
      reviewer("r2").decide(c.id, 1, "rejected", "reject"),
      reviewer("r3").decide(c.id, 1, "listed_unverified", "approve too"),
    ]);
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const losers = results.filter((r) => !r.ok).map((r) => fail(r));
    expect(losers.every((l) => l === "state_conflict" || l === "invalid_transition")).toBe(true);
    const h = await reviewer().history(c.id, 1);
    expect(h).toHaveLength(1);
    expect((await store().get(c.id, 1))?.state).toBe(h[0]!.toState);
  });
  it("loses a stale decision without recording a false approval", async () => {
    const c = await newVersion();
    await reviewer().decide(c.id, 1, "rejected", "first");
    // Bypass the pre-read: insert directly as a stale approver would after reading 'pending'.
    await expect(
      db.batch([
        db
          .prepare(
            "INSERT INTO version_quality_decisions (contribution_id, version, from_state, to_state, reviewer_id, reason, decided_at) VALUES (?, 1, 'pending', 'listed_unverified', 'r', 'stale', '2026-11-15T00:00:00Z')",
          )
          .bind(c.id),
        db
          .prepare(
            "UPDATE version_quality_states SET state = 'listed_unverified', updated_at = '2026-11-15T00:00:00Z' WHERE contribution_id = ?",
          )
          .bind(c.id),
      ]),
    ).rejects.toThrow();
    expect((await store().get(c.id, 1))?.state).toBe("rejected");
    expect(await decisionCount(c.id)).toBe(1);
  });
});

describe("database guarantees", () => {
  it("makes history append-only and forbids state changes without a matching decision", async () => {
    const c = await newVersion();
    await reviewer().decide(c.id, 1, "listed_unverified", "ok");
    await expect(
      db
        .prepare("UPDATE version_quality_decisions SET reason = 'x' WHERE contribution_id = ?")
        .bind(c.id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db
        .prepare("DELETE FROM version_quality_decisions WHERE contribution_id = ?")
        .bind(c.id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db
        .prepare(
          "UPDATE version_quality_states SET state = 'rejected', updated_at = '2026-11-15T00:00:00Z' WHERE contribution_id = ?",
        )
        .bind(c.id)
        .run(),
    ).rejects.toThrow(/matching decision/);
    const d = await newVersion();
    await expect(
      db
        .prepare(
          "UPDATE version_quality_states SET state = 'listed_unverified', updated_at = '2026-11-15T00:00:00Z' WHERE contribution_id = ?",
        )
        .bind(d.id)
        .run(),
    ).rejects.toThrow(/matching decision/);
    await expect(
      db
        .prepare(
          "INSERT INTO version_quality_decisions (contribution_id, version, from_state, to_state, reviewer_id, reason, decided_at) VALUES (?, 1, 'pending', 'withdrawn', 'r', 'x', '2026-11-15T00:00:00Z')",
        )
        .bind(d.id)
        .run(),
    ).rejects.toThrow();
  });
  it("is not reachable from the Worker or MCP code", () => {
    for (const f of ["src/index.ts", "src/mcp/server.ts", "src/mcp/stdio.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/quality-review|QualityReviewer/);
    }
  });
});
