import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { RegistryEnv } from "../src/registry/creation";
import { ContributionRegistry } from "../src/registry/creation";
import { HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let token: string;
let contributionId: string;
const clock = new Date("2026-11-15T00:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-pilot-"));
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
  const operator = await identity.createOperator({ kind: "organization", displayName: "Pilot Op" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(operator.id)
    .run();
  const agent = await identity.registerAgent(operator.id, { displayName: "Pilot Agent" });
  token = (
    await new CredentialService(db, { now: () => clock }).issueCredential(agent.id, {
      label: "pilot",
    })
  ).token;
  const created = await new ContributionRegistry(proxy.env, {
    now: () => clock,
  }).createContribution(agent.id, { ...HTTPBIN_KNOWLEDGE_SEED, title: "Pilot Knowledge" });
  if (!created.ok) throw new Error("fixture failed");
  contributionId = created.contribution.id;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function call(op: string, body: unknown, pilot: string | undefined, auth = true) {
  const headers = new Headers();
  if (auth) headers.set("Authorization", `Bearer ${token}`);
  return worker.fetch(
    new Request(`https://example.com/v1/commons/${op}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    {
      DB: db,
      CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
      NOW: () => clock,
      ...(pilot === undefined ? {} : { PILOT_MODE: pilot }),
    } as never,
  );
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function tableNames(): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

describe("read-only pilot mode", () => {
  it("allows authenticated search and get, and still requires authentication", async () => {
    const search = await call("search", { query: "httpbin", maxUtf8Bytes: 64000 }, "read-only");
    expect(search.status).toBe(200);
    const get = await call("get", { contributionId, version: 1, maxUtf8Bytes: 64000 }, "read-only");
    expect(get.status).toBe(200);
    const anon = await call("search", { query: "x", maxUtf8Bytes: 64000 }, "read-only", false);
    expect(anon.status).toBe(401);
  });

  it("disables contribute and feedback without creating records", async () => {
    const tables = await tableNames();
    const watched = tables.filter(
      (t) => /contribution|feedback/.test(t) && !t.startsWith("sqlite_") && !t.startsWith("d1_"),
    );
    expect(watched.length).toBeGreaterThan(0);
    const before = await Promise.all(watched.map(count));
    for (const op of ["contribute", "feedback"]) {
      for (const auth of [true, false]) {
        const response = await call(op, { contributionId, version: 1 }, "read-only", auth);
        expect(response.status).toBe(403);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("pilot_read_only");
      }
    }
    expect(await Promise.all(watched.map(count))).toEqual(before);
  });

  it("keeps unrestricted behavior when unset or off", async () => {
    for (const mode of [undefined, "", "off"]) {
      const response = await call("contribute", {}, mode);
      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(503);
    }
  });

  it("fails closed on invalid settings", async () => {
    for (const mode of ["readonly", "READ-ONLY", "true", " read-only"]) {
      for (const op of ["search", "get", "contribute", "feedback"]) {
        const response = await call(op, {}, mode);
        expect(response.status).toBe(503);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("misconfigured");
      }
    }
  });
});
