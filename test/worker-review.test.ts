import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../src/registry/creation";
import { NeedsIntake, type NeedsReport } from "../src/registry/needs";
import { recordUsage } from "../src/registry/usage";
import { contentObjectKey } from "../src/storage/content-objects";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import { runRemoteReview } from "../src/review/client";
import worker from "../src/index";

// Test-only placeholder, not a real credential.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const REVIEWER = "pilot-reviewer";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let author: AgentId;
let agentToken = "";
let n = 0;
const clock = new Date("2026-11-15T12:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-review-"));
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
  const identity = new IdentityRepository(db);
  const op = await identity.createOperator({ kind: "organization", displayName: "Review Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const a = await identity.registerAgent(op.id, { displayName: "Author" });
  author = a.id;
  agentToken = (
    await new CredentialService(db, { now: () => clock }).issueCredential(a.id, { label: "a" })
  ).token;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

type Env = Record<string, unknown>;
const baseEnv = (): Env => ({
  DB: db,
  CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
  NOW: () => clock,
  REVIEW_INTERFACE: "on",
  REVIEWER_ID: REVIEWER,
  REVIEWER_TOKEN: TOKEN,
  RATE_LIMIT_AGENT_LIMIT: 10000,
  RATE_LIMIT_OPERATOR_LIMIT: 10000,
  RATE_LIMIT_WINDOW_SECONDS: 60,
});

/** Storage stand-ins that record any access, to prove authentication happens first. */
function untouchable() {
  const touched: string[] = [];
  const trap = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          touched.push(`${name}.${String(prop)}`);
          throw new Error("storage must not be touched");
        },
      },
    );
  return { touched, env: { DB: trap("DB"), CONTENT_BUCKET: trap("R2") } };
}

