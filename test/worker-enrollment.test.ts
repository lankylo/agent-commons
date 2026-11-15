import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegistryEnv } from "../src/registry/creation";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { personalSign, testWallet } from "./helpers/wallet";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let clock = new Date("2026-11-15T12:00:00.000Z");
let seed = 1000;
let ipSeq = 0;
let titleSeq = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-enrollment-"));
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
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

type Env = Record<string, unknown>;
const DOMAIN = "commons.example.org";
const URI = "https://commons.example.org/v1/enroll";
const baseEnv = (): Env => ({
  DB: db,
  CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
  EXECUTION_DOMAIN_POLICY_JSON: proxy.env.EXECUTION_DOMAIN_POLICY_JSON,
  KNOWLEDGE_PERMISSION_POLICY_JSON: proxy.env.KNOWLEDGE_PERMISSION_POLICY_JSON,
  NOW: () => clock,
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: DOMAIN,
  ENROLLMENT_URI: URI,
  ENROLLMENT_CHAIN_ID: "1",
  ENROLLMENT_IP_LIMIT: 10000,
  ENROLLMENT_ADDRESS_LIMIT: 10000,
  ENROLLMENT_GLOBAL_LIMIT: 10000,
  RATE_LIMIT_AGENT_LIMIT: 10000,
  RATE_LIMIT_OPERATOR_LIMIT: 10000,
  RATE_LIMIT_WINDOW_SECONDS: 60,
});

