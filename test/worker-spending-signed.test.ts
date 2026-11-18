import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegistryEnv } from "../src/registry/creation";
import { canonicalJson, formatUsdc } from "../src/enrollment/spending";
import { SpendingControls } from "../src/payments/spending-controls";
import worker from "../src/index";
import { personalSign, testWallet } from "./helpers/wallet";

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
const clock = new Date("2026-11-18T09:00:00.000Z");
let seed = 5000;
let ipSeq = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-spending-signed-"));
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Wallet = { key: Uint8Array; address: string };

const DOMAIN = "commons.example.org";
const URI = "https://commons.example.org/v1/enroll";
const baseEnv = (): Env => ({
  DB: db,
  CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
  NOW: () => clock,
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: DOMAIN,
  ENROLLMENT_URI: URI,
  ENROLLMENT_CHAIN_ID: "1",
  ENROLLMENT_IP_LIMIT: 10000,
  ENROLLMENT_ADDRESS_LIMIT: 10000,
  ENROLLMENT_GLOBAL_LIMIT: 10000,
});

async function call(path: string, body: unknown, env: Env = baseEnv()) {
  const res = await worker.fetch(
    new Request(`https://${DOMAIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": `203.0.113.${++ipSeq % 250}`,
      },
      body: JSON.stringify(body),
    }),
    env as never,
  );
  return { status: res.status, body: (await res.json()) as Json };
}

const newWallet = (): Wallet => testWallet(++seed);

/** Enrolls a fresh wallet and returns it with its operator and agent. */
async function enrolled() {
  const wallet = newWallet();
  const c = await call("/v1/enroll/challenge", { address: wallet.address, purpose: "enroll" });
  const message = c.body.message as string;
  const done = await call("/v1/enroll/complete", {
    message,
    signature: personalSign(message, wallet.key),
  });
  expect(done.status).toBe(201);
  return {
    wallet,
    operatorId: done.body.operatorId as string,
    agentId: done.body.agentId as string,
  };
}

const policyRequest = (overrides: Json = {}) => ({
  currency: "USDC",
  perTransactionLimitMinor: 50_000,
  dailyLimitMinor: 1_000_000,
  monthlyLimitMinor: 10_000_000,
  minimumReserveMinor: 0,
  maxAutonomousBalanceMinor: 100_000_000,
  permittedCategories: ["knowledge", "execution"],
  withdrawalsNeedApproval: true,
  ...overrides,
});

const challenge = (wallet: Wallet, purpose: string, request: unknown) =>
  call("/v1/enroll/spending-challenge", { address: wallet.address, purpose, request });

/** Gets a challenge for `request` and signs it with `signer` (the wallet itself by default). */
async function signed(wallet: Wallet, purpose: string, request: unknown, signer = wallet) {
  const c = await challenge(wallet, purpose, request);
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const message = c.body.message as string;
  return { message, signature: personalSign(message, signer.key), request };
}

const controls = () => new SpendingControls(db, () => clock);

describe("wallet-signed spending policy", () => {
  it("sets the policy of the wallet's own operator from a signed request", async () => {
    const { wallet, operatorId } = await enrolled();
    const request = policyRequest();
    const c = await challenge(wallet, "spending-policy", request);
    expect(c.status).toBe(201);
    expect(c.body.schemaVersion).toBe("wallet-action-challenge/v1");
    const message = c.body.message as string;
    // The wallet shows a readable summary; the request digest binds the exact request.
    expect(message).toContain("per purchase 0.05, per day 1, per month 10");
    expect(message).toContain("categories: knowledge, execution");
    expect(message).toContain("- urn:agent-commons:pilot-wallet:spending-policy");
    expect(message).toContain(`- urn:agent-commons:request:sha256:${c.body.requestDigest}`);

    const set = await call("/v1/enroll/spending-policy", {
      message,
      signature: personalSign(message, wallet.key),
      // Key order does not matter: the digest is over canonical JSON.
      request: Object.fromEntries(Object.entries(request).reverse()),
    });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body.schemaVersion).toBe("spending-policy/v1");
    expect(set.body.policy).toMatchObject({
      ...request,
      operatorId,
      setBy: `wallet:${wallet.address.toLowerCase()}`,
    });
    expect((await controls().currentPolicy(operatorId, "USDC"))?.perTransactionLimitMinor).toBe(
      50_000,
    );
  });

  it("refuses a changed request, a replay, the wrong signer and the wrong purpose", async () => {
    const { wallet, operatorId } = await enrolled();
    const body = await signed(wallet, "spending-policy", policyRequest());

    const changed = await call("/v1/enroll/spending-policy", {
      ...body,
      request: policyRequest({ perTransactionLimitMinor: 1_000_000 }),
    });
    expect(changed.status).toBe(401);
    expect(changed.body.error.code).toBe("request_mismatch");

    const other = newWallet();
    const forged = await signed(wallet, "spending-policy", policyRequest(), other);
    const wrongSigner = await call("/v1/enroll/spending-policy", forged);
    expect(wrongSigner.body.error.code).toBe("invalid_signature");

    const wrongPurpose = await call("/v1/enroll/spending-suspension", {
      message: body.message,
      signature: body.signature,
      request: { action: "suspend", agentId: null, reason: "test" },
    });
    expect(wrongPurpose.status).toBe(401);
    expect(await controls().currentPolicy(operatorId, "USDC")).toBeNull();

    expect((await call("/v1/enroll/spending-policy", body)).status).toBe(201);
    const replay = await call("/v1/enroll/spending-policy", body);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("invalid_challenge");
  });

  it("never accepts a sign-in message as an action", async () => {
    const { wallet } = await enrolled();
    const c = await call("/v1/enroll/challenge", { address: wallet.address, purpose: "rotate" });
    const message = c.body.message as string;
    const r = await call("/v1/enroll/spending-policy", {
      message,
      signature: personalSign(message, wallet.key),
      request: policyRequest(),
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("invalid_challenge");
  });

  it("validates the request before issuing a challenge", async () => {
    const { wallet, operatorId } = await enrolled();
    for (const [request, field] of [
      [policyRequest({ currency: "USD" }), "currency"],
      [policyRequest({ perTransactionLimitMinor: 2_000_000 }), "perTransactionLimitMinor"],
      [policyRequest({ permittedCategories: ["anything"] }), "permittedCategories"],
      [{ ...policyRequest(), operatorId }, "operatorId"],
      [
        Object.fromEntries(Object.entries(policyRequest()).filter(([k]) => k !== "currency")),
        "currency",
      ],
    ] as const) {
      const r = await challenge(wallet, "spending-policy", request);
      expect(r.status, field).toBe(400);
      expect(r.body.error.message).toContain(field);
    }
    expect((await challenge(newWallet(), "spending-policy", policyRequest())).status).toBe(404);
    expect((await challenge(wallet, "enroll", policyRequest())).status).toBe(400);
  });

  it("is off with enrollment", async () => {
    const r = await call(
      "/v1/enroll/spending-challenge",
      { address: newWallet().address, purpose: "spending-policy", request: policyRequest() },
      { ...baseEnv(), ENROLLMENT: "off" },
    );
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("enrollment_disabled");
  });
});

describe("wallet-signed suspension", () => {
  it("suspends and resumes every agent, or one agent, of the wallet's operator", async () => {
    const { wallet, operatorId, agentId } = await enrolled();
    const send = async (request: Json) =>
      call("/v1/enroll/spending-suspension", await signed(wallet, "spending-suspension", request));

    const all = await send({ action: "suspend", agentId: null, reason: "Lost a credential" });
    expect(all.status, JSON.stringify(all.body)).toBe(201);
    expect(all.body).toMatchObject({ schemaVersion: "spending-suspension/v1", action: "suspend" });
    expect(await controls().isSuspended(operatorId, agentId)).toBe(true);
    expect((await send({ action: "resume", agentId: null, reason: "Fixed" })).status).toBe(201);
    expect(await controls().isSuspended(operatorId, agentId)).toBe(false);

    expect((await send({ action: "suspend", agentId, reason: "Just this one" })).status).toBe(201);
    expect(await controls().isSuspended(operatorId, agentId)).toBe(true);
  });

  it("refuses an agent of another operator", async () => {
    const mine = await enrolled();
    const theirs = await enrolled();
    const r = await challenge(mine.wallet, "spending-suspension", {
      action: "suspend",
      agentId: theirs.agentId,
      reason: "not mine",
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("agent_not_found");
    expect(await controls().isSuspended(theirs.operatorId, theirs.agentId)).toBe(false);
  });

  it("keeps a long reason readable and the statement on one line", async () => {
    const { wallet } = await enrolled();
    const c = await challenge(wallet, "spending-suspension", {
      action: "suspend",
      agentId: null,
      reason: `Too\nmany ${"x".repeat(480)}`,
    });
    expect(c.status).toBe(201);
    const statement = (c.body.message as string).split("\n")[3]!;
    expect(statement.length).toBeLessThanOrEqual(300);
    expect(statement).toContain("Reason: Too many x");
    expect(statement.endsWith("...")).toBe(true);
  });
});

describe("helpers", () => {
  it("formats USDC base units and canonicalizes JSON", () => {
    expect(formatUsdc(10_000)).toBe("0.01");
    expect(formatUsdc(1_500_000)).toBe("1.5");
    expect(formatUsdc(0)).toBe("0");
    expect(canonicalJson({ b: [2, { d: 1, c: 2 }], a: null })).toBe(
      '{"a":null,"b":[2,{"c":2,"d":1}]}',
    );
  });
});
