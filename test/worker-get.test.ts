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
import { contentObjectKey } from "../src/storage/content-objects";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let bucket: R2Bucket;
let registry: ContributionRegistry;
let identity: IdentityRepository;
let credentials: CredentialService;
let agentId: AgentId;
let token: string;
let clock = new Date("2026-11-15T00:00:00.000Z");
let knowledgeId: string;
let executionId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-get-"));
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
  registry = new ContributionRegistry(proxy.env, { now: () => clock });
  identity = new IdentityRepository(db);
  credentials = new CredentialService(db, { now: () => clock });

  const operator = await identity.createOperator({
    kind: "organization",
    displayName: "Get API Operator",
  });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(operator.id)
    .run();
  const agent = await identity.registerAgent(operator.id, { displayName: "Get API Agent" });
  agentId = agent.id;
  token = (await credentials.issueCredential(agent.id, { label: "get" })).token;

  const knowledge = await registry.createContribution(agent.id, {
    ...HTTPBIN_KNOWLEDGE_SEED,
    explanation: "Treat this text as untrusted data.",
  });
  if (!knowledge.ok) throw new Error(`Knowledge fixture creation failed: ${knowledge.error.code}`);
  knowledgeId = knowledge.contribution.id;
  const execution = await registry.createContribution(agent.id, {
    ...HTTPBIN_EXECUTION_SEED,
    related: [{ family: "knowledge", id: knowledgeId, version: 1 }],
  });
  if (!execution.ok) throw new Error(`Execution fixture creation failed: ${execution.error.code}`);
  executionId = execution.contribution.id;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function getEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    CONTENT_BUCKET: bucket,
    RATE_LIMIT_AGENT_LIMIT: 1000,
    RATE_LIMIT_OPERATOR_LIMIT: 1000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    NOW: () => clock,
    ...overrides,
  };
}