/** Storage stand-in that records any access, to prove configuration is checked first. */
function untouchable() {
  const touched: string[] = [];
  const DB = new Proxy(
    {},
    {
      get(_t, prop) {
        touched.push(String(prop));
        throw new Error("storage must not be touched");
      },
    },
  );
  return { touched, DB };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
async function call(
  path: string,
  body: unknown,
  options: { env?: Env; ip?: string; auth?: string; method?: string } = {},
): Promise<{ status: number; text: string; body: Json; headers: Headers }> {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("CF-Connecting-IP", options.ip ?? `198.51.100.${++ipSeq % 250}`);
  if (options.auth) headers.set("Authorization", `Bearer ${options.auth}`);
  const method = options.method ?? "POST";
  const res = await worker.fetch(
    new Request(`https://${DOMAIN}${path}`, {
      method,
      headers,
      ...(method === "POST"
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    }),
    (options.env ?? baseEnv()) as never,
  );
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    // non-JSON bodies (e.g. plain 404)
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

const newWallet = () => testWallet(++seed);
const challenge = (address: string, purpose = "enroll", options = {}) =>
  call("/v1/enroll/challenge", { address, purpose }, options);

async function signedChallenge(w: { key: Uint8Array; address: string }, purpose = "enroll") {
  const c = await challenge(w.address, purpose);
  expect(c.status).toBe(201);
  const message = c.body.message as string;
  // `nonce` is non-enumerable so it is never sent: request bodies accept only message+signature.
  const signed = { message, signature: personalSign(message, w.key) };
  return Object.defineProperty(signed, "nonce", {
    value: c.body.nonce as string,
  }) as typeof signed & {
    readonly nonce: string;
  };
}
const complete = (body: unknown, options = {}) => call("/v1/enroll/complete", body, options);
const rotate = (body: unknown, options = {}) => call("/v1/enroll/rotate", body, options);

async function enroll(w = newWallet()) {
  const r = await complete(await signedChallenge(w));
  expect(r.status).toBe(201);
  return { wallet: w, ...r.body } as Json & { wallet: typeof w };
}

const search = (token: string, env?: Env) =>
  call("/v1/commons/search", { query: "httpbin", maxUtf8Bytes: 64000 }, { auth: token, env });
const count = async (sql: string, ...binds: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...binds)
    .first<{ c: number }>())!.c;
const identityCounts = async () => ({
  operators: await count("SELECT count(*) AS c FROM operators WHERE ? = ?", 1, 1),
  agents: await count("SELECT count(*) AS c FROM agents WHERE ? = ?", 1, 1),
  credentials: await count("SELECT count(*) AS c FROM agent_credentials WHERE ? = ?", 1, 1),
});

describe("wallet enrollment: enablement and configuration", () => {
  it("is off by default and when off: 403 without storage access", async () => {
    for (const value of [undefined, "", "off"]) {
      const { touched, DB } = untouchable();
      for (const op of ["challenge", "complete", "rotate"]) {
        const r = await call(
          `/v1/enroll/${op}`,
          {},
          { env: { ...baseEnv(), DB, ENROLLMENT: value } },
        );
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe("enrollment_disabled");
        expect(r.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(touched).toEqual([]);
    }
  });

  it("fails closed (503) on incomplete or invalid configuration before storage access", async () => {
    const bad: Env[] = [
      { ENROLLMENT: "true" },
      { ENROLLMENT: "ON" },
      { ENROLLMENT_DOMAIN: undefined },
      { ENROLLMENT_DOMAIN: "" },
      { ENROLLMENT_DOMAIN: "bad domain" },
      { ENROLLMENT_DOMAIN: "https://commons.example.org" },
      { ENROLLMENT_URI: undefined },
      { ENROLLMENT_URI: "not a uri" },
      { ENROLLMENT_URI: "http://commons.example.org/v1/enroll" },
      { ENROLLMENT_URI: "https://other.example.org/v1/enroll" },
      { ENROLLMENT_URI: "https://commons.example.org/v1/enroll?x=1" },
      { ENROLLMENT_URI: "https://commons.example.org" },
      { ENROLLMENT_CHAIN_ID: undefined },
      { ENROLLMENT_CHAIN_ID: "0" },
      { ENROLLMENT_CHAIN_ID: "-1" },
      { ENROLLMENT_CHAIN_ID: "abc" },
      { ENROLLMENT_CHAIN_ID: 1.5 },
      { ENROLLMENT_CHALLENGE_TTL_SECONDS: "10" },
      { ENROLLMENT_CHALLENGE_TTL_SECONDS: "100000" },
      { ENROLLMENT_IP_LIMIT: "0" },
      { ENROLLMENT_ADDRESS_LIMIT: "x" },
      { ENROLLMENT_GLOBAL_LIMIT: -5 },
    ];
    for (const override of bad) {
      const { touched, DB } = untouchable();
      const r = await challenge(newWallet().address, "enroll", {
        env: { ...baseEnv(), DB, ...override },
      });
      expect(r.status, JSON.stringify(override)).toBe(503);
      expect(r.body.error.code).toBe("misconfigured");
      expect(touched).toEqual([]);
    }
    const noDb = await challenge(newWallet().address, "enroll", {
      env: { ...baseEnv(), DB: undefined },
    });
    expect(noDb.status).toBe(503);
  });

  it("accepts a localhost http URI for local development", async () => {
    const env = {
      ...baseEnv(),
      ENROLLMENT_DOMAIN: "localhost:8787",
      ENROLLMENT_URI: "http://localhost:8787/",
    };
    const r = await challenge(newWallet().address, "enroll", { env });
    expect(r.status).toBe(201);
    expect(r.body.message).toMatch(/^localhost:8787 wants you to sign in/);
  });

  it("returns 404 for unknown enrollment paths and non-POST methods", async () => {
    expect((await call("/v1/enroll/other", {})).status).toBe(404);
    expect((await call("/v1/enroll/challenge", {}, { method: "GET" })).status).toBe(404);
  });
});

describe("wallet enrollment: challenge", () => {
  it("issues a server-generated ERC-4361 message with a one-time nonce, no-store", async () => {
    const w = newWallet();
    const r = await challenge(w.address.toUpperCase().replace("0X", "0x"));
    expect(r.status).toBe(201);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.body).toMatchObject({ schemaVersion: "wallet-challenge/v1", purpose: "enroll" });
    const message = r.body.message as string;
    expect(message).toContain(`URI: ${URI}\nVersion: 1\nChain ID: 1\nNonce: ${r.body.nonce}`);
    expect(message).toContain("Issued At: 2026-11-15T");
    expect(r.body.expiresAt).toBe(new Date(clock.getTime() + 300_000).toISOString());
    const row = await db
      .prepare("SELECT * FROM wallet_challenges WHERE nonce = ?")
      .bind(r.body.nonce)
      .first<Json>();
    expect(row).toMatchObject({ address: w.address, purpose: "enroll", consumed_at: null });
    expect(Object.keys(row!).sort()).toEqual(
      [
        "address",
        "consumed_at",
        "expires_at",
        "issued_at",
        "message_digest",
        "nonce",
        "purpose",
      ].sort(),
    );
  });

  it("rejects invalid addresses, purposes and any caller-supplied identity fields", async () => {
    const w = newWallet();
    for (const address of ["0x123", "nope", "0x" + "0".repeat(40), 7]) {
      expect((await challenge(address as string)).body.error.code).toBe("invalid_address");
    }
    const badChecksum = "0x7E5F4552091A69125d5DfCb7b8C2659029395BdF";
    expect((await challenge(badChecksum)).status).toBe(400);
    expect((await challenge(w.address, "pay")).status).toBe(400);
    for (const extra of [{ operatorId: "op_x" }, { agentId: "ag_x" }, { privateKey: "0x01" }]) {
      const r = await call("/v1/enroll/challenge", { address: w.address, ...extra });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
    }
    expect((await call("/v1/enroll/challenge", "not json")).status).toBe(400);
    expect((await call("/v1/enroll/challenge", { address: "x".repeat(5000) })).status).toBe(413);
  });
});

describe("wallet enrollment: complete", () => {
  it("enrolls a new wallet: one operator, one agent, one credential returned once", async () => {
    const before = await identityCounts();
    const w = newWallet();
    const signed = await signedChallenge(w);
    const r = await complete(signed);
    expect(r.status).toBe(201);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.body).toMatchObject({
      schemaVersion: "wallet-enrollment/v1",
      status: "enrolled",
      credentialIssued: true,
    });
    const token = r.body.credential.token as string;
    expect(token).toMatch(/^ac1_[0-9a-f]{24}_[0-9a-f]{64}$/);
    expect(await identityCounts()).toEqual({
      operators: before.operators + 1,
      agents: before.agents + 1,
      credentials: before.credentials + 1,
    });

    const account = await db
      .prepare("SELECT * FROM wallet_accounts WHERE address = ?")
      .bind(w.address)
      .first<Json>();
    expect(account).toMatchObject({ operator_id: r.body.operatorId, agent_id: r.body.agentId });
    const op = await db
      .prepare("SELECT * FROM operators WHERE id = ?")
      .bind(r.body.operatorId)
      .first<Json>();
    expect(op).toMatchObject({ status: "active", contribution_allow_listed: 1 });
    expect(JSON.stringify(op)).not.toContain(w.address.slice(2));
    const agent = await db
      .prepare("SELECT operator_id FROM agents WHERE id = ?")
      .bind(r.body.agentId)
      .first<Json>();
    expect(agent!.operator_id).toBe(r.body.operatorId);

    // Only the digest is stored; the token is usable on the existing authenticated path.
    const stored = await db
      .prepare("SELECT * FROM agent_credentials WHERE agent_id = ?")
      .bind(r.body.agentId)
      .all<Json>();
    expect(JSON.stringify(stored.results)).not.toContain(token.slice(29));
    expect((await search(token)).status).toBe(200);

    const consumed = await db
      .prepare("SELECT consumed_at FROM wallet_challenges WHERE nonce = ?")
      .bind(signed.nonce)
      .first<Json>();
    expect(consumed!.consumed_at).toBe(clock.toISOString());
  });

  it("repeat enrollment resolves to the same operator without minting agents or credentials", async () => {
    const first = await enroll();
    const before = await identityCounts();
    const again = await complete(await signedChallenge(first.wallet));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      status: "already_enrolled",
      operatorId: first.operatorId,
      agentId: first.agentId,
      credentialIssued: false,
    });
    expect(again.text).not.toMatch(/ac1_/);
    expect(await identityCounts()).toEqual(before);
    expect((await search(first.credential.token)).status).toBe(200);
  });

  it("concurrent first enrollments of one wallet yield one operator, agent and credential", async () => {
    const w = newWallet();
    const before = await identityCounts();
    const signed = await Promise.all([1, 2, 3, 4].map(() => signedChallenge(w)));
    const results = await Promise.all(signed.map((s) => complete(s)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 201]);
    const operatorIds = new Set(results.map((r) => r.body.operatorId));
    const agentIds = new Set(results.map((r) => r.body.agentId));
    expect(operatorIds.size).toBe(1);
    expect(agentIds.size).toBe(1);
    expect(await identityCounts()).toEqual({
      operators: before.operators + 1,
      agents: before.agents + 1,
      credentials: before.credentials + 1,
    });
    expect(
      await count("SELECT count(*) AS c FROM wallet_accounts WHERE address = ?", w.address),
    ).toBe(1);
  });

  it("enrolls many distinct wallets with no wallet cap", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await enroll()).operatorId as string);
    expect(ids.size).toBe(5);
  });

  it("rejects invalid, mismatched and malformed signatures without consuming the nonce", async () => {
    const w = newWallet();
    const other = newWallet();
    const before = await identityCounts();
    const signed = await signedChallenge(w);
    const wrongKey = await complete({
      ...signed,
      signature: personalSign(signed.message, other.key),
    });
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.body.error.code).toBe("invalid_signature");
    for (const signature of ["0x1234", signed.signature.slice(0, -2) + "1f", "zz"]) {
      const r = await complete({ ...signed, signature });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("invalid_signature");
    }
    expect((await complete({ message: signed.message })).status).toBe(400);
    expect((await complete({ ...signed, operatorId: "op_attacker" })).status).toBe(400);
    expect((await complete({ ...signed, agentId: "ag_attacker" })).status).toBe(400);
    expect(await identityCounts()).toEqual(before);
    // The genuine signature still works afterwards: failed attempts do not burn the nonce.
    expect((await complete(signed)).status).toBe(201);
  });

  it("rejects a challenge issued for one address but signed by another wallet", async () => {
    const victim = newWallet();
    const attacker = newWallet();
    const c = await challenge(victim.address);
    const r = await complete({
      message: c.body.message,
      signature: personalSign(c.body.message as string, attacker.key),
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("invalid_signature");
    expect(
      await count(
        "SELECT count(*) AS c FROM wallet_accounts WHERE address IN (?, ?)",
        victim.address,
        attacker.address,
      ),
    ).toBe(0);
  });

  it("rejects replay of a consumed challenge", async () => {
    const w = newWallet();
    const signed = await signedChallenge(w);
    expect((await complete(signed)).status).toBe(201);
    const replay = await complete(signed);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("invalid_challenge");
  });

  it("rejects expired challenges", async () => {
    const w = newWallet();
    const signed = await signedChallenge(w);
    const saved = clock;
    try {
      clock = new Date(saved.getTime() + 300_000);
      const r = await complete(signed);
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("challenge_expired");
    } finally {
      clock = saved;
    }
    expect(
      await count("SELECT count(*) AS c FROM wallet_accounts WHERE address = ?", w.address),
    ).toBe(0);
  });

  it("rejects altered or fabricated messages even when correctly signed by the wallet", async () => {
    const w = newWallet();
    const { message } = await signedChallenge(w);
    const later = new Date(clock.getTime() + 600_000).toISOString();
    const alterations = [
      message.replace(/Expiration Time: .*/, `Expiration Time: ${later}`),
      message.replace(/Nonce: [0-9a-f]{32}/, `Nonce: ${"a".repeat(32)}`),
      message.replace(`URI: ${URI}`, "URI: https://commons.example.org/other"),
      message.replace(DOMAIN, "evil.example.org"),
      message.replace("Chain ID: 1", "Chain ID: 137"),
      message.replace("pilot-wallet:enroll", "pilot-wallet:rotate"),
      message + "\nRequest ID: 1",
      message.replace(/Issued At: .*/, `Issued At: ${later}`),
    ];
    for (const altered of alterations) {
      const r = await complete({ message: altered, signature: personalSign(altered, w.key) });
      expect(r.status, altered).toBe(401);
      expect(["invalid_challenge", "challenge_expired"]).toContain(r.body.error.code);
    }
    // Same message under a different configured chain, domain or URI is rejected.
    for (const override of [
      { ENROLLMENT_CHAIN_ID: "137" },
      {
        ENROLLMENT_DOMAIN: "other.example.org",
        ENROLLMENT_URI: "https://other.example.org/v1/enroll",
      },
      { ENROLLMENT_URI: "https://commons.example.org/v2/enroll" },
    ]) {
      const r = await complete(
        { message, signature: personalSign(message, w.key) },
        { env: { ...baseEnv(), ...override } },
      );
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("invalid_challenge");
    }
    expect(
      await count("SELECT count(*) AS c FROM wallet_accounts WHERE address = ?", w.address),
    ).toBe(0);
  });

  it("rejects a rotation challenge submitted for enrollment and vice versa", async () => {
    const w = newWallet();
    const rot = await signedChallenge(w, "rotate");
    expect((await complete(rot)).body.error.code).toBe("invalid_challenge");
    const enr = await signedChallenge(w, "enroll");
    expect((await rotate(enr)).body.error.code).toBe("invalid_challenge");
  });
});

