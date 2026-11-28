import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../src/identity/repository";
import { ContributionRegistry, type RegistryEnv } from "../src/registry/creation";
import { reconcile } from "../src/payments/reconcile";
import {
  cdpFacilitator,
  cdpJwt,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResult,
  type VerifyResult,
} from "../src/payments/x402";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

const START = Date.parse("2026-11-28T10:00:00.000Z");
const NOW_SECONDS = Math.floor(START / 1000);
const PAY_TO = `0x${"ab".repeat(20)}`;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const KNOWLEDGE_PRICE = 10_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let registry: ContributionRegistry;
let ownerOperator: string;
let ownerAgent: string;
let counter = 0;

/** A fake facilitator: answers are set per test; calls are counted. */
class FakeFacilitator implements Facilitator {
  verifyResult: VerifyResult = { isValid: true };
  settleResult: SettleResult | "throw" = {
    success: true,
    transaction: `0x${"cd".repeat(32)}`,
    network: "eip155:8453",
  };
  verifies = 0;
  settles = 0;
  async verify(): Promise<VerifyResult> {
    this.verifies++;
    return this.verifyResult;
  }
  async settle(): Promise<SettleResult> {
    this.settles++;
    if (this.settleResult === "throw") throw new Error("timeout");
    return this.settleResult;
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-x402-"));
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
  registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });
  const identity = new IdentityRepository(db);
  const operator = await identity.createOperator({ kind: "organization", displayName: "Owner" });
  await db
    .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
    .bind(operator.id)
    .run();
  const agent = await identity.registerAgent(operator.id, { displayName: "Owner agent" });
  ownerOperator = operator.id;
  ownerAgent = agent.id;
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** A new listed version; Knowledge is marked verified so its contributor share is due at once. */
async function record(family: "knowledge" | "execution", verified = true): Promise<string> {
  const seed = family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED;
  const created = await registry.createContribution(ownerAgent as never, {
    ...seed,
    title: `x402word ${family} ${++counter}`,
  } as never);
  if (!created.ok) throw new Error(created.error.code);
  const id = created.contribution.id;
  await listVersion(proxy.env, id);
  await db
    .prepare(
      `INSERT INTO version_trust (contribution_id, version, source_status, verified, updated_at)
       VALUES (?, 1, 'matched', ?, ?)
       ON CONFLICT (contribution_id, version) DO UPDATE SET verified = excluded.verified`,
    )
    .bind(id, verified ? 1 : 0, new Date(START).toISOString())
    .run();
  return id;
}

const wallet = () => `0x${(++counter).toString(16).padStart(40, "0")}`;
const nonce = () => `0x${(++counter).toString(16).padStart(64, "0")}`;

