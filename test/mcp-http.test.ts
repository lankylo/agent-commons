import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { OperatorId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import { MCP_MAX_REQUEST_BYTES, resolveMcpHttpConfig } from "../src/mcp/http";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

type Payload = Record<string, unknown>;

const HOST = "commons.test";
const MCP_URL = `https://${HOST}/mcp`;
const clock = new Date("2026-11-15T00:00:00.000Z");

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let allowListed: OperatorId;
let agentNumber = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "commons-mcp-http-"));
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
  allowListed = await createOperator("MCP HTTP Allow-Listed Operator", true);
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function createOperator(name: string, allow: boolean): Promise<OperatorId> {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  if (allow) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
  }
  return operator.id;
}

async function createAgent(operatorId: OperatorId = allowListed) {
  const agent = await identity.registerAgent(operatorId, {
    displayName: `MCP HTTP Agent ${++agentNumber}`,
  });
  const credential = await credentials.issueCredential(agent.id, { label: "mcp-http-test" });
  return { agentId: agent.id as string, token: credential.token };
}

function env(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    EXECUTION_DOMAIN_POLICY_JSON: proxy.env.EXECUTION_DOMAIN_POLICY_JSON,
    KNOWLEDGE_PERMISSION_POLICY_JSON: proxy.env.KNOWLEDGE_PERMISSION_POLICY_JSON,
    RATE_LIMIT_AGENT_LIMIT: 1000,
    RATE_LIMIT_OPERATOR_LIMIT: 1000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    NOW: () => clock,
    MCP_HTTP: "on",
    MCP_ALLOWED_HOSTNAMES: HOST,
    ...overrides,
  };
}

const inflight = new Set<Promise<unknown>>();

/** Waits for requests the client sends in the background (for example its optional SSE GET). */
async function settle(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

/** Records every request the client sends so tests can prove the credential stays in the header. */
function recordingFetch(bindings: unknown, seen: Request[] = []) {
  return (url: string | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    seen.push(request.clone());
    const response = worker.fetch(request, bindings);
    inflight.add(response);
    void response.finally(() => inflight.delete(response)).catch(() => undefined);
    return response;
  };
}

async function connect(
  token: string | undefined,
  bindings: unknown = env(),
  options: { modern?: boolean; seen?: Request[] } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    fetch: recordingFetch(bindings, options.seen),
  });
  const client = new Client(
    { name: "commons-mcp-http-test", version: "1.0.0" },
    options.modern ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Payload): Promise<Payload> {
  return (await client.callTool({ name, arguments: args })) as Payload;
}

function structured(result: Payload): Payload {
  const value = result.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error("expected structured content");
  return value as Payload;
}

function errorCode(result: Payload): unknown {
  return (structured(result).error as Payload | undefined)?.code;
}

function post(body: unknown, headers: Record<string, string> = {}, bindings: unknown = env()) {
  return worker.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    bindings,
  );
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
};
const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

