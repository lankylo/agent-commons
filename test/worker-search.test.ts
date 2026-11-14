import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId } from "../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../src/registry/creation";
import { seedHttpbinContributions } from "../src/seed/load-httpbin";
import worker from "../src/index";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let identity: IdentityRepository;
let credentials: CredentialService;
let agentId: AgentId;
let token: string;
let clock = new Date("2026-11-15T00:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-search-"));
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
  identity = new IdentityRepository(db);
  credentials = new CredentialService(db, { now: () => clock });

  const op = await identity.createOperator({ kind: "organization", displayName: "Acme" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const agent = await identity.registerAgent(op.id, { displayName: "Bot" });
  agentId = agent.id;
  const issued = await credentials.issueCredential(agent.id, { label: "search" });
  token = issued.token;
  const seeded = await seedHttpbinContributions(registry, agent.id);
  expect(seeded.ok).toBe(true);
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function authHeaders(tokenValue?: string): Headers {
  const headers = new Headers();
  if (tokenValue !== undefined) headers.set("Authorization", `Bearer ${tokenValue}`);
  return headers;
}

async function callSearch(
  env: Partial<RegistryEnv> & Record<string, unknown>,
  body: Record<string, unknown>,
  tokenValue?: string,
): Promise<Response> {
  const request = new Request("https://example.com/v1/commons/search", {
    method: "POST",
    headers: authHeaders(tokenValue),
    body: JSON.stringify(body),
  });
  const finalEnv = {
    DB: env.DB,
    RATE_LIMIT_AGENT_LIMIT: env.RATE_LIMIT_AGENT_LIMIT,
    RATE_LIMIT_OPERATOR_LIMIT: env.RATE_LIMIT_OPERATOR_LIMIT,
    RATE_LIMIT_WINDOW_SECONDS: env.RATE_LIMIT_WINDOW_SECONDS,
    NOW: env.NOW ?? (() => clock),
  } as Record<string, unknown>;
  return worker.fetch(request, finalEnv as never);
}

async function freshAgent() {
  const op = await identity.createOperator({
    kind: "organization",
    displayName: `Op ${Math.random()}`,
  });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(op.id)
    .run();
  const agent = await identity.registerAgent(op.id, { displayName: `Bot ${Math.random()}` });
  const issued = await credentials.issueCredential(agent.id as AgentId, { label: "fresh" });
  return { op, agent, token: issued.token };
}

describe("worker search endpoint", () => {
  it("returns a valid Knowledge search response with the discovery budget applied", async () => {
    const res = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      {
        query: "httpbin get response fields",
        family: "knowledge",
        contentType: "api-reference",
        limit: 10,
        maxUtf8Bytes: 20000,
      },
      token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { schemaVersion: string; results: Record<string, unknown>[] };
      budget: { maxUtf8Bytes: number };
    };
    expect(json).toMatchObject({
      data: {
        schemaVersion: "discovery-response/v1",
      },
      budget: {
        maxUtf8Bytes: 20000,
      },
    });
    expect(Array.isArray(json.data.results)).toBe(true);
    expect(json.data.results.some((item) => item.family === "knowledge")).toBe(true);
  });

  it("supports Execution and mixed-family search requests without R2 access", async () => {
    const env = {
      DB: db,
      RATE_LIMIT_AGENT_LIMIT: 1000,
      RATE_LIMIT_OPERATOR_LIMIT: 1000,
      get CONTENT_BUCKET() {
        throw new Error("R2 accessed by search route");
      },
    } as Record<string, unknown>;

    const executionRes = await callSearch(
      env,
      { query: "httpbin", family: "execution", limit: 10, maxUtf8Bytes: 24000 },
      token,
    );
    expect(executionRes.status).toBe(200);
    const execution = (await executionRes.json()) as {
      data: { results: Record<string, unknown>[] };
    };
    expect(execution.data.results.some((item) => item.family === "execution")).toBe(true);

    const mixedRes = await callSearch(
      env,
      { query: "httpbin", limit: 10, maxUtf8Bytes: 24000 },
      token,
    );
    expect(mixedRes.status).toBe(200);
    const mixed = (await mixedRes.json()) as { data: { results: Record<string, unknown>[] } };
    expect(Array.isArray(mixed.data.results)).toBe(true);
    expect(mixed.data.results.length).toBeGreaterThan(0);
  });

  it("rejects invalid input, missing auth and identity fields in the request body", async () => {
    const invalid = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", family: "knowledge" },
      token,
    );
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_budget",
    );

    const unauthorized = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", maxUtf8Bytes: 20000 },
    );
    expect(unauthorized.status).toBe(401);
    expect(((await unauthorized.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );

    const identityField = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", agentId: "ag_1", maxUtf8Bytes: 20000 },
      token,
    );
    expect(identityField.status).toBe(400);
    expect(((await identityField.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  it("rejects malformed, revoked, expired and inactive credentials", async () => {
    const malformed = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", maxUtf8Bytes: 20000 },
      "bad-token",
    );
    expect(malformed.status).toBe(401);

    const future = new Date("2026-11-20T00:00:00.000Z");
    const expired = await credentials.issueCredential(agentId, { label: "exp", expiresAt: future });
    clock = new Date("2026-11-21T00:00:00.000Z");
    const expiredRes = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", maxUtf8Bytes: 20000 },
      expired.token,
    );
    expect(expiredRes.status).toBe(401);
    clock = new Date("2026-11-15T00:00:00.000Z");

    const revoked = await credentials.issueCredential(agentId, { label: "rev" });
    await credentials.revokeCredential(revoked.credential.id);
    const revokedRes = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", maxUtf8Bytes: 20000 },
      revoked.token,
    );
    expect(revokedRes.status).toBe(401);

    const inactiveOp = await identity.createOperator({
      kind: "organization",
      displayName: "Suspended",
    });
    const inactiveAgent = await identity.registerAgent(inactiveOp.id, { displayName: "Dormant" });
    const inactiveToken = (
      await credentials.issueCredential(inactiveAgent.id as AgentId, { label: "inactive" })
    ).token;
    await identity.suspendOperator(inactiveOp.id);
    const inactiveRes = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", maxUtf8Bytes: 20000 },
      inactiveToken,
    );
    expect(inactiveRes.status).toBe(401);
  });

  it("enforces per-agent and per-operator throttling and a fail-closed limiter outage", async () => {
    const lowActor = await freshAgent();
    const lowEnv = {
      DB: db,
      RATE_LIMIT_AGENT_LIMIT: 1,
      RATE_LIMIT_OPERATOR_LIMIT: 1,
      RATE_LIMIT_WINDOW_SECONDS: 60,
    };
    const first = await callSearch(
      lowEnv,
      { query: "httpbin", maxUtf8Bytes: 20000 },
      lowActor.token,
    );
    expect(first.status).toBe(200);
    const second = await callSearch(
      lowEnv,
      { query: "httpbin", maxUtf8Bytes: 20000 },
      lowActor.token,
    );
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    const broken = {
      DB: {
        prepare(sql: string) {
          if (sql.includes("rate_limit_windows")) {
            throw new Error("limiter unavailable");
          }
          return db.prepare(sql);
        },
      } as unknown as D1Database,
      RATE_LIMIT_AGENT_LIMIT: 1,
      RATE_LIMIT_OPERATOR_LIMIT: 1,
      RATE_LIMIT_WINDOW_SECONDS: 60,
    } as Record<string, unknown>;
    const outage = await callSearch(
      broken,
      { query: "httpbin", maxUtf8Bytes: 20000 },
      lowActor.token,
    );
    expect(outage.status).toBe(503);
    expect(((await outage.json()) as { error: { code: string } }).error.code).toBe(
      "rate_limiter_unavailable",
    );
  });

  it("rejects budgets that cannot fit even the empty discovery response", async () => {
    const res = await callSearch(
      { DB: db, RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1000 },
      { query: "httpbin", maxUtf8Bytes: 1 },
      token,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("budget_too_small");
  });
});