function signature(
  from: string,
  amount: number,
  options: { nonce?: string; payTo?: string; acceptedAmount?: number } = {},
): string {
  const payTo = options.payTo ?? PAY_TO;
  const payload = {
    x402Version: 2,
    resource: { url: "https://example.com/v1/x402/get" },
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: String(options.acceptedAmount ?? amount),
      asset: USDC,
      payTo,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
    },
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from,
        to: payTo,
        value: String(amount),
        validAfter: String(NOW_SECONDS - 10),
        validBefore: String(NOW_SECONDS + 300),
        nonce: options.nonce ?? nonce(),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

const decode = (header: string | null): Json =>
  JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")) as Json;

function env(facilitator: Facilitator, overrides: Json = {}): Json {
  return {
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    NOW: () => new Date(START),
    PAYMENTS: "live",
    DEPOSITS: "base",
    DEPOSIT_ADDRESS: PAY_TO,
    X402: "on",
    X402_FACILITATOR: facilitator,
    ...overrides,
  };
}

async function buy(
  facilitator: Facilitator,
  body: Json,
  paymentSignature?: string,
  overrides: Json = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paymentSignature !== undefined) headers["PAYMENT-SIGNATURE"] = paymentSignature;
  const response = await worker.fetch(
    new Request("https://example.com/v1/x402/get", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env(facilitator, overrides),
  );
  return { response, body: (await response.json()) as Json };
}

const target = (id: string, maxUtf8Bytes = 200_000) => ({ contributionId: id, version: 1, maxUtf8Bytes });

const accountOf = (address: string) =>
  db
    .prepare("SELECT operator_id, agent_id FROM wallet_accounts WHERE address = ?")
    .bind(address)
    .first<{ operator_id: string; agent_id: string }>();

describe("x402 paid retrieval", () => {
  it("offers a 402 with the price, our wallet and Bazaar metadata, without calling out", async () => {
    const facilitator = new FakeFacilitator();
    const id = await record("knowledge");
    const { response, body } = await buy(facilitator, target(id));
    expect(response.status).toBe(402);
    const offer = decode(response.headers.get("PAYMENT-REQUIRED"));
    expect(offer).toEqual(body);
    expect(offer.x402Version).toBe(2);
    expect(offer.accepts).toEqual([
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: String(KNOWLEDGE_PRICE),
        asset: USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
      },
    ]);
    expect(offer.resource.url).toBe("https://example.com/v1/x402/get");
    expect(offer.extensions.bazaar.info.input).toMatchObject({ method: "POST", bodyType: "json" });
    expect(facilitator.verifies).toBe(0);
  });

  it("settles, records the purchase and the contributor share, and serves the content", async () => {
    const facilitator = new FakeFacilitator();
    const id = await record("knowledge");
    const payer = wallet();
    const before = await db
      .prepare(
        "SELECT COALESCE(SUM(amount_minor), 0) AS n FROM ledger_entries WHERE agent_id = ? AND entry_type = 'contribution_revenue_share'",
      )
      .bind(ownerAgent)
      .first<{ n: number }>();

    const { response, body } = await buy(facilitator, target(id), signature(payer, KNOWLEDGE_PRICE));
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.schemaVersion).toBe("retrieval-response/v1");
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({
      success: true,
      transaction: `0x${"cd".repeat(32)}`,
      network: "eip155:8453",
      payer,
    });
    expect(facilitator.verifies).toBe(1);
    expect(facilitator.settles).toBe(1);

    const account = (await accountOf(payer))!;
    expect(account).not.toBeNull();
    const entries = await db
      .prepare(
        "SELECT entry_type, amount_minor FROM ledger_entries WHERE agent_id = ? ORDER BY entry_id",
      )
      .bind(account.agent_id)
      .all<{ entry_type: string; amount_minor: number }>();
    expect(entries.results.map((e) => e.entry_type)).toEqual([
      "operator_funding",
      "reservation",
      "purchase",
    ]);
    expect(entries.results.every((e) => e.amount_minor === KNOWLEDGE_PRICE)).toBe(true);
    const licence = await db
      .prepare("SELECT 1 FROM purchase_entitlements WHERE operator_id = ? AND contribution_id = ?")
      .bind(account.operator_id, id)
      .first();
    expect(licence).not.toBeNull();
    const after = await db
      .prepare(
        "SELECT COALESCE(SUM(amount_minor), 0) AS n FROM ledger_entries WHERE agent_id = ? AND entry_type = 'contribution_revenue_share'",
      )
      .bind(ownerAgent)
      .first<{ n: number }>();
    expect(after!.n - before!.n).toBe(KNOWLEDGE_PRICE / 2);
    const events = await db
      .prepare(
        "SELECT e.event FROM x402_payment_events e JOIN x402_payments p ON p.nonce = e.nonce WHERE p.payer = ? ORDER BY e.event_id",
      )
      .bind(payer)
      .all<{ event: string }>();
    expect(events.results.map((e) => e.event)).toEqual(["settled", "recorded"]);
    const operator = await db
      .prepare("SELECT contribution_allow_listed FROM operators WHERE id = ?")
      .bind(account.operator_id)
      .first<{ contribution_allow_listed: number }>();
    expect(operator!.contribution_allow_listed).toBe(0);

    // The same wallet again, with a fresh authorization: already licensed, so nothing is settled.
    const again = await buy(facilitator, target(id), signature(payer, KNOWLEDGE_PRICE));
    expect(again.response.status).toBe(200);
    expect(again.response.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(facilitator.settles).toBe(1);
  });

  it("refuses a replayed authorization", async () => {
    const facilitator = new FakeFacilitator();
    const payer = wallet();
    const used = nonce();
    const first = await buy(
      facilitator,
      target(await record("knowledge")),
      signature(payer, KNOWLEDGE_PRICE, { nonce: used }),
    );
    expect(first.response.status).toBe(200);
    const replay = await buy(
      facilitator,
      target(await record("knowledge")),
      signature(payer, KNOWLEDGE_PRICE, { nonce: used }),
    );
    expect(replay.response.status).toBe(409);
    expect(replay.body.error.code).toBe("payment_replayed");
    expect(facilitator.settles).toBe(1);
  });

  it("refuses a payment that does not match the offer before calling the facilitator", async () => {
    const facilitator = new FakeFacilitator();
    const id = await record("knowledge");
    const cases = [
      signature(wallet(), 1),
      signature(wallet(), KNOWLEDGE_PRICE, { payTo: `0x${"ef".repeat(20)}` }),
      signature(wallet(), KNOWLEDGE_PRICE, { acceptedAmount: 1 }),
      "not-base64!",
    ];
    for (const header of cases) {
      const { response } = await buy(facilitator, target(id), header);
      expect(response.status).toBe(402);
      expect(response.headers.get("PAYMENT-REQUIRED")).not.toBeNull();
    }
    expect(facilitator.verifies).toBe(0);
  });

  it("refuses a payment the facilitator rejects, creating no operator", async () => {
    const facilitator = new FakeFacilitator();
    facilitator.verifyResult = { isValid: false, invalidReason: "insufficient_funds" };
    const payer = wallet();
    const { response, body } = await buy(
      facilitator,
      target(await record("knowledge")),
      signature(payer, KNOWLEDGE_PRICE),
    );
    expect(response.status).toBe(402);
    expect(body.error).toBe("insufficient_funds");
    expect(await accountOf(payer)).toBeNull();
    expect(facilitator.settles).toBe(0);
  });

  it("records nothing when settlement is declined", async () => {
    const facilitator = new FakeFacilitator();
    facilitator.settleResult = {
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "eip155:8453",
    };
    const id = await record("knowledge");
    const payer = wallet();
    const { response, body } = await buy(facilitator, target(id), signature(payer, KNOWLEDGE_PRICE));
    expect(response.status).toBe(402);
    expect(body.error.code).toBe("payment_declined");
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: false });
    const account = (await accountOf(payer))!;
    const licence = await db
      .prepare("SELECT 1 FROM purchase_entitlements WHERE operator_id = ?")
      .bind(account.operator_id)
      .first();
    expect(licence).toBeNull();
  });

  it("flags a settlement with an unknown outcome for the owner", async () => {
    const facilitator = new FakeFacilitator();
    facilitator.settleResult = "throw";
    const { response, body } = await buy(
      facilitator,
      target(await record("knowledge")),
      signature(wallet(), KNOWLEDGE_PRICE),
    );
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("provider_unavailable");
    const report = await reconcile(db, () => new Date(START + 15 * 60_000));
    expect(report.alerts.map((a) => a.code)).toContain("x402_unrecorded");
  });

  it("checks the response size before settling", async () => {
    const facilitator = new FakeFacilitator();
    const { response } = await buy(
      facilitator,
      target(await record("knowledge"), 10),
      signature(wallet(), KNOWLEDGE_PRICE),
    );
    expect(response.status).toBe(413);
    expect(facilitator.settles).toBe(0);
  });

  it("does not settle while payments are stopped", async () => {
    const facilitator = new FakeFacilitator();
    const id = await record("knowledge");
    const at = new Date(START).toISOString();
    await db
      .prepare(
        "INSERT INTO platform_payment_controls (action, reason, set_by, created_at) VALUES ('stop', 'drill', 'test', ?)",
      )
      .bind(at)
      .run();
    try {
      const { response, body } = await buy(facilitator, target(id), signature(wallet(), KNOWLEDGE_PRICE));
      expect(response.status).toBe(503);
      expect(body.error.code).toBe("payments_stopped");
      expect(facilitator.settles).toBe(0);
    } finally {
      await db
        .prepare(
          "INSERT INTO platform_payment_controls (action, reason, set_by, created_at) VALUES ('start', 'drill over', 'test', ?)",
        )
        .bind(at)
        .run();
    }
  });

  it("serves only priced versions and only when switched on and configured", async () => {
    const facilitator = new FakeFacilitator();
    const free = await buy(facilitator, target(await record("execution", false)));
    expect(free.response.status).toBe(400);
    expect(free.body.error.code).toBe("not_priced");

    const id = await record("knowledge");
    expect((await buy(facilitator, target(id), undefined, { X402: undefined })).response.status).toBe(403);
    expect(
      (await buy(facilitator, target(id), undefined, { PAYMENTS: "sandbox", DEPOSITS: "base-sepolia" }))
        .response.status,
    ).toBe(503);
    expect(
      (await buy(facilitator, target(id), undefined, { X402_FACILITATOR: undefined })).response.status,
    ).toBe(503);
    expect(
      (await buy(facilitator, target(id), undefined, { PILOT_MODE: "read-only" })).response.status,
    ).toBe(403);
  });

  it("lets the contributor's own wallet read its content without paying", async () => {
    const facilitator = new FakeFacilitator();
    const id = await record("knowledge");
    const ownerWallet = wallet();
    await db
      .prepare(
        "INSERT INTO wallet_accounts (address, operator_id, agent_id, enrolled_at) VALUES (?, ?, ?, ?)",
      )
      .bind(ownerWallet, ownerOperator, ownerAgent, new Date(START).toISOString())
      .run();
    const { response } = await buy(facilitator, target(id), signature(ownerWallet, KNOWLEDGE_PRICE));
    expect(response.status).toBe(200);
    expect(facilitator.settles).toBe(0);
  });
});