async function review(
  op: string,
  body: unknown = {},
  options: { env?: Env; auth?: string | null; method?: string } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const auth = options.auth === undefined ? `Bearer ${TOKEN}` : options.auth;
  if (auth !== null) headers.set("Authorization", auth);
  const method = options.method ?? "POST";
  const res = await worker.fetch(
    new Request(`https://example.com/v1/review/${op}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    (options.env ?? baseEnv()) as never,
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    cache: res.headers.get("Cache-Control"),
    body: JSON.parse(text) as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

type Family = "knowledge" | "execution";
async function create(family: Family = "knowledge") {
  const seed = family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED;
  const r = await registry.createContribution(author, {
    ...seed,
    title: `review ${family} ${++n}`,
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.contribution;
}
const state = async (id: string, v = 1) =>
  (
    await db
      .prepare("SELECT state FROM version_quality_states WHERE contribution_id=? AND version=?")
      .bind(id, v)
      .first<{ state: string }>()
  )?.state;
const decisionCount = async (id: string) =>
  (await db
    .prepare("SELECT count(*) AS c FROM version_quality_decisions WHERE contribution_id = ?")
    .bind(id)
    .first<{ c: number }>())!.c;
const decide = (id: string, decision: string, reason: unknown = "reviewed", version = 1) =>
  review("decide", { contributionId: id, version, decision, reason });

const OPS = ["queue", "inspect", "decide", "capacity", "needs", "usage"];

describe("remote review: enablement and configuration", () => {
  it("is disabled by default and when off: 404 for every op, no storage access", async () => {
    for (const value of [undefined, "", "off"]) {
      const { touched, env } = untouchable();
      for (const op of OPS) {
        const r = await review(op, {}, { env: { ...baseEnv(), ...env, REVIEW_INTERFACE: value } });
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe("not_found");
      }
      expect(touched).toEqual([]);
    }
  });

  it("fails closed with 503 for invalid configuration, before storage or auth", async () => {
    const bad: Env[] = [
      { REVIEW_INTERFACE: "true" },
      { REVIEW_INTERFACE: "ON" },
      { REVIEWER_TOKEN: undefined },
      { REVIEWER_TOKEN: "" },
      { REVIEWER_TOKEN: "short-token-0123456789" },
      { REVIEWER_TOKEN: "a".repeat(64) },
      { REVIEWER_TOKEN: "abababababababababababababababababababababababab" },
      { REVIEWER_TOKEN: `${TOKEN}!` },
      { REVIEWER_TOKEN: `${TOKEN} space` },
      { REVIEWER_ID: undefined },
      { REVIEWER_ID: "" },
      { REVIEWER_ID: "bad reviewer" },
      { REVIEWER_ID: "x".repeat(65) },
    ];
    for (const override of bad) {
      const { touched, env } = untouchable();
      const r = await review("capacity", {}, { env: { ...baseEnv(), ...env, ...override } });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("misconfigured");
      expect(r.text).not.toContain(TOKEN);
      expect(touched).toEqual([]);
    }
  });

  it("rejects missing, wrong or agent credentials with 401 before any storage access", async () => {
    const { touched, env } = untouchable();
    const attempts: (string | null)[] = [
      null,
      "",
      "Bearer ",
      `Basic ${TOKEN}`,
      `bearer ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${agentToken}`,
      `Bearer ${"z".repeat(600)}`,
    ];
    for (const op of OPS) {
      for (const auth of attempts) {
        const r = await review(op, {}, { env: { ...baseEnv(), ...env }, auth });
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe("unauthorized");
        expect(r.text).not.toContain(TOKEN);
        expect(r.cache).toBe("no-store");
      }
    }
    expect(touched).toEqual([]);
  });

  it("refuses non-POST and unknown review paths after authentication", async () => {
    expect((await review("capacity", {}, { method: "GET" })).status).toBe(405);
    expect((await review("history")).status).toBe(404);
    expect((await review("queue/extra")).status).toBe(404);
    expect((await review("history", {}, { auth: null })).status).toBe(401);
  });

  it("returns 503 when storage bindings are missing after authentication", async () => {
    const r = await review("capacity", {}, { env: { ...baseEnv(), DB: undefined } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("misconfigured");
  });

  it("rejects malformed and oversized bodies", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/v1/review/queue", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: "[1]",
      }),
      baseEnv() as never,
    );
    expect(res.status).toBe(400);
    const big = await review("queue", { cursor: "x".repeat(9000) });
    expect(big.status).toBe(413);
  });
});

describe("remote review: separation from agent and public routes", () => {
  it("the reviewer token is not an agent credential", async () => {
    for (const path of ["search", "get", "preview", "contribute", "feedback"]) {
      const res = await worker.fetch(
        new Request(`https://example.com/v1/commons/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ query: "review", maxUtf8Bytes: 64000 }),
        }),
        baseEnv() as never,
      );
      expect(res.status).toBe(401);
    }
  });

  it("public Commons operations do not expose pending content, queue or history", async () => {
    const c = await create();
    const get = await worker.fetch(
      new Request("https://example.com/v1/commons/get", {
        method: "POST",
        headers: { Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ contributionId: c.id, version: 1, maxUtf8Bytes: 64000 }),
      }),
      baseEnv() as never,
    );
    expect(get.status).toBe(404);
  });

  it("no MCP or public Commons module imports the review interface", () => {
    const files = [
      ...readdirSync("src/mcp").map((f) => join("src/mcp", f)),
      "src/registry/search.ts",
      "src/registry/retrieval.ts",
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/review\/routes|QualityReviewer|pendingQueue/);
    }
  });
});