describe("wallet enrollment: rate limits", () => {
  it("limits challenge requests per client IP with Retry-After", async () => {
    const env = { ...baseEnv(), ENROLLMENT_IP_LIMIT: 2 };
    const ip = "203.0.113.7";
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await challenge(newWallet().address, "enroll", { env, ip }));
    }
    expect(results.map((r) => r.status)).toEqual([201, 201, 429]);
    expect(results[2]!.body.error.code).toBe("rate_limited");
    expect(Number(results[2]!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(
      (await challenge(newWallet().address, "enroll", { env, ip: "203.0.113.8" })).status,
    ).toBe(201);
    // Enrollment attempts from the same IP share the bound.
    expect((await complete({}, { env, ip })).status).toBe(429);
    // Raw IPs are not stored in counter keys.
    expect(
      await count("SELECT count(*) AS c FROM rate_limit_windows WHERE scope LIKE ?", "%203.0.113%"),
    ).toBe(0);
  });

  it("limits enrollment attempts per wallet address", async () => {
    const env = { ...baseEnv(), ENROLLMENT_ADDRESS_LIMIT: 3 };
    const w = newWallet();
    const c = await challenge(w.address, "enroll", { env });
    const bad = {
      message: c.body.message,
      signature: personalSign(c.body.message as string, newWallet().key),
    };
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await complete(bad, { env })).status);
    // 1 challenge + 2 attempts fit the limit of 3; the third attempt is limited.
    expect(statuses).toEqual([401, 401, 429]);
  });

  it("applies a global bound across all clients", async () => {
    const saved = clock;
    clock = new Date(saved.getTime() + 3_600_000); // fresh window
    try {
      const env = { ...baseEnv(), ENROLLMENT_GLOBAL_LIMIT: 2 };
      const statuses = [];
      for (let i = 0; i < 3; i++)
        statuses.push((await challenge(newWallet().address, "enroll", { env })).status);
      expect(statuses).toEqual([201, 201, 429]);
    } finally {
      clock = saved;
    }
  });
});

