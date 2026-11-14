import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { createCommonsMcpServer } from "../src/mcp/server";

interface ToolPayload {
  readonly [key: string]: unknown;
}

interface TestConnection {
  readonly client: Client;
  readonly server: McpServer;
  close(): Promise<void>;
}

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let operatorId: OperatorId;
let agentId: AgentId;
let token: string;
const clock = new Date("2026-11-15T00:00:00.000Z");
let agentNumber = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "commons-mcp-"));
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
    displayName: "Local MCP Operator",
  });
  operatorId = operator.id;
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(operator.id)
    .run();
  const actor = await createAgent(operator.id);
  agentId = actor.agentId;
  token = actor.token;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function createAgent(
  forOperatorId = operatorId,
): Promise<{ agentId: AgentId; token: string }> {
  const agent = await identity.registerAgent(forOperatorId, {
    displayName: `MCP Agent ${++agentNumber}`,
  });
  const credential = await credentials.issueCredential(agent.id, { label: "local-mcp-test" });
  return { agentId: agent.id, token: credential.token };
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    RATE_LIMIT_AGENT_LIMIT: 1000,
    RATE_LIMIT_OPERATOR_LIMIT: 1000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    NOW: () => clock,
    ...overrides,
  };
}

async function connectMcp(credential = token, bindings: unknown = env()): Promise<TestConnection> {
  const server = createCommonsMcpServer(bindings, credential);
  const client = new Client({ name: "commons-mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await client.callTool({ name, arguments: args })) as Record<string, unknown>;
}

function structured(result: Record<string, unknown>): ToolPayload {
  const value = result.structuredContent;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object-shaped MCP structured result.");
  }
  return value as ToolPayload;
}

function field(record: ToolPayload, name: string): ToolPayload {
  const value = record[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${name} to be an object.`);
  }
  return value as ToolPayload;
}

function errorCode(result: Record<string, unknown>): string | undefined {
  const error = field(structured(result), "error");
  return typeof error.code === "string" ? error.code : undefined;
}

function expectSafeOutput(value: unknown, secret: string) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("contentKey");
  expect(serialized).not.toContain("authorAgentId");
  expect(serialized).not.toContain("authorOperatorId");
  expect(serialized).not.toContain("contributorAgentId");
  expect(serialized).not.toContain("contributorOperatorId");
}

describe("local stdio MCP server", () => {
  it("discovers three tools and calls Knowledge and Execution search/get/contribute", async () => {
    const connection = await connectMcp();
    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "commons.contribute",
        "commons.get",
        "commons.search",
      ]);
      expect(tools.find((tool) => tool.name === "commons.search")?.description).toContain(
        "both Knowledge and Execution",
      );
      expect(tools.find((tool) => tool.name === "commons.get")?.description).toContain(
        "no latest alias",
      );
      expect(tools.find((tool) => tool.name === "commons.contribute")?.description).toContain(
        "expectedPreviousVersion",
      );

      const knowledge = {
        ...HTTPBIN_KNOWLEDGE_SEED,
        title: "MCP Knowledge httpbin response fields",
        explanation: "untrusted explanation for MCP retrieval",
      };
      const knowledgeCreated = await callTool(connection.client, "commons.contribute", {
        contribution: knowledge,
      });
      expect(knowledgeCreated.isError).toBeUndefined();
      const knowledgeMeta = field(structured(knowledgeCreated), "contribution");
      expect(knowledgeMeta.family).toBe("knowledge");
      expect(knowledgeMeta.version).toBe(1);

      const knowledgeId = knowledgeMeta.contributionId as string;
      const execution = {
        ...HTTPBIN_EXECUTION_SEED,
        title: "MCP Execution httpbin response check",
        related: [{ family: "knowledge", id: knowledgeId, version: 1 }],
      };
      const executionCreated = await callTool(connection.client, "commons.contribute", {
        contribution: execution,
      });
      const executionMeta = field(structured(executionCreated), "contribution");
      expect(executionMeta.family).toBe("execution");

      const searchCases = [
        { family: "knowledge", filters: { permittedUse: "redistribute" } },
        { family: "execution", filters: { sideEffect: "read-only" } },
        {},
      ];
      const searchResults: ToolPayload[] = [];
      for (const searchCase of searchCases) {
        const search = await callTool(connection.client, "commons.search", {
          query: "httpbin get",
          maxUtf8Bytes: 16_000,
          ...searchCase,
        });
        expect(search.isError).toBeUndefined();
        const data = field(structured(search), "data");
        const results = data.results as ToolPayload[];
        searchResults.push(...results);
      }
      expect(searchResults.some((result) => result.family === "knowledge")).toBe(true);
      expect(searchResults.some((result) => result.family === "execution")).toBe(true);
      const receiptsAfterSearch = await db
        .prepare("SELECT 1 FROM retrieval_receipts WHERE agent_id = ?")
        .bind(agentId)
        .all();
      expect(receiptsAfterSearch.results).toEqual([]);

      const knowledgeGet = await callTool(connection.client, "commons.get", {
        contributionId: knowledgeId,
        version: 1,
        maxUtf8Bytes: 64_000,
      });
      const knowledgeData = field(structured(knowledgeGet), "data");
      expect(knowledgeData.family).toBe("knowledge");
      expect(knowledgeData.untrustedExplanation).toEqual({
        label: "untrusted",
        text: "untrusted explanation for MCP retrieval",
      });
      const knowledgeReceipt = await db
        .prepare(
          "SELECT agent_id, contribution_id, version FROM retrieval_receipts WHERE agent_id = ? AND contribution_id = ? AND version = ?",
        )
        .bind(agentId, knowledgeId, 1)
        .first();
      expect(knowledgeReceipt).toEqual({
        agent_id: agentId,
        contribution_id: knowledgeId,
        version: 1,
      });

      const validatorMismatch = await callTool(connection.client, "commons.get", {
        contributionId: knowledgeId,
        version: 1,
        maxUtf8Bytes: 64_000,
        validator: {
          contributionId: knowledgeId,
          version: 1,
          contentHash: "0".repeat(64),
        },
      });
      expect(field(structured(validatorMismatch), "data").family).toBe("knowledge");

      const overBudgetGet = await callTool(connection.client, "commons.get", {
        contributionId: knowledgeId,
        version: 1,
        maxUtf8Bytes: 1,
      });
      expect(overBudgetGet.isError).toBe(true);
      expect(errorCode(overBudgetGet)).toBe("response_too_large");
      expect(structured(overBudgetGet).data).toBeUndefined();

      const executionGet = await callTool(connection.client, "commons.get", {
        contributionId: executionMeta.contributionId,
        version: 1,
        maxUtf8Bytes: 64_000,
        validator: {
          contributionId: executionMeta.contributionId,
          version: 1,
          contentHash: executionMeta.contentHash,
        },
      });
      expect(field(structured(executionGet), "data").schemaVersion).toBe(
        "retrieval-not-modified/v1",
      );
      const executionReceipt = await db
        .prepare(
          "SELECT 1 FROM retrieval_receipts WHERE agent_id = ? AND contribution_id = ? AND version = ?",
        )
        .bind(agentId, executionMeta.contributionId, 1)
        .first();
      expect(executionReceipt).toBeNull();

      const versionedKnowledge = await callTool(connection.client, "commons.contribute", {
        contributionId: knowledgeId,
        expectedPreviousVersion: 1,
        contribution: { ...knowledge, title: "MCP Knowledge version 2" },
      });
      expect(field(structured(versionedKnowledge), "contribution")).toMatchObject({
        version: 2,
        previousVersion: 1,
      });

      expectSafeOutput(
        {
          knowledgeCreated,
          executionCreated,
          searchResults,
          knowledgeGet,
          validatorMismatch,
          overBudgetGet,
          executionGet,
          versionedKnowledge,
        },
        token,
      );
    } finally {
      await connection.close();
    }
  });

  it("returns structured REST failures and rejects invalid tool arguments safely", async () => {
    const connection = await connectMcp();
    try {
      const invalidSearch = await callTool(connection.client, "commons.search", {
        query: "httpbin",
        family: "execution",
        filters: { sideEffect: "execute-shell" },
        maxUtf8Bytes: 16_000,
      });
      expect(invalidSearch.isError).toBe(true);
      expect(errorCode(invalidSearch)).toBe("invalid_search_request");

      const missingContribution = await callTool(connection.client, "commons.get", {
        contributionId: "missing-local-mcp-contribution",
        version: 1,
        maxUtf8Bytes: 64_000,
      });
      expect(missingContribution.isError).toBe(true);
      expect(errorCode(missingContribution)).toBe("not_found");

      const spoofedIdentity = await callTool(connection.client, "commons.contribute", {
        agentId,
        contribution: HTTPBIN_KNOWLEDGE_SEED,
      });
      expect(spoofedIdentity.isError).toBe(true);
      expect(errorCode(spoofedIdentity)).toBe("invalid_request");

      const invalidBudget = await callTool(connection.client, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 0,
      });
      expect(invalidBudget.isError).toBe(true);
      const tooSmallBudget = await callTool(connection.client, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 1,
      });
      expect(tooSmallBudget.isError).toBe(true);
      expect(errorCode(tooSmallBudget)).toBe("budget_too_small");
      expectSafeOutput(
        { invalidSearch, missingContribution, spoofedIdentity, invalidBudget, tooSmallBudget },
        token,
      );
    } finally {
      await connection.close();
    }
  });

  it("uses the credential only from process configuration and preserves allow-list rejection", async () => {
    const invalidCredential = "not-a-valid-agent-secret";
    const unauthorizedConnection = await connectMcp(invalidCredential);
    try {
      const unauthorized = await callTool(unauthorizedConnection.client, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 16_000,
      });
      expect(unauthorized.isError).toBe(true);
      expect(errorCode(unauthorized)).toBe("unauthorized");
      expectSafeOutput(unauthorized, invalidCredential);
    } finally {
      await unauthorizedConnection.close();
    }

    const blockedOperator = await identity.createOperator({
      kind: "organization",
      displayName: "Not Allow-Listed MCP Operator",
    });
    const blockedAgent = await createAgent(blockedOperator.id);
    const blockedConnection = await connectMcp(blockedAgent.token);
    try {
      const denied = await callTool(blockedConnection.client, "commons.contribute", {
        contribution: HTTPBIN_KNOWLEDGE_SEED,
      });
      expect(denied.isError).toBe(true);
      expect(errorCode(denied)).toBe("contribution_not_allowed");
      expectSafeOutput(denied, blockedAgent.token);
    } finally {
      await blockedConnection.close();
    }
  });

  it("shares per-agent and per-operator D1 rate limits with the REST routes", async () => {
    const agentLimited = await createAgent();
    const agentBindings = env({
      RATE_LIMIT_AGENT_LIMIT: 1,
      RATE_LIMIT_OPERATOR_LIMIT: 1000,
    });
    const acceptedRest = await worker.fetch(
      new Request("https://example.com/v1/commons/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agentLimited.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "httpbin", maxUtf8Bytes: 16_000 }),
      }),
      agentBindings,
    );
    expect(acceptedRest.status).toBe(200);
    const agentConnection = await connectMcp(agentLimited.token, agentBindings);
    try {
      const limited = await callTool(agentConnection.client, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 16_000,
      });
      expect(limited.isError).toBe(true);
      expect(errorCode(limited)).toBe("rate_limited");
    } finally {
      await agentConnection.close();
    }

    const sharedOperator = await identity.createOperator({
      kind: "organization",
      displayName: "MCP Shared Rate Limit Operator",
    });
    const firstAgent = await createAgent(sharedOperator.id);
    const secondAgent = await createAgent(sharedOperator.id);
    const operatorBindings = env({
      RATE_LIMIT_AGENT_LIMIT: 1000,
      RATE_LIMIT_OPERATOR_LIMIT: 1,
    });
    const firstResponse = await worker.fetch(
      new Request("https://example.com/v1/commons/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firstAgent.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "httpbin", maxUtf8Bytes: 16_000 }),
      }),
      operatorBindings,
    );
    expect(firstResponse.status).toBe(200);
    const operatorConnection = await connectMcp(secondAgent.token, operatorBindings);
    try {
      const limited = await callTool(operatorConnection.client, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 16_000,
      });
      expect(limited.isError).toBe(true);
      expect(errorCode(limited)).toBe("rate_limited");
    } finally {
      await operatorConnection.close();
    }
  });
});