describe("remote review: queue, inspect and decisions", () => {
  it("paginates the pending queue oldest first with an opaque cursor and no duplicates", async () => {
    const mine = [await create("knowledge"), await create("execution"), await create()];
    await create().then((c) => decide(c.id, "reject"));
    const pending = (await db
      .prepare("SELECT count(*) AS c FROM version_quality_states WHERE state = 'pending'")
      .first<{ c: number }>())!.c;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await review("queue", { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200);
      expect(r.cache).toBe("no-store");
      expect(r.body.schemaVersion).toBe("review-queue/v1");
      expect(r.body.untrustedNotice).toMatch(/untrusted/);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      for (const item of r.body.items) {
        expect(item).toEqual({
          contributionId: expect.any(String),
          version: expect.any(Number),
          family: expect.stringMatching(/^(knowledge|execution)$/),
          title: expect.any(String),
          contentType: expect.any(String),
          createdAt: expect.any(String),
          pendingSince: expect.any(String),
        });
        seen.push(`${item.contributionId}@${item.version}`);
      }
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(cursor).toBeNull();
    expect(seen.length).toBe(pending);
    expect(new Set(seen).size).toBe(seen.length);
    const positions = mine.map((c) => seen.indexOf(`${c.id}@1`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Same timestamp: ordered by contribution ID within the timestamp.
    const sorted = [...mine].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => `${c.id}@1`);
    expect(seen.filter((s) => sorted.includes(s))).toEqual(sorted);
  });

  it("validates queue limit, cursor and fields", async () => {
    for (const body of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { limit: "2" },
      { cursor: "" },
      { cursor: "not a cursor" },
      { cursor: btoa("[1,2]") },
      { cursor: 5 },
      { reviewerId: "someone-else" },
    ]) {
      const r = await review("queue", body);
      expect(r.status).toBe(400);
    }
    expect((await review("queue", { limit: 50 })).status).toBe(200);
  });

  it("inspects an exact version with content wrapped as untrusted data", async () => {
    for (const family of ["knowledge", "execution"] as const) {
      const c = await create(family);
      const r = await review("inspect", { contributionId: c.id, version: 1 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        schemaVersion: "review-inspect/v1",
        contributionId: c.id,
        version: 1,
        state: "pending",
        decisions: [],
      });
      expect(r.body.untrusted.notice).toMatch(/untrusted/);
      expect(r.body.untrusted.contribution.family).toBe(family);
      expect(r.body.untrusted.contribution.contentHash).toBe(c.contentHash);
      expect(r.body.contribution).toBeUndefined();
    }
    const missing = await review("inspect", {
      contributionId: "00000000-0000-4000-8000-000000000000",
      version: 1,
    });
    expect(missing.status).toBe(404);
    for (const body of [{}, { contributionId: "x" }, { contributionId: "x", version: 0 }]) {
      expect((await review("inspect", body)).status).toBe(400);
    }
    const c = await create();
    expect((await review("inspect", { contributionId: c.id, version: 2 })).status).toBe(404);
    expect(
      (await review("inspect", { contributionId: c.id, version: 1, extra: true })).status,
    ).toBe(400);
  });

  it("approve, reject and withdraw record the configured reviewer and a required reason", async () => {
    const a = await create();
    const ok = await decide(a.id, "approve", "  meets pilot bar  ");
    expect(ok.status).toBe(200);
    expect(ok.body.decision).toMatchObject({
      contributionId: a.id,
      version: 1,
      fromState: "pending",
      toState: "listed_unverified",
      reviewerId: REVIEWER,
      reason: "meets pilot bar",
      decidedAt: clock.toISOString(),
    });
    expect(await state(a.id)).toBe("listed_unverified");

    const w = await decide(a.id, "withdraw", "superseded");
    expect(w.status).toBe(200);
    expect(w.body.decision).toMatchObject({ fromState: "listed_unverified", toState: "withdrawn" });
    expect(await state(a.id)).toBe("withdrawn");

    const r = await create("execution");
    const rej = await decide(r.id, "reject", "off-topic");
    expect(rej.status).toBe(200);
    expect(rej.body.decision.toState).toBe("rejected");

    const insp = await review("inspect", { contributionId: a.id, version: 1 });
    expect(insp.body.state).toBe("withdrawn");
    expect(insp.body.decisions.map((d: { toState: string }) => d.toState)).toEqual([
      "listed_unverified",
      "withdrawn",
    ]);
    expect(
      insp.body.decisions.every((d: { reviewerId: string }) => d.reviewerId === REVIEWER),
    ).toBe(true);
  });

  it("never takes reviewer identity or state from the request; validates decision and reason", async () => {
    const c = await create();
    const spoof = await review("decide", {
      contributionId: c.id,
      version: 1,
      decision: "approve",
      reason: "x",
      reviewerId: "attacker",
    });
    expect(spoof.status).toBe(400);
    for (const decision of ["listed_unverified", "pending", "APPROVE", "constructor", "", 1]) {
      expect((await decide(c.id, decision as string)).status).toBe(400);
    }
    for (const reason of [undefined, "", "   ", "a".repeat(501), "line\nbreak", 7]) {
      const r = await review("decide", {
        contributionId: c.id,
        version: 1,
        decision: "approve",
        ...(reason === undefined ? {} : { reason }),
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_reason");
    }
    expect(await state(c.id)).toBe("pending");
    expect(await decisionCount(c.id)).toBe(0);
  });

  it("refuses invalid transitions with 409 and records nothing", async () => {
    const pending = await create();
    expect((await decide(pending.id, "withdraw")).body.error.code).toBe("invalid_transition");
    const rejected = await create();
    await decide(rejected.id, "reject");
    const listed = await create();
    await decide(listed.id, "approve");
    const withdrawn = await create();
    await decide(withdrawn.id, "approve");
    await decide(withdrawn.id, "withdraw");
    const cases: [string, string][] = [
      [rejected.id, "approve"],
      [rejected.id, "reject"],
      [rejected.id, "withdraw"],
      [listed.id, "approve"],
      [listed.id, "reject"],
      [withdrawn.id, "approve"],
      [withdrawn.id, "withdraw"],
    ];
    for (const [id, decision] of cases) {
      const before = await decisionCount(id);
      const r = await decide(id, decision);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("invalid_transition");
      expect(await decisionCount(id)).toBe(before);
    }
    const unknown = await decide("00000000-0000-4000-8000-000000000000", "approve");
    expect(unknown.status).toBe(404);
  });

  it("concurrent decisions on one version record exactly one", async () => {
    const c = await create();
    const results = await Promise.all([
      decide(c.id, "approve"),
      decide(c.id, "reject"),
      decide(c.id, "approve"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(["state_conflict", "invalid_transition"]).toContain(r.body.error.code);
    }
    expect(await decisionCount(c.id)).toBe(1);
    const winner = results.find((r) => r.status === 200)!;
    expect(await state(c.id)).toBe(winner.body.decision.toState);
  });
});

describe("remote review: storage failures", () => {
  const failingDb = () =>
    new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error("D1 unavailable");
          };
        },
      },
    );

  it("D1 failures return 503 storage_error without detail", async () => {
    const env = { ...baseEnv(), DB: failingDb() };
    for (const [op, body] of [
      ["queue", {}],
      ["capacity", {}],
      ["inspect", { contributionId: "c-x-00000000", version: 1 }],
      ["decide", { contributionId: "c-x-00000000", version: 1, decision: "reject", reason: "r" }],
    ] as const) {
      const r = await review(op, body, { env });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("storage_error");
      expect(r.text).not.toContain("D1 unavailable");
    }
  });

  it("missing or failing R2 content cannot be approved and is not served", async () => {
    const c = await create();
    await proxy.env.CONTENT_BUCKET.delete(contentObjectKey(c.contentHash));
    const insp = await review("inspect", { contributionId: c.id, version: 1 });
    expect(insp.status).toBe(422);
    expect(insp.body.error.code).toBe("content_missing");
    expect(insp.body.untrusted).toBeUndefined();
    const r = await decide(c.id, "approve");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("content_unavailable");
    expect(await state(c.id)).toBe("pending");

    const d = await create();
    const throwingBucket = {
      get: () => Promise.reject(new Error("R2 unavailable")),
      head: () => Promise.reject(new Error("R2 unavailable")),
    };
    const env = { ...baseEnv(), CONTENT_BUCKET: throwingBucket };
    const i2 = await review("inspect", { contributionId: d.id, version: 1 }, { env });
    expect([422, 503]).toContain(i2.status);
    expect(i2.text).not.toContain("R2 unavailable");
    const a2 = await review(
      "decide",
      { contributionId: d.id, version: 1, decision: "approve", reason: "r" },
      { env },
    );
    expect([422, 503]).toContain(a2.status);
    expect(await state(d.id)).toBe("pending");
    expect(await decisionCount(d.id)).toBe(0);
  });
});

describe("remote review: capacity", () => {
  // Runs last: fills the shared database to the 100-place cap.
  it("reports capacity privately and refuses approvals at the D1-enforced cap", async () => {
    const before = await review("capacity");
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      schemaVersion: "review-capacity/v1",
      limit: 100,
      used: expect.any(Number),
      remaining: 100 - before.body.used,
    });
    expect((await review("capacity", { extra: 1 })).status).toBe(400);

    let filler = 0;
    while ((await review("capacity")).body.used < 99) {
      await db
        .prepare(
          "INSERT INTO pilot_capacity_places (contribution_id, first_version, claimed_at) VALUES (?, 1, ?)",
        )
        .bind(`filler-${++filler}`, "2026-11-01T00:00:00Z")
        .run();
    }
    const last = await create();
    const extra = [await create(), await create()];
    expect((await decide(last.id, "approve")).status).toBe(200);
    expect((await review("capacity")).body).toMatchObject({ used: 100, remaining: 0 });

    const raced = await Promise.all(extra.map((c) => decide(c.id, "approve")));
    for (const [i, r] of raced.entries()) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("capacity_reached");
      expect(await state(extra[i]!.id)).toBe("pending");
      expect(await decisionCount(extra[i]!.id)).toBe(0);
    }
    // Rejection still works at capacity; withdrawal frees no place.
    expect((await decide(extra[0]!.id, "reject")).status).toBe(200);
    expect((await decide(last.id, "withdraw")).status).toBe(200);
    expect((await review("capacity")).body).toMatchObject({ used: 100, remaining: 0 });
  });
});