describe("wallet enrollment: credential rotation", () => {
  it("rotates: revokes prior credentials, issues one new credential, preserves binding", async () => {
    const first = await enroll();
    const oldToken = first.credential.token as string;
    const r = await rotate(await signedChallenge(first.wallet, "rotate"));
    expect(r.status).toBe(201);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.body).toMatchObject({
      schemaVersion: "wallet-credential-rotation/v1",
      operatorId: first.operatorId,
      agentId: first.agentId,
      revokedCredentials: 1,
    });
    const newToken = r.body.credential.token as string;
    expect(newToken).not.toBe(oldToken);
    expect((await search(oldToken)).status).toBe(401);
    expect((await search(newToken)).status).toBe(200);
    expect(
      await count("SELECT count(*) AS c FROM agents WHERE operator_id = ?", first.operatorId),
    ).toBe(1);
    // A later repeat enrollment still resolves to the same operator and agent.
    const again = await complete(await signedChallenge(first.wallet));
    expect(again.body).toMatchObject({ operatorId: first.operatorId, agentId: first.agentId });
  });

  it("rejects rotation for an unenrolled wallet and for a suspended operator", async () => {
    const w = newWallet();
    const r = await rotate(await signedChallenge(w, "rotate"));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_enrolled");

    const e = await enroll();
    await db
      .prepare("UPDATE operators SET status = 'suspended' WHERE id = ?")
      .bind(e.operatorId)
      .run();
    const before = await identityCounts();
    const s = await rotate(await signedChallenge(e.wallet, "rotate"));
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe("identity_inactive");
    expect(await identityCounts()).toEqual(before);
    expect(
      await count(
        "SELECT count(*) AS c FROM agent_credentials WHERE agent_id = ? AND revoked_at IS NULL",
        e.agentId,
      ),
    ).toBe(1);
  });

  it("keeps the wallet and agent-to-operator bindings immutable", async () => {
    const e = await enroll();
    const other = await enroll();
    await expect(
      db
        .prepare("UPDATE wallet_accounts SET operator_id = ? WHERE address = ?")
        .bind(other.operatorId, e.wallet.address)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.prepare("DELETE FROM wallet_accounts WHERE address = ?").bind(e.wallet.address).run(),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      db
        .prepare("UPDATE agents SET operator_id = ? WHERE id = ?")
        .bind(other.operatorId, e.agentId)
        .run(),
    ).rejects.toThrow();
  });
});