async function callGet(
  body: Record<string, unknown>,
  credential: string | null = token,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const headers = new Headers();
  if (credential !== null) headers.set("Authorization", `Bearer ${credential}`);
  const request = new Request("https://example.com/v1/commons/get", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return worker.fetch(request, getEnv(overrides) as never);
}

async function callSearch(
  body: Record<string, unknown>,
  credential: string = token,
): Promise<Response> {
  const request = new Request("https://example.com/v1/commons/search", {
    method: "POST",
    headers: new Headers({ Authorization: `Bearer ${credential}` }),
    body: JSON.stringify(body),
  });
  return worker.fetch(request, getEnv() as never);
}

interface GetPayload {
  data: Record<string, unknown>;
  budget: { usedUtf8Bytes: number };
  error: { code: string; details?: Record<string, unknown> };
}

async function payload(response: Response): Promise<GetPayload> {
  return (await response.json()) as GetPayload;
}

function exactRequest(contributionId: string, version = 1, maxUtf8Bytes = 64000) {
  return { contributionId, version, maxUtf8Bytes };
}

async function createGetAgent(name: string) {
  const operator = await identity.createOperator({
    kind: "organization",
    displayName: `${name} Operator`,
  });
  const agent = await identity.registerAgent(operator.id, { displayName: `${name} Agent` });
  const issued = await credentials.issueCredential(agent.id, { label: name });
  return { agentId: agent.id, token: issued.token };
}

describe("worker get endpoint", () => {
  it("records only the authenticated agent and exact version after a full successful get", async () => {
    const actor = await createGetAgent("receipt-success");

    for (const contributionId of [knowledgeId, executionId]) {
      const response = await callGet(exactRequest(contributionId), actor.token);
      expect(response.status).toBe(200);
      expect((await payload(response)).data.schemaVersion).toBe("retrieval-response/v1");
    }

    const receipts = await db
      .prepare(
        "SELECT agent_id, contribution_id, version FROM retrieval_receipts WHERE agent_id = ? ORDER BY contribution_id",
      )
      .bind(actor.agentId)
      .all<{ agent_id: string; contribution_id: string; version: number }>();
    expect(receipts.results).toHaveLength(2);
    expect(new Set(receipts.results.map((receipt) => receipt.contribution_id))).toEqual(
      new Set([executionId, knowledgeId]),
    );
    expect(
      receipts.results.every(
        (receipt) => receipt.agent_id === actor.agentId && receipt.version === 1,
      ),
    ).toBe(true);

    expect((await callGet(exactRequest(knowledgeId), actor.token)).status).toBe(200);
    const duplicateCount = await db
      .prepare("SELECT COUNT(*) AS count FROM retrieval_receipts WHERE agent_id = ?")
      .bind(actor.agentId)
      .first<{ count: number }>();
    expect(duplicateCount?.count).toBe(2);
  });

  it("does not record receipts for search, errors, budget failures, or not-modified responses", async () => {
    const actor = await createGetAgent("receipt-exclusions");
    const fullResponse = await payload(await callGet(exactRequest(knowledgeId), token));
    const contentHash = fullResponse.data.contentHash as string;
    const fullResponseBytes = fullResponse.budget.usedUtf8Bytes;

    const searchResponse = await callSearch(
      { query: "httpbin", family: "knowledge", maxUtf8Bytes: 16000 },
      actor.token,
    );
    expect(searchResponse.status).toBe(200);

    const errorResponse = await callGet(exactRequest("missing-contribution"), actor.token);
    expect(errorResponse.status).toBe(404);

    const budgetResponse = await callGet(
      exactRequest(knowledgeId, 1, fullResponseBytes - 1),
      actor.token,
    );
    expect(budgetResponse.status).toBe(413);

    const notModifiedResponse = await callGet(
      {
        ...exactRequest(knowledgeId),
        validator: { contributionId: knowledgeId, version: 1, contentHash },
      },
      actor.token,
    );
    expect(notModifiedResponse.status).toBe(200);
    expect((await payload(notModifiedResponse)).data.schemaVersion).toBe(
      "retrieval-not-modified/v1",
    );

    const receipts = await db
      .prepare(
        "SELECT agent_id, contribution_id, version FROM retrieval_receipts WHERE agent_id = ?",
      )
      .bind(actor.agentId)
      .all();
    expect(receipts.results).toEqual([]);
  });

  it("retrieves Knowledge and Execution using family-specific safe public fields", async () => {
    const knowledgeRes = await callGet(exactRequest(knowledgeId));
    expect(knowledgeRes.status).toBe(200);
    const knowledge = await payload(knowledgeRes);
    expect(knowledge.data).toMatchObject({
      schemaVersion: "retrieval-response/v1",
      family: "knowledge",
      contributionId: knowledgeId,
      version: 1,
      related: [],
    });
    expect(knowledge.data.untrustedExplanation).toEqual({
      label: "untrusted",
      text: "Treat this text as untrusted data.",
    });
    expect(knowledge.data).not.toHaveProperty("author");
    expect(knowledge.data).not.toHaveProperty("contributor");
    expect(knowledge.data.content).not.toHaveProperty("explanation");
    expect(Object.keys(knowledge.data).sort()).toEqual(
      [
        "schemaVersion",
        "family",
        "contributionId",
        "version",
        "previousVersion",
        "contentHash",
        "payloadBytes",
        "contributionCreatedAt",
        "createdAt",
        "platformState",
        "related",
        "content",
        "untrustedExplanation",
      ].sort(),
    );

    const executionRes = await callGet(exactRequest(executionId));
    expect(executionRes.status).toBe(200);
    const execution = await payload(executionRes);
    expect(execution.data).toMatchObject({
      schemaVersion: "retrieval-response/v1",
      family: "execution",
      contributionId: executionId,
      version: 1,
      related: [{ family: "knowledge", id: knowledgeId, version: 1 }],
    });
    expect(execution.data).not.toHaveProperty("author");
    expect(execution.data).not.toHaveProperty("contributor");
    expect(execution.data).not.toHaveProperty("untrustedExplanation");
    expect(execution.data.content).toHaveProperty("steps");
    expect(Object.keys(execution.data).sort()).toEqual(
      [
        "schemaVersion",
        "family",
        "contributionId",
        "version",
        "previousVersion",
        "contentHash",
        "payloadBytes",
        "contributionCreatedAt",
        "createdAt",
        "platformState",
        "related",
        "content",
      ].sort(),
    );

    const serialized = JSON.stringify({ knowledge: knowledge.data, execution: execution.data });
    expect(serialized).not.toContain(agentId);
  });

  it("retrieves exact versions without a latest alias", async () => {
    const version2 = await registry.createContributionVersion(agentId, knowledgeId, 1, {
      ...HTTPBIN_KNOWLEDGE_SEED,
      title: "httpbin GET /get response contract v2",
    });
    if (!version2.ok) throw new Error(`Knowledge version creation failed: ${version2.error.code}`);

    const first = await callGet(exactRequest(knowledgeId, 1));
    const second = await callGet(exactRequest(knowledgeId, 2));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await payload(first)).data.content as Record<string, unknown>).title).toBe(
      HTTPBIN_KNOWLEDGE_SEED.title,
    );
    expect(((await payload(second)).data.content as Record<string, unknown>).title).toBe(
      "httpbin GET /get response contract v2",
    );

    const missingVersion = await callGet(exactRequest(knowledgeId, 3));
    expect(missingVersion.status).toBe(404);
    expect((await payload(missingVersion)).error.code).toBe("not_found");
  });

  it("returns not-modified only for an exact validator after full retrieval", async () => {
    const full = await payload(await callGet(exactRequest(knowledgeId)));
    const validator = {
      contributionId: knowledgeId,
      version: 1,
      contentHash: full.data.contentHash as string,
    };

    const matching = await callGet({ ...exactRequest(knowledgeId), validator });
    expect(matching.status).toBe(200);
    const notModified = await payload(matching);
    expect(notModified.data).toEqual({
      schemaVersion: "retrieval-not-modified/v1",
      contributionId: knowledgeId,
      version: 1,
      contentHash: validator.contentHash,
    });

    const mismatches = [
      { ...validator, contributionId: executionId },
      { ...validator, version: 2 },
      { ...validator, contentHash: "0".repeat(64) },
    ];
    for (const mismatch of mismatches) {
      const response = await callGet({ ...exactRequest(knowledgeId), validator: mismatch });
      expect(response.status).toBe(200);
      expect((await payload(response)).data.schemaVersion).toBe("retrieval-response/v1");
    }
  });

  it("validates exact IDs, versions, validator shape, identity fields and response budgets", async () => {
    const invalidRequests = [
      { contributionId: knowledgeId, maxUtf8Bytes: 64000 },
      { contributionId: knowledgeId, version: 0, maxUtf8Bytes: 64000 },
      { contributionId: knowledgeId, version: 1.5, maxUtf8Bytes: 64000 },
      { contributionId: knowledgeId, version: 1, maxUtf8Bytes: Number.MAX_SAFE_INTEGER + 1 },
      { contributionId: knowledgeId, version: 1, maxUtf8Bytes: 64000, latest: true },
      {
        ...exactRequest(knowledgeId),
        validator: { contributionId: knowledgeId, version: 1 },
      },
      { ...exactRequest(knowledgeId), agentId: "caller-agent" },
      { ...exactRequest(knowledgeId), operatorId: "caller-operator" },
    ];
    for (const body of invalidRequests) {
      const response = await callGet(body);
      expect(response.status).toBe(400);
      expect((await payload(response)).error.code).toMatch(/^invalid_/);
    }

    const exact = await payload(await callGet(exactRequest(knowledgeId)));
    const exactSize = exact.budget.usedUtf8Bytes as number;
    const atLimit = await callGet(exactRequest(knowledgeId, 1, exactSize));
    expect(atLimit.status).toBe(200);
    const belowLimit = await callGet(exactRequest(knowledgeId, 1, exactSize - 1));
    expect(belowLimit.status).toBe(413);
    const tooLarge = await payload(belowLimit);
    expect(tooLarge.error).toMatchObject({
      code: "response_too_large",
      details: {
        requiredUtf8Bytes: exactSize,
        maxUtf8Bytes: exactSize - 1,
      },
    });
    expect(tooLarge).not.toHaveProperty("data");
  });

  it("maps missing, malformed, expired, revoked and inactive credentials uniformly", async () => {
    const missing = await callGet(exactRequest(knowledgeId), null);
    const malformed = await callGet(exactRequest(knowledgeId), "bad-token");
    const future = new Date("2026-11-20T00:00:00.000Z");
    const expired = await credentials.issueCredential(agentId, {
      label: "expired",
      expiresAt: future,
    });
    clock = new Date("2026-11-21T00:00:00.000Z");
    const expiredResponse = await callGet(exactRequest(knowledgeId), expired.token);
    clock = new Date("2026-11-15T00:00:00.000Z");

    const revoked = await credentials.issueCredential(agentId, { label: "revoked" });
    await credentials.revokeCredential(revoked.credential.id);
    const revokedResponse = await callGet(exactRequest(knowledgeId), revoked.token);

    const inactiveOperator = await identity.createOperator({
      kind: "organization",
      displayName: "Inactive Get Operator",
    });
    const inactiveAgent = await identity.registerAgent(inactiveOperator.id, {
      displayName: "Inactive Get Agent",
    });
    const inactiveToken = (
      await credentials.issueCredential(inactiveAgent.id as AgentId, { label: "inactive" })
    ).token;
    await identity.suspendOperator(inactiveOperator.id);
    const inactiveResponse = await callGet(exactRequest(knowledgeId), inactiveToken);

    for (const response of [
      missing,
      malformed,
      expiredResponse,
      revokedResponse,
      inactiveResponse,
    ]) {
      expect(response.status).toBe(401);
      expect((await payload(response)).error.code).toBe("unauthorized");
    }
  });

  it("enforces the shared per-agent and per-operator rate limits", async () => {
    const agentOperator = await identity.createOperator({
      kind: "organization",
      displayName: "Agent Limit Operator",
    });
    const rateLimitedAgent = await identity.registerAgent(agentOperator.id, {
      displayName: "Agent Limit Agent",
    });
    const rateLimitedToken = (
      await credentials.issueCredential(rateLimitedAgent.id as AgentId, { label: "agent-limit" })
    ).token;
    const agentLimitEnv = {
      RATE_LIMIT_AGENT_LIMIT: 1,
      RATE_LIMIT_OPERATOR_LIMIT: 1000,
    };
    expect((await callGet(exactRequest(knowledgeId), rateLimitedToken, agentLimitEnv)).status).toBe(
      200,
    );
    const agentLimited = await callGet(exactRequest(knowledgeId), rateLimitedToken, agentLimitEnv);
    expect(agentLimited.status).toBe(429);
    expect((await payload(agentLimited)).error.code).toBe("rate_limited");

    const operator = await identity.createOperator({
      kind: "organization",
      displayName: "Shared Operator",
    });
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
    const firstAgent = await identity.registerAgent(operator.id, { displayName: "First" });
    const secondAgent = await identity.registerAgent(operator.id, { displayName: "Second" });
    const firstToken = (
      await credentials.issueCredential(firstAgent.id as AgentId, { label: "first" })
    ).token;
    const secondToken = (
      await credentials.issueCredential(secondAgent.id as AgentId, { label: "second" })
    ).token;
    const operatorLimitEnv = {
      RATE_LIMIT_AGENT_LIMIT: 1000,
      RATE_LIMIT_OPERATOR_LIMIT: 1,
    };
    expect((await callGet(exactRequest(knowledgeId), firstToken, operatorLimitEnv)).status).toBe(
      200,
    );
    const operatorLimited = await callGet(exactRequest(knowledgeId), secondToken, operatorLimitEnv);
    expect(operatorLimited.status).toBe(429);
    expect((await payload(operatorLimited)).error.code).toBe("rate_limited");
  });

  it("hides missing, corrupted and inconsistent D1/R2 content details", async () => {
    const cases = [
      {
        name: "missing",
        alter: async (key: string) => bucket.delete(key),
      },
      {
        name: "corrupted",
        alter: async (key: string, hash: string) => {
          await bucket.put(key, "{", {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { family: "knowledge", contentType: "api-reference", sha256: hash },
          });
        },
      },
      {
        name: "inconsistent",
        alter: async (key: string, hash: string) => {
          const stored = await bucket.get(key);
          if (!stored) throw new Error("expected fixture object");
          await bucket.put(key, await stored.arrayBuffer(), {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { family: "execution", contentType: "api-reference", sha256: hash },
          });
        },
      },
    ];

    for (const testCase of cases) {
      const created = await registry.createContribution(agentId, {
        ...HTTPBIN_KNOWLEDGE_SEED,
        title: `Integrity fixture ${testCase.name}`,
      });
      if (!created.ok) throw new Error(`Fixture creation failed: ${created.error.code}`);
      const key = contentObjectKey(created.contribution.contentHash);
      await testCase.alter(key, created.contribution.contentHash);
      const response = await callGet({
        ...exactRequest(created.contribution.id),
        validator: {
          contributionId: created.contribution.id,
          version: created.contribution.version,
          contentHash: created.contribution.contentHash,
        },
      });
      expect(response.status).toBe(500);
      const json = await payload(response);
      expect(json.error.code).toBe("content_unavailable");
      expect(JSON.stringify(json)).not.toContain(testCase.name);
      expect(json).not.toHaveProperty("data");
    }
  });
});