describe("remote review: needs reports", () => {
  const report: NeedsReport = {
    category: "missing_information",
    summary: "No record documents the httpbin GET /headers response",
    desiredOutcome: "A listed Knowledge record for the headers contract",
    searchTerms: ["httpbin", "headers"],
  };

  it("returns identity-free groups counted by distinct operators", async () => {
    const identity = new IdentityRepository(db);
    const intake = new NeedsIntake(db, { now: () => clock });
    const actors: { agentId: AgentId; operatorId: OperatorId }[] = [];
    for (const name of ["Needs Op A", "Needs Op B"]) {
      const op = await identity.createOperator({ kind: "organization", displayName: name });
      const agent = await identity.registerAgent(op.id, { displayName: `${name} agent` });
      actors.push({ agentId: agent.id, operatorId: op.id });
    }
    for (const actor of actors) expect((await intake.submit(actor, report)).ok).toBe(true);
    expect(await intake.submit(actors[0]!, report)).toEqual({ ok: true, duplicate: true });

    const r = await review("needs");
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.body.schemaVersion).toBe("needs-review/v1");
    expect(r.body.groups).toHaveLength(1);
    expect(r.body.groups[0]).toMatchObject({
      category: "missing_information",
      distinctOperators: 2,
      totalReports: 3,
    });
    expect(r.body.groups[0].untrusted.summary).toBe(report.summary);
    for (const actor of actors) {
      expect(r.text).not.toContain(actor.agentId);
      expect(r.text).not.toContain(actor.operatorId);
    }
  });

  it("validates the needs limit and fields", async () => {
    for (const body of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "5" }, { x: 1 }]) {
      const r = await review("needs", body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
    }
    expect((await review("needs", { limit: 1 })).status).toBe(200);
  });
});

