import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import type { AgentId } from "../../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../../src/registry/creation";
import { QualityReviewer, type DecideResult } from "../../src/registry/quality-review";
import { QualityStateStore } from "../../src/registry/quality-state";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let agent: AgentId;
const store = () => new QualityStateStore(db);
const reviewer = (id = "reviewer-1") => new QualityReviewer(proxy.env, id);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pilot-capacity-"));
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

async function newContribution() {
  const r = await registry.createContribution(agent, knowledge());
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.contribution;
}
async function newNextVersion(id: string, previous: number) {
  const r = await registry.createContributionVersion(agent, id, previous, knowledge());
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.contribution.version;
}
const places = async () =>
  (await db.prepare("SELECT count(*) AS c FROM pilot_capacity_places").first<{ c: number }>())!.c;
const decisions = async () =>
  (await db.prepare("SELECT count(*) AS c FROM version_quality_decisions").first<{ c: number }>())!
    .c;
const code = (r: DecideResult) => (r.ok ? "ok" : r.error.code);
let fillerN = 0;
async function fillTo(target: number) {
  while ((await places()) < target) {
    await db
      .prepare(
        "INSERT INTO pilot_capacity_places (contribution_id, first_version, claimed_at) VALUES (?, 1, ?)",
      )
      .bind(`filler-${++fillerN}`, "2026-11-01T00:00:00Z")
      .run();
  }
}
const approve = (id: string, v = 1, who = "rev-1") =>
  reviewer(who).decide(id, v, "listed_unverified", "ok");

// Tests run in order and share one database; capacity is monotonic, so order matters.
describe("pilot capacity", () => {
  it("starts empty and reports places privately", async () => {
    expect(await reviewer().capacity()).toEqual({ limit: 100, used: 0, remaining: 100 });
  });

  it("rejection uses no place; first approval uses one; later versions use none", async () => {
    const rej = await newContribution();
    expect(code(await reviewer().decide(rej.id, 1, "rejected", "no"))).toBe("ok");
    expect((await reviewer().capacity()).used).toBe(0);

    const c = await newContribution();
    expect(code(await approve(c.id))).toBe("ok");
    expect((await reviewer().capacity()).used).toBe(1);
    const v2 = await newNextVersion(c.id, 1);
    expect(code(await approve(c.id, v2))).toBe("ok");
    const v3 = await newNextVersion(c.id, v2);
    expect(code(await approve(c.id, v3))).toBe("ok");
    expect(await reviewer().capacity()).toEqual({ limit: 100, used: 1, remaining: 99 });
  });

  it("withdrawal does not free a place", async () => {
    const c = await newContribution();
    await approve(c.id);
    const before = (await reviewer().capacity()).used;
    expect(code(await reviewer().decide(c.id, 1, "withdrawn", "retired"))).toBe("ok");
    expect((await reviewer().capacity()).used).toBe(before);
  });

  it("rolls back the claimed place and decision when a batch fails after the approval", async () => {
    const c = await newContribution();
    const usedBefore = await places();
    const decisionsBefore = await decisions();
    await expect(
      db.batch([
        db
          .prepare(
            `INSERT INTO version_quality_decisions
               (contribution_id, version, from_state, to_state, reviewer_id, reason, decided_at)
             VALUES (?, 1, 'pending', 'listed_unverified', 'rev-1', 'ok', '2026-11-15T10:00:00Z')`,
          )
          .bind(c.id),
        db.prepare("UPDATE version_quality_states SET state = 'no_such_state'"),
      ]),
    ).rejects.toThrow();
    expect(await places()).toBe(usedBefore);
    expect(await decisions()).toBe(decisionsBefore);
    expect((await store().get(c.id, 1))?.state).toBe("pending");
  });

  it("allows the 100th ID and refuses the 101st+ under concurrent reviewers, with no trace", async () => {
    await fillTo(99);
    const ids = [await newContribution(), await newContribution(), await newContribution()];
    const decisionsBefore = await decisions();
    const results = await Promise.all(ids.map((c, i) => approve(c.id, 1, `rev-${i}`)));
    expect(results.map(code).sort()).toEqual(["capacity_reached", "capacity_reached", "ok"]);
    expect(await reviewer().capacity()).toEqual({ limit: 100, used: 100, remaining: 0 });
    expect(await decisions()).toBe(decisionsBefore + 1);
    for (const [i, c] of ids.entries()) {
      const r = results[i]!;
      const state = (await store().get(c.id, 1))?.state;
      expect(state).toBe(r.ok ? "listed_unverified" : "pending");
      if (!r.ok) {
        expect(r.error.code).toBe("capacity_reached");
        const insp = await reviewer().inspect(c.id, 1);
        expect(insp.ok && insp.decisions).toEqual([]);
      }
    }
    // Sequential retry at capacity is refused identically.
    const loser = ids[results.findIndex((r) => !r.ok)]!;
    expect(code(await approve(loser.id))).toBe("capacity_reached");
    expect(await places()).toBe(100);
  });

  it("at capacity: later versions of held IDs, rejection and withdrawal still work", async () => {
    const held = (await db
      .prepare(
        "SELECT contribution_id AS id FROM pilot_capacity_places WHERE contribution_id NOT LIKE 'filler-%' LIMIT 1",
      )
      .first<{ id: string }>())!.id;
    const latest = (await db
      .prepare("SELECT max(version) AS v FROM contribution_versions WHERE contribution_id = ?")
      .bind(held)
      .first<{ v: number }>())!.v;
    const v = await newNextVersion(held, latest);
    expect(code(await approve(held, v))).toBe("ok");
    const other = await newContribution();
    expect(code(await reviewer().decide(other.id, 1, "rejected", "no"))).toBe("ok");
    expect(await places()).toBe(100);
  });

  it("cannot be bypassed by direct inserts, updates or deletes", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO pilot_capacity_places (contribution_id, first_version, claimed_at) VALUES ('x', 1, '2026-11-01T00:00:00Z')",
        )
        .run(),
    ).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pilot_capacity_places").run()).rejects.toThrow();
    await expect(
      db.prepare("UPDATE pilot_capacity_places SET first_version = 2").run(),
    ).rejects.toThrow();
  });
});
