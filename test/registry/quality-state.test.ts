import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import {
  isQualityState,
  QUALITY_STATES,
  QualityStateStore,
} from "../../src/registry/quality-state";

let proxy: PlatformProxy<{ DB: D1Database }>;
let dir: string;
let db: D1Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "quality-state-"));
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
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.registry-local.jsonc",
    persist: { path: join(dir, "v3") },
  });
  db = proxy.env.DB;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("quality state types", () => {
  it("recognizes exactly the four states", () => {
    expect([...QUALITY_STATES]).toEqual(["pending", "listed_unverified", "rejected", "withdrawn"]);
    for (const s of QUALITY_STATES) expect(isQualityState(s)).toBe(true);
    for (const s of ["approved", "verified", "", null, 1]) expect(isQualityState(s)).toBe(false);
  });
});

describe("QualityStateStore", () => {
  it("reads pending for a version inserted without any state insert, and null for unknown versions", async () => {
    const identity = new IdentityRepository(db);
    const op = await identity.createOperator({ kind: "organization", displayName: "Op" });
    const agent = await identity.registerAgent(op.id, { displayName: "Ag" });
    const ts = "2026-11-15T00:00:00Z";
    await db.batch([
      db
        .prepare(
          "INSERT INTO contributions (id, family, contributor_agent_id, contributor_operator_id, created_at) VALUES ('qs-test-1','knowledge',?,?,?)",
        )
        .bind(agent.id, op.id, ts),
      db
        .prepare(
          `INSERT INTO contribution_versions (contribution_id, version, previous_version, family, author_agent_id,
             author_operator_id, content_hash, payload_bytes, title, purpose, content_type, license, data_permission,
             review_interval_days, as_of, created_at)
           VALUES ('qs-test-1', 1, NULL, 'knowledge', ?, ?, ?, 10, 't', 'p', 'x', 'MIT', 'public', 30, ?, ?)`,
        )
        .bind(agent.id, op.id, "a".repeat(64), ts, ts),
    ]);
    const store = new QualityStateStore(db);
    expect(await store.get("qs-test-1", 1)).toEqual({
      contributionId: "qs-test-1",
      version: 1,
      state: "pending",
      updatedAt: ts,
    });
    expect(await store.get("qs-test-1", 2)).toBeNull();
  });
});