describe("remote review: pilot usage", () => {
  it("returns aggregate counts without identities and tracks new contributions", async () => {
    const before = await review("usage");
    expect(before.status).toBe(200);
    expect(before.cache).toBe("no-store");
    expect(before.body.schemaVersion).toBe("pilot-usage/v1");
    expect(before.body.notMeasured).toHaveLength(1);
    for (const section of ["enrollment", "retrieval", "feedback", "needs"]) {
      for (const value of Object.values(before.body[section] as Record<string, unknown>)) {
        expect(Number.isSafeInteger(value) && (value as number) >= 0).toBe(true);
      }
    }
    expect(before.body.enrollment.operators).toBeGreaterThanOrEqual(1);
    expect(before.body.enrollment.agents).toBeGreaterThanOrEqual(1);

    const created = await create();
    const after = await review("usage");
    expect(after.body.contributions.contributionIds).toBe(
      before.body.contributions.contributionIds + 1,
    );
    expect(after.body.contributions.versionsByState.pending).toBe(
      (before.body.contributions.versionsByState.pending ?? 0) + 1,
    );
    expect(after.text).not.toContain(created.id);
    expect(after.text).not.toContain(author);
  });

  it("counts recorded searches and retrievals per day without identities", async () => {
    const before = await review("usage");
    await recordUsage(db, "search", clock);
    await recordUsage(db, "search", clock);
    await recordUsage(db, "retrieval", clock);
    const after = await review("usage");
    expect(after.body.activity.searches).toBe(before.body.activity.searches + 2);
    expect(after.body.activity.retrievals).toBe(before.body.activity.retrievals + 1);
    const days = after.body.activity.recentDays as { day: string; searches: number }[];
    const today = days.find((d) => d.day === "2026-11-15");
    expect(today?.searches).toBeGreaterThanOrEqual(2);
    // Counting is best effort: a broken database must not throw.
    await expect(recordUsage({} as D1Database, "search", clock)).resolves.toBeUndefined();
  });

  it("counts listed versions by family and accepts no fields", async () => {
    // Runs after the capacity test filled the pilot, so no further approval is possible here.
    const usage = await review("usage");
    const byFamily = usage.body.contributions.listedVersionsByFamily as Record<string, number>;
    const listed = Object.values(byFamily).reduce((sum, n) => sum + n, 0);
    expect(listed).toBeGreaterThanOrEqual(1);
    expect(listed).toBe(usage.body.contributions.versionsByState.listed_unverified);
    for (const family of Object.keys(byFamily)) {
      expect(["knowledge", "execution"]).toContain(family);
    }
    const invalid = await review("usage", { limit: 1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("invalid_request");
  });
});

describe("remote review: headless operator client", () => {
  const viaWorker = (env: Env = baseEnv()) =>
    (async (input: URL | RequestInfo, init?: RequestInit) =>
      worker.fetch(new Request(input, init), env as never)) as typeof fetch;
  const config = { baseUrl: "https://commons.example.com", token: TOKEN };

  it("runs capacity, queue, inspect and decide against the Worker without printing the token", async () => {
    const c = await create();
    const outs = [
      await runRemoteReview(["capacity"], config, viaWorker()),
      await runRemoteReview(["queue", "2"], config, viaWorker()),
      await runRemoteReview(["inspect", c.id, "1"], config, viaWorker()),
      await runRemoteReview(["decide", c.id, "1", "reject", "not useful"], config, viaWorker()),
      await runRemoteReview(["needs", "5"], config, viaWorker()),
      await runRemoteReview(["usage"], config, viaWorker()),
    ];
    for (const o of outs) {
      expect(o.exitCode).toBe(0);
      expect(o.stdout + o.stderr).not.toContain(TOKEN);
    }
    expect(JSON.parse(outs[3]!.stdout).decision.reviewerId).toBe(REVIEWER);
    const again = await runRemoteReview(["decide", c.id, "1", "approve", "x"], config, viaWorker());
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toBe("HTTP 409\n");
  });

  it("reports auth failure without echoing the token and validates input locally", async () => {
    const wrong = await runRemoteReview(
      ["capacity"],
      { ...config, token: `${TOKEN}-wrong` },
      viaWorker(),
    );
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stdout + wrong.stderr).not.toContain(TOKEN);
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const [argv, cfg] of [
      [[], config],
      [["inspect", "id"], config],
      [["decide", "id", "1", "approve"], config],
      [["capacity", "extra"], config],
      [["needs", "many"], config],
      [["usage", "extra"], config],
      [["needs", "1", "2"], config],
      [["capacity"], { ...config, token: undefined }],
      [["capacity"], { ...config, baseUrl: undefined }],
      [["capacity"], { ...config, baseUrl: "http://commons.example.com" }],
      [["capacity"], { ...config, baseUrl: "https://user:pw@commons.example.com" }],
    ] as const) {
      const o = await runRemoteReview(argv, cfg, spy);
      expect(o.exitCode).toBe(2);
      expect(o.stdout + o.stderr).not.toContain(TOKEN);
    }
    expect(called).toBe(false);
    const local = await runRemoteReview(
      ["capacity"],
      { ...config, baseUrl: "http://localhost:8787" },
      viaWorker(),
    );
    expect(local.exitCode).toBe(0);
  });
});