describe("wallet enrollment: pilot behavior", () => {
  const contribution = (family: "knowledge" | "execution") => ({
    ...(family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED),
    title: `wallet pilot ${family} ${++titleSeq}`,
  });

  it("read-only pilot mode: enrollment and search work, contribute stays disabled", async () => {
    const env = { ...baseEnv(), PILOT_MODE: "read-only" };
    const w = newWallet();
    const c = await challenge(w.address, "enroll", { env });
    const r = await complete(
      { message: c.body.message, signature: personalSign(c.body.message as string, w.key) },
      { env },
    );
    expect(r.status).toBe(201);
    const token = r.body.credential.token as string;
    expect((await search(token, env)).status).toBe(200);
    const contribute = await call(
      "/v1/commons/contribute",
      { contribution: contribution("knowledge") },
      { auth: token, env },
    );
    expect(contribute.status).toBe(403);
    expect(contribute.body.error.code).toBe("pilot_read_only");
  });

  for (const family of ["knowledge", "execution"] as const) {
    it(`${family}: enrolled operator contributions stay pending and invisible to consumers`, async () => {
      const author = await enroll();
      const consumer = await enroll();
      const token = author.credential.token as string;
      const input = contribution(family);
      const created = await call(
        "/v1/commons/contribute",
        { contribution: input },
        { auth: token },
      );
      expect(created.status).toBe(200);
      const id = created.body.contribution.contributionId as string;
      const state = await db
        .prepare(
          "SELECT state FROM version_quality_states WHERE contribution_id = ? AND version = 1",
        )
        .bind(id)
        .first<Json>();
      expect(state!.state).toBe("pending");

      const get = await call(
        "/v1/commons/get",
        { contributionId: id, version: 1, maxUtf8Bytes: 64000 },
        { auth: consumer.credential.token },
      );
      expect(get.status).toBe(404);
      const found = await call(
        "/v1/commons/search",
        { query: input.title, maxUtf8Bytes: 64000 },
        { auth: consumer.credential.token },
      );
      expect(found.status).toBe(200);
      expect(found.text).not.toContain(id);
      const preview = await call(
        "/v1/commons/preview",
        { contributionId: id, version: 1, maxUtf8Bytes: 64000 },
        { auth: token },
      );
      expect(preview.status).toBe(200);
      expect(preview.body.quality).toMatchObject({ state: "pending" });
      // No automatic approval: no reviewer decision or capacity place was recorded.
      expect(
        await count(
          "SELECT count(*) AS c FROM version_quality_decisions WHERE contribution_id = ?",
          id,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS c FROM pilot_capacity_places WHERE contribution_id = ?",
          id,
        ),
      ).toBe(0);
    });
  }
});