async function agentCount(agentId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_windows WHERE scope = ?")
    .bind(`agent:${agentId}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function totalCount(): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_windows")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("remote Streamable HTTP MCP endpoint", () => {
  it("serves discovery, both families, exact versions, contribution and feedback", async () => {
    const owner = await createAgent();
    const consumerOperator = await createOperator("MCP HTTP Consumer Operator", false);
    const consumer = await createAgent(consumerOperator);
    const seen: Request[] = [];
    const client = await connect(owner.token, env(), { seen });
    const consumerClient = await connect(consumer.token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "commons.contribute",
        "commons.feedback",
        "commons.get",
        "commons.search",
      ]);

      const knowledge = await call(client, "commons.contribute", {
        contribution: { ...HTTPBIN_KNOWLEDGE_SEED, title: "HTTP MCP Knowledge fixture" },
      });
      expect(knowledge.isError).toBeUndefined();
      const knowledgeMeta = structured(knowledge).contribution as Payload;
      expect(knowledgeMeta).toMatchObject({ family: "knowledge", version: 1 });
      const knowledgeId = knowledgeMeta.contributionId as string;

      const execution = await call(client, "commons.contribute", {
        contribution: { ...HTTPBIN_EXECUTION_SEED, title: "HTTP MCP Execution fixture" },
      });
      const executionMeta = structured(execution).contribution as Payload;
      expect(executionMeta).toMatchObject({ family: "execution", version: 1 });
      const executionId = executionMeta.contributionId as string;

      // Pending versions stay invisible: the shared visibility gate is preserved.
      const pendingGet = await call(consumerClient, "commons.get", {
        contributionId: knowledgeId,
        version: 1,
        maxUtf8Bytes: 64_000,
      });
      expect(errorCode(pendingGet)).toBe("not_found");

      const version2 = await call(client, "commons.contribute", {
        contributionId: knowledgeId,
        expectedPreviousVersion: 1,
        contribution: { ...HTTPBIN_KNOWLEDGE_SEED, title: "HTTP MCP Knowledge fixture v2" },
      });
      expect(structured(version2).contribution).toMatchObject({ version: 2, previousVersion: 1 });
      await listVersion(proxy.env, knowledgeId, 1);
      await listVersion(proxy.env, knowledgeId, 2);
      await listVersion(proxy.env, executionId, 1);

      const search = await call(consumerClient, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 64_000,
      });
      expect(search.isError).toBeUndefined();
      const families = new Set(
        ((structured(search).data as Payload).results as Payload[]).map((item) => item.family),
      );
      expect(families).toEqual(new Set(["knowledge", "execution"]));
      const executionOnly = await call(consumerClient, "commons.search", {
        query: "httpbin",
        family: "execution",
        maxUtf8Bytes: 64_000,
      });
      expect(
        ((structured(executionOnly).data as Payload).results as Payload[]).every(
          (r) => r.family === "execution",
        ),
      ).toBe(true);

      const exactV1 = await call(consumerClient, "commons.get", {
        contributionId: knowledgeId,
        version: 1,
        maxUtf8Bytes: 64_000,
      });
      const v1Data = structured(exactV1).data as Payload;
      expect(v1Data).toMatchObject({ family: "knowledge", version: 1 });
      expect((v1Data.content as Payload).title).toBe("HTTP MCP Knowledge fixture");
      const exactV2 = await call(consumerClient, "commons.get", {
        contributionId: knowledgeId,
        version: 2,
        maxUtf8Bytes: 64_000,
      });
      expect(structured(exactV2).data).toMatchObject({ version: 2 });

      const recipe = await call(consumerClient, "commons.get", {
        contributionId: executionId,
        version: 1,
        maxUtf8Bytes: 64_000,
      });
      expect(structured(recipe).data).toMatchObject({ family: "execution", version: 1 });

      const feedback = await call(consumerClient, "commons.feedback", {
        contributionId: knowledgeId,
        version: 1,
        assessment: {
          accuracy: {
            finding: "mixed",
            scope: "The documented response fields",
            evidence: [{ kind: "documentation", uri: "https://example.com/public-docs" }],
          },
        },
      });
      expect(feedback.isError).toBeUndefined();
      expect(structured(feedback)).toMatchObject({ accepted: true, contributionId: knowledgeId });

      // The contributor never retrieved v2 through this agent: feedback is refused.
      const ineligible = await call(client, "commons.feedback", {
        contributionId: executionId,
        version: 1,
        assessment: { outcome: { finding: "worked", scope: "x" } },
      });
      expect(ineligible.isError).toBe(true);

      // Non-allow-listed operators cannot contribute through HTTP either.
      const refused = await call(consumerClient, "commons.contribute", {
        contribution: HTTPBIN_KNOWLEDGE_SEED,
      });
      expect(errorCode(refused)).toBe("contribution_not_allowed");

      const outputs = JSON.stringify([knowledge, execution, search, exactV1, recipe, feedback]);
      expect(outputs).not.toContain(owner.token);
      expect(outputs).not.toContain(consumer.token);
      for (const request of seen) {
        expect(request.url).not.toContain(owner.token);
        expect(request.headers.get("Authorization")).toBe(`Bearer ${owner.token}`);
      }
    } finally {
      await client.close();
      await consumerClient.close();
    }
  });

  it("serves 2026-07-28 clients through version negotiation", async () => {
    const agent = await createAgent();
    const client = await connect(agent.token, env(), { modern: true });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(4);
      const search = await call(client, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 16_000,
      });
      expect(search.isError).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("charges each MCP request exactly once against the shared limiter", async () => {
    const agent = await createAgent();
    const seen: Request[] = [];
    const client = await connect(agent.token, env(), { seen });
    const expectOneChargePerRequest = async (action: () => Promise<unknown>) => {
      await settle();
      const requests = seen.length;
      const before = await agentCount(agent.agentId);
      await action();
      await settle();
      const sent = seen.length - requests;
      expect(sent).toBeGreaterThan(0);
      expect(await agentCount(agent.agentId)).toBe(before + sent);
    };
    try {
      await settle();
      expect(await agentCount(agent.agentId)).toBe(seen.length);
      await expectOneChargePerRequest(() =>
        call(client, "commons.search", { query: "httpbin", maxUtf8Bytes: 16_000 }),
      );
      // A warmed-up tool call is exactly one HTTP request and exactly one limiter charge.
      await expectOneChargePerRequest(async () => {
        const requests = seen.length;
        await call(client, "commons.search", { query: "httpbin", maxUtf8Bytes: 16_000 });
        expect(seen.length - requests).toBe(1);
      });
      await expectOneChargePerRequest(() => client.listTools());
      // Tool calls the SDK rejects before reaching the Worker are still charged once.
      await expectOneChargePerRequest(() =>
        call(client, "commons.get", { contributionId: "x" } as Payload),
      );
    } finally {
      await client.close();
    }

    const limited = await createAgent();
    // initialize + initialized notification consume the two allowed requests.
    const limitedClient = await connect(limited.token, env({ RATE_LIMIT_AGENT_LIMIT: 2 }));
    try {
      await expect(limitedClient.listTools()).rejects.toThrow();
    } finally {
      await limitedClient.close();
    }
    const raw = await post(
      listTools,
      { Authorization: `Bearer ${limited.token}` },
      env({ RATE_LIMIT_AGENT_LIMIT: 2 }),
    );
    expect(raw.status).toBe(429);
    expect(raw.headers.get("Retry-After")).not.toBeNull();
  });

  it("requires a valid Bearer credential on every request, including initialization", async () => {
    await expect(connect(undefined)).rejects.toThrow();
    const agent = await createAgent();
    const before = await totalCount();
    for (const body of [initialize, listTools]) {
      const missing = await post(body);
      expect(missing.status).toBe(401);
      expect(missing.headers.get("WWW-Authenticate")).toContain("Bearer");
      const wrongScheme = await post(body, { Authorization: `Basic ${agent.token}` });
      expect(wrongScheme.status).toBe(401);
      const invalid = await post(body, { Authorization: "Bearer not-a-real-credential" });
      expect(invalid.status).toBe(401);
      const text = await invalid.text();
      expect(text).not.toContain("not-a-real-credential");
      expect(text).not.toContain(agent.token);
    }
    // A credential in the URL is never accepted.
    const inUrl = await worker.fetch(
      new Request(`${MCP_URL}?token=${encodeURIComponent(agent.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialize),
      }),
      env(),
    );
    expect(inUrl.status).toBe(401);
    expect(await totalCount()).toBe(before);

    const revoked = await createAgent();
    const client = await connect(revoked.token);
    try {
      await db
        .prepare("UPDATE agent_credentials SET revoked_at = ? WHERE agent_id = ?")
        .bind(clock.toISOString(), revoked.agentId)
        .run();
      // An already-initialized session is re-authenticated on every request.
      await expect(client.listTools()).rejects.toThrow();
      const after = await post(listTools, { Authorization: `Bearer ${revoked.token}` });
      expect(after.status).toBe(401);
    } finally {
      await client.close();
    }
  });

  it("isolates credentials and bindings between concurrent agents", async () => {
    const allowed = await createAgent();
    const blockedOperator = await createOperator("MCP HTTP Blocked Operator", false);
    const blocked = await createAgent(blockedOperator);
    const allowedSeen: Request[] = [];
    const blockedSeen: Request[] = [];
    const [allowedClient, blockedClient] = await Promise.all([
      connect(allowed.token, env(), { seen: allowedSeen }),
      connect(blocked.token, env(), { seen: blockedSeen }),
    ]);
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          Promise.all([
            call(allowedClient, "commons.contribute", {
              contribution: { ...HTTPBIN_KNOWLEDGE_SEED, title: `Isolation allowed ${i}` },
            }),
            call(blockedClient, "commons.contribute", {
              contribution: { ...HTTPBIN_KNOWLEDGE_SEED, title: `Isolation blocked ${i}` },
            }),
          ]),
        ),
      );
      for (const [ok, denied] of results) {
        expect(ok.isError).toBeUndefined();
        expect(errorCode(denied)).toBe("contribution_not_allowed");
      }
      const authors = await db
        .prepare(
          "SELECT DISTINCT author_agent_id AS a FROM contribution_versions WHERE author_agent_id IN (?, ?)",
        )
        .bind(allowed.agentId, blocked.agentId)
        .all<{ a: string }>();
      expect(authors.results).toEqual([{ a: allowed.agentId }]);
      // Every request is charged once, to the agent that sent it and to no other agent.
      await settle();
      expect(await agentCount(allowed.agentId)).toBe(allowedSeen.length);
      expect(await agentCount(blocked.agentId)).toBe(blockedSeen.length);
      for (const request of allowedSeen) {
        expect(request.headers.get("Authorization")).toBe(`Bearer ${allowed.token}`);
      }
    } finally {
      await allowedClient.close();
      await blockedClient.close();
    }
  });

  it("is unavailable unless MCP_HTTP=on with a valid hostname allow-list", async () => {
    const agent = await createAgent();
    const auth = { Authorization: `Bearer ${agent.token}` };
    const before = await totalCount();
    for (const value of [undefined, "", "off"]) {
      const response = await post(initialize, auth, env({ MCP_HTTP: value }));
      expect(response.status).toBe(404);
    }
    for (const overrides of [
      { MCP_HTTP: "ON" },
      { MCP_HTTP: "true" },
      { MCP_ALLOWED_HOSTNAMES: undefined },
      { MCP_ALLOWED_HOSTNAMES: "" },
      { MCP_ALLOWED_HOSTNAMES: "https://commons.test" },
      { MCP_ALLOWED_HOSTNAMES: "commons.test:443" },
      { MCP_ALLOWED_HOSTNAMES: "*.commons.test" },
      { MCP_ALLOWED_HOSTNAMES: "Commons.Test" },
      { MCP_ALLOWED_HOSTNAMES: "commons.test,," },
    ]) {
      const response = await post(initialize, auth, env(overrides));
      expect(response.status).toBe(503);
    }
    expect(await totalCount()).toBe(before);
    expect(
      resolveMcpHttpConfig({ MCP_HTTP: "on", MCP_ALLOWED_HOSTNAMES: "a.test, b.test" }),
    ).toEqual({ state: "on", allowedHostnames: ["a.test", "b.test"] });
  });

  it("rejects disallowed Host and browser Origin before authentication", async () => {
    const agent = await createAgent();
    const before = await totalCount();
    const wrongHost = await worker.fetch(
      new Request("https://attacker.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(initialize),
      }),
      env(),
    );
    expect(wrongHost.status).toBe(403);
    const origin = await post(initialize, {
      Authorization: `Bearer ${agent.token}`,
      Origin: `https://${HOST}`,
    });
    expect(origin.status).toBe(403);
    const nullOrigin = await post(initialize, {
      Authorization: `Bearer ${agent.token}`,
      Origin: "null",
    });
    expect(nullOrigin.status).toBe(403);
    expect(await totalCount()).toBe(before);
  });

  it("rejects malformed, batched, oversized and unsupported requests", async () => {
    const agent = await createAgent();
    const auth = { Authorization: `Bearer ${agent.token}` };
    const parse = await post("{not json", auth);
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect((await post([initialize, listTools], auth)).status).toBe(400);
    expect((await post("42", auth)).status).toBe(400);
    expect(
      (await post({ jsonrpc: "2.0", id: 3, method: "subscriptions/listen", params: {} }, auth))
        .status,
    ).toBe(400);
    const oversized = await post(
      { ...listTools, params: { padding: "x".repeat(MCP_MAX_REQUEST_BYTES) } },
      auth,
    );
    expect(oversized.status).toBe(413);
    const streamed = await worker.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
            for (let i = 0; i < 20; i++) controller.enqueue(chunk);
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
      env(),
    );
    expect(streamed.status).toBe(413);
    const get = await worker.fetch(new Request(MCP_URL, { method: "GET", headers: auth }), env());
    expect(get.status).toBe(405);
    const wrongType = await post(JSON.stringify(initialize), {
      ...auth,
      "Content-Type": "text/plain",
    });
    expect(wrongType.status).toBe(415);
    const unknownTool = await post(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "commons.preview" } },
      auth,
    );
    const unknownText = await unknownTool.text();
    expect(unknownText).not.toContain(agent.token);
  });

  it("preserves read-only pilot mode and fails closed on invalid pilot settings", async () => {
    const agent = await createAgent();
    const readOnly = await connect(agent.token, env({ PILOT_MODE: "read-only" }));
    try {
      const search = await call(readOnly, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 16_000,
      });
      expect(search.isError).toBeUndefined();
      const contribute = await call(readOnly, "commons.contribute", {
        contribution: HTTPBIN_KNOWLEDGE_SEED,
      });
      expect(errorCode(contribute)).toBe("pilot_read_only");
      const feedback = await call(readOnly, "commons.feedback", {
        contributionId: "c",
        version: 1,
        assessment: {},
      });
      expect(errorCode(feedback)).toBe("pilot_read_only");
    } finally {
      await readOnly.close();
    }
    const invalid = await connect(agent.token, env({ PILOT_MODE: "maybe" }));
    try {
      const search = await call(invalid, "commons.search", {
        query: "httpbin",
        maxUtf8Bytes: 16_000,
      });
      expect(errorCode(search)).toBe("misconfigured");
    } finally {
      await invalid.close();
    }
  });
});
