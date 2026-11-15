import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let agentId: AgentId;
let token: string;
let clock = new Date("2026-11-15T00:00:00.000Z");
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-contribute-"));
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
  identity = new IdentityRepository(db);
  credentials = new CredentialService(db, { now: () => clock });

  const operator = await identity.createOperator({
    kind: "organization",
    displayName: "Contribution API Operator",
  });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(operator.id)
    .run();
  const agent = await identity.registerAgent(operator.id, {
    displayName: "Contribution API Agent",
  });
  agentId = agent.id;
  token = (await credentials.issueCredential(agent.id, { label: "contribute" })).token;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    EXECUTION_DOMAIN_POLICY_JSON: proxy.env.EXECUTION_DOMAIN_POLICY_JSON,
    KNOWLEDGE_PERMISSION_POLICY_JSON: proxy.env.KNOWLEDGE_PERMISSION_POLICY_JSON,
    RATE_LIMIT_AGENT_LIMIT: 1000,
    RATE_LIMIT_OPERATOR_LIMIT: 1000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    NOW: () => clock,
    ...overrides,
  };
}

async function callContribute(
  body: Record<string, unknown> | string,
  credential: string | null = token,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const headers = new Headers();
  if (credential !== null) headers.set("Authorization", `Bearer ${credential}`);
  const request = new Request("https://example.com/v1/commons/contribute", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return worker.fetch(request, env(overrides) as never);
}

interface ApiPayload {
  schemaVersion?: string;
  contribution?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
}

async function payload(response: Response): Promise<ApiPayload> {
  return (await response.json()) as ApiPayload;
}

function knowledge(title = `Worker Knowledge ${++n}`) {
  return structuredClone({ ...HTTPBIN_KNOWLEDGE_SEED, title });
}

function execution(title = `Worker Execution ${++n}`, related?: unknown) {
  return {
    ...HTTPBIN_EXECUTION_SEED,
    title,
    ...(related === undefined ? {} : { related }),
  };
}

function executionForDomain(title: string, domain: string) {
  return {
    ...execution(title),
    targetDomains: [domain],
    steps: HTTPBIN_EXECUTION_SEED.steps.map((step) =>
      step.type === "http_request" ? { ...step, domain } : step,
    ),
  };
}

function expectCreatedShape(body: ApiPayload, version: number, previousVersion: number | null) {
  expect(body.schemaVersion).toBe("contribution-created/v1");
  expect(body.contribution).toMatchObject({
    version,
    previousVersion,
  });
  expect(Object.keys(body.contribution ?? {}).sort()).toEqual(
    [
      "contributionId",
      "version",
      "previousVersion",
      "family",
      "contentHash",
      "payloadBytes",
      "createdAt",
    ].sort(),
  );
}

describe("worker contribute endpoint", () => {
  it("creates Knowledge and Execution with only allow-listed response metadata", async () => {
    const knowledgeInput = knowledge();
    const knowledgeResponse = await callContribute({ contribution: knowledgeInput });
    expect(knowledgeResponse.status).toBe(200);
    const knowledgeBody = await payload(knowledgeResponse);
    expectCreatedShape(knowledgeBody, 1, null);
    expect(knowledgeBody.contribution).toMatchObject({ family: "knowledge" });

    const knowledgeId = knowledgeBody.contribution?.contributionId as string;
    const executionResponse = await callContribute({
      contribution: execution(`Worker Execution ${++n}`, [
        { family: "knowledge", id: knowledgeId, version: 1 },
      ]),
    });
    expect(executionResponse.status).toBe(200);
    const executionBody = await payload(executionResponse);
    expectCreatedShape(executionBody, 1, null);
    expect(executionBody.contribution).toMatchObject({ family: "execution" });

    const serialized = JSON.stringify({ knowledgeBody, executionBody });
    expect(serialized).not.toContain("contentKey");
    expect(serialized).not.toContain("contributor");
    expect(serialized).not.toContain("agentId");
    expect(serialized).not.toContain("operatorId");
    expect(serialized).not.toContain("owner-tested");
  });

  it("creates the exact next version and rejects stale versions and family changes", async () => {
    const initial = await payload(await callContribute({ contribution: knowledge() }));
    const contributionId = initial.contribution?.contributionId as string;
    const next = await callContribute({
      contributionId,
      expectedPreviousVersion: 1,
      contribution: knowledge("Worker Knowledge version 2"),
    });
    expect(next.status).toBe(200);
    expectCreatedShape(await payload(next), 2, 1);

    const stale = await callContribute({
      contributionId,
      expectedPreviousVersion: 1,
      contribution: knowledge("Worker Knowledge stale update"),
    });
    expect(stale.status).toBe(409);
    expect((await payload(stale)).error?.code).toBe("version_conflict");

    const familyChange = await callContribute({
      contributionId,
      expectedPreviousVersion: 2,
      contribution: execution("Wrong family version"),
    });
    expect(familyChange.status).toBe(422);
    expect((await payload(familyChange)).error?.code).toBe("family_mismatch");
  });

  it("enforces the platform domain policy on REST creation and versioning", async () => {
    const deniedCreate = await callContribute({
      contribution: executionForDomain("Denied REST create", "blocked.acme.com"),
    });
    expect(deniedCreate.status).toBe(422);
    expect((await payload(deniedCreate)).error?.code).toBe("invalid_content");

    const created = await payload(
      await callContribute({ contribution: execution("REST policy version 1") }),
    );
    expect(created.contribution?.family).toBe("execution");
    const contributionId = created.contribution?.contributionId as string;
    const deniedVersion = await callContribute({
      contributionId,
      expectedPreviousVersion: 1,
      contribution: executionForDomain("Denied REST version", "blocked.acme.com"),
    });
    expect(deniedVersion.status).toBe(422);
    expect((await payload(deniedVersion)).error?.code).toBe("invalid_content");

    const missingPolicy = await callContribute(
      { contribution: execution("Missing REST policy") },
      token,
      { EXECUTION_DOMAIN_POLICY_JSON: undefined },
    );
    expect(missingPolicy.status).toBe(503);
    expect((await payload(missingPolicy)).error?.code).toBe("execution_domain_policy_unavailable");

    const override = await callContribute({
      contribution: {
        ...execution("REST policy override"),
        executionDomainPolicy: {
          allowed: [{ domain: "blocked.acme.com", includeSubdomains: true }],
          denied: [],
        },
      },
    });
    expect(override.status).toBe(422);
    expect((await payload(override)).error?.code).toBe("platform_field_rejected");
  });

  it("enforces Knowledge URL and permission policy on REST creation and versioning", async () => {
    const invalidUrlBase = knowledge("Invalid Knowledge URL");
    const invalidUrl = {
      ...invalidUrlBase,
      sources: [{ ...invalidUrlBase.sources[0], uri: "https://example.com/docs" }],
    };
    const rejectedUrl = await payload(await callContribute({ contribution: invalidUrl }));
    expect(rejectedUrl.error?.code).toBe("invalid_content");
    expect(rejectedUrl.error?.details?.errors).toContain(
      "sources[0].uri: must not use an IANA Special-Use Domain Name or its subdomains",
    );

    const invalidPermissionsBase = knowledge("Invalid Knowledge permissions");
    const invalidPermissions = {
      ...invalidPermissionsBase,
      licensing: { ...invalidPermissionsBase.licensing, dataPermission: "not-authorized" },
    };
    const rejectedPermissions = await payload(
      await callContribute({ contribution: invalidPermissions }),
    );
    expect(rejectedPermissions.error?.code).toBe("invalid_content");
    expect(rejectedPermissions.error?.details?.errors).toContain(
      "licensing.dataPermission: declaration combination is not permitted by platform policy",
    );

    const created = await payload(
      await callContribute({ contribution: knowledge("Knowledge policy version 1") }),
    );
    const contributionId = created.contribution?.contributionId as string;
    const deniedVersionBase = knowledge("Knowledge policy version 2");
    const deniedVersion = {
      ...deniedVersionBase,
      licensing: { ...deniedVersionBase.licensing, dataPermission: "not-authorized" },
    };
    const rejectedVersion = await payload(
      await callContribute({
        contributionId,
        expectedPreviousVersion: 1,
        contribution: deniedVersion,
      }),
    );
    expect(rejectedVersion.error?.code).toBe("invalid_content");
    expect(rejectedVersion.error?.details?.errors).toContain(
      "licensing.dataPermission: declaration combination is not permitted by platform policy",
    );

    const missingPolicy = await payload(
      await callContribute(
        { contribution: knowledge("Missing Knowledge permission policy") },
        token,
        { KNOWLEDGE_PERMISSION_POLICY_JSON: undefined },
      ),
    );
    expect(missingPolicy.error?.code).toBe("knowledge_permission_policy_unavailable");

    const override = await payload(
      await callContribute({
        contribution: {
          ...knowledge("Knowledge policy override"),
          knowledgePermissionPolicy: { permittedCombinations: [] },
        },
      }),
    );
    expect(override.error?.code).toBe("platform_field_rejected");
    expect(override.error?.details?.errors).toContain(
      "knowledgePermissionPolicy: platform-managed field cannot be set",
    );
  });

  it("requires the original operator for versioning and keeps allow-list defaults off", async () => {
    const initial = await payload(await callContribute({ contribution: knowledge() }));
    const contributionId = initial.contribution?.contributionId as string;

    const otherOperator = await identity.createOperator({
      kind: "organization",
      displayName: "Different Contribution Operator",
    });
    const otherAgent = await identity.registerAgent(otherOperator.id, {
      displayName: "Different Contribution Agent",
    });
    const otherToken = (
      await credentials.issueCredential(otherAgent.id as AgentId, { label: "different" })
    ).token;
    const allowListFlag = await db
      .prepare("SELECT contribution_allow_listed FROM operators WHERE id = ?")
      .bind(otherOperator.id)
      .first<{ contribution_allow_listed: number }>();
    expect(allowListFlag?.contribution_allow_listed).toBe(0);

    const deniedCreate = await callContribute(
      { contribution: knowledge("Denied new contribution") },
      otherToken,
    );
    expect(deniedCreate.status).toBe(403);
    expect((await payload(deniedCreate)).error?.code).toBe("contribution_not_allowed");

    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(otherOperator.id)
      .run();
    const deniedVersion = await callContribute(
      {
        contributionId,
        expectedPreviousVersion: 1,
        contribution: knowledge("Other operator version attempt"),
      },
      otherToken,
    );
    expect(deniedVersion.status).toBe(404);
    expect((await payload(deniedVersion)).error?.code).toBe("not_found");
  });

  it("rejects malformed, spoofed, invalid, duplicate, and unresolved-reference requests", async () => {
    const malformedJson = await callContribute("{");
    expect(malformedJson.status).toBe(400);
    expect((await payload(malformedJson)).error?.code).toBe("invalid_request");

    const malformedRequests = [
      {},
      { contribution: null },
      { contributionId: "id-without-version", contribution: knowledge() },
      { expectedPreviousVersion: 1, contribution: knowledge() },
      { contribution: knowledge(), latest: true },
      { agentId: "caller-agent", contribution: knowledge() },
      { operatorId: "caller-operator", contribution: knowledge() },
      { author: { agentId: "a" }, contribution: knowledge() },
      { contributor: { agentId: "a" }, contribution: knowledge() },
      { version: 1, contribution: knowledge() },
      { contentHash: "0".repeat(64), contribution: knowledge() },
      { createdAt: "2026-11-14T00:00:00Z", contribution: knowledge() },
      { reliabilityScore: 1, contribution: knowledge() },
      { platformState: {}, contribution: knowledge() },
    ];
    for (const body of malformedRequests) {
      const response = await callContribute(body);
      expect(response.status).toBe(400);
      expect((await payload(response)).error?.code).toMatch(/^invalid_/);
    }

    const platformFields = [
      "author",
      "contributor",
      "agentId",
      "operatorId",
      "version",
      "contentHash",
      "hash",
      "createdAt",
      "timestamp",
      "lastVerifiedAt",
      "reliabilityScore",
      "consumerCount",
      "platformState",
      "executionDomainPolicy",
      "knowledgePermissionPolicy",
    ];
    for (const field of platformFields) {
      const response = await callContribute({
        contribution: { ...knowledge(), [field]: "caller-supplied" },
      });
      expect(response.status).toBe(422);
      expect((await payload(response)).error?.code).toBe("platform_field_rejected");
    }

    const invalidContent = await callContribute({
      contribution: { ...knowledge(), family: "unknown" },
    });
    expect(invalidContent.status).toBe(422);
    expect((await payload(invalidContent)).error?.code).toBe("invalid_content");

    const unresolved = await callContribute({
      contribution: execution("Unknown exact reference", [
        { family: "knowledge", id: "missing-reference-123", version: 1 },
      ]),
    });
    expect(unresolved.status).toBe(422);
    expect((await payload(unresolved)).error?.code).toBe("unresolved_reference");

    const duplicateInput = knowledge("Worker duplicate contribution");
    expect((await callContribute({ contribution: duplicateInput })).status).toBe(200);
    const duplicate = await callContribute({ contribution: duplicateInput });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await payload(duplicate);
    expect(duplicateBody.error?.code).toBe("duplicate_content");
    expect(JSON.stringify(duplicateBody)).not.toContain("contributionId");
  });

  it("requires valid credentials and applies the shared agent and operator limits", async () => {
    const missing = await callContribute({ contribution: knowledge() }, null);
    const malformed = await callContribute({ contribution: knowledge() }, "bad-token");

    const expiresAt = new Date("2026-11-16T00:00:00.000Z");
    const expiredToken = (
      await credentials.issueCredential(agentId, { label: "expired", expiresAt })
    ).token;
    clock = new Date("2026-11-17T00:00:00.000Z");
    const expired = await callContribute({ contribution: knowledge() }, expiredToken);
    clock = new Date("2026-11-15T00:00:00.000Z");

    const revokedCredential = await credentials.issueCredential(agentId, { label: "revoked" });
    await credentials.revokeCredential(revokedCredential.credential.id);
    const revoked = await callContribute({ contribution: knowledge() }, revokedCredential.token);

    const inactiveOperator = await identity.createOperator({
      kind: "organization",
      displayName: "Inactive Contribution Operator",
    });
    const inactiveAgent = await identity.registerAgent(inactiveOperator.id, {
      displayName: "Inactive Contribution Agent",
    });
    const inactiveToken = (
      await credentials.issueCredential(inactiveAgent.id as AgentId, { label: "inactive" })
    ).token;
    await identity.suspendOperator(inactiveOperator.id);
    const inactive = await callContribute({ contribution: knowledge() }, inactiveToken);

    for (const response of [missing, malformed, expired, revoked, inactive]) {
      expect(response.status).toBe(401);
      expect((await payload(response)).error?.code).toBe("unauthorized");
    }

    const agentOperator = await identity.createOperator({
      kind: "organization",
      displayName: "Contribution Agent Rate Operator",
    });
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(agentOperator.id)
      .run();
    const rateAgent = await identity.registerAgent(agentOperator.id, {
      displayName: "Contribution Agent Rate Agent",
    });
    const rateAgentToken = (
      await credentials.issueCredential(rateAgent.id as AgentId, { label: "agent-rate" })
    ).token;
    const agentLimit = { RATE_LIMIT_AGENT_LIMIT: 1, RATE_LIMIT_OPERATOR_LIMIT: 1000 };
    expect(
      (await callContribute({ contribution: knowledge() }, rateAgentToken, agentLimit)).status,
    ).toBe(200);
    const agentLimited = await callContribute(
      { contribution: knowledge() },
      rateAgentToken,
      agentLimit,
    );
    expect(agentLimited.status).toBe(429);
    expect((await payload(agentLimited)).error?.code).toBe("rate_limited");

    const operator = await identity.createOperator({
      kind: "organization",
      displayName: "Contribution Operator Rate Limit",
    });
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
    const first = await identity.registerAgent(operator.id, { displayName: "Rate First" });
    const second = await identity.registerAgent(operator.id, { displayName: "Rate Second" });
    const firstToken = (await credentials.issueCredential(first.id as AgentId, { label: "first" }))
      .token;
    const secondToken = (
      await credentials.issueCredential(second.id as AgentId, { label: "second" })
    ).token;
    const operatorLimit = { RATE_LIMIT_AGENT_LIMIT: 1000, RATE_LIMIT_OPERATOR_LIMIT: 1 };
    expect(
      (await callContribute({ contribution: knowledge() }, firstToken, operatorLimit)).status,
    ).toBe(200);
    const operatorLimited = await callContribute(
      { contribution: knowledge() },
      secondToken,
      operatorLimit,
    );
    expect(operatorLimited.status).toBe(429);
    expect((await payload(operatorLimited)).error?.code).toBe("rate_limited");
  });
});