describe("CDP facilitator client", () => {
  async function keyPair() {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const bytes = (s: string) => Buffer.from(s, "base64url");
    const secret = Buffer.concat([bytes(jwk.d!), bytes(jwk.x!)]).toString("base64");
    return { publicKey: pair.publicKey, secret };
  }

  it("signs an EdDSA JWT CDP accepts: claims, header and a valid signature", async () => {
    const { publicKey, secret } = await keyPair();
    const jwt = await cdpJwt("key-1", secret, "POST", "api.cdp.coinbase.com", "/platform/v2/x402/settle", new Date(START));
    const [header, claims, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
      alg: "EdDSA",
      kid: "key-1",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      sub: "key-1",
      iss: "cdp",
      nbf: NOW_SECONDS,
      exp: NOW_SECONDS + 120,
      uris: ["POST api.cdp.coinbase.com/platform/v2/x402/settle"],
    });
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      Buffer.from(sig!, "base64url"),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(ok).toBe(true);
  });

  it("posts the x402 request body with a bearer token and parses answers", async () => {
    const { secret } = await keyPair();
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const verify = url.endsWith("/verify");
      return Response.json(
        verify
          ? { isValid: true, payer: "0xabc" }
          : { success: true, transaction: `0x${"12".repeat(32)}`, network: "eip155:8453" },
      );
    }) as unknown as typeof fetch;
    const client = cdpFacilitator("key-1", secret, fake, () => new Date(START));
    const payload = { x402Version: 2 } as unknown as PaymentPayload;
    const requirements = { scheme: "exact" } as unknown as PaymentRequirements;
    expect(await client.verify(payload, requirements)).toEqual({ isValid: true, payer: "0xabc" });
    expect((await client.settle(payload, requirements)).success).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
      "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    ]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  });
});
