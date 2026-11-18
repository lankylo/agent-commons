import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import type { RegistryEnv } from "../src/registry/creation";
import { Ledger } from "../src/payments/ledger";
import { NETWORKS, TRANSFER_TOPIC, type RpcCall } from "../src/payments/chain";
import { SpendingControls } from "../src/payments/spending-controls";
import worker from "../src/index";
import { personalSign, testWallet } from "./helpers/wallet";

// Test-only placeholder, not a real credential.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const START = Date.parse("2026-11-18T14:00:00.000Z");
const SEPOLIA = NETWORKS["base-sepolia"];
const PLATFORM = "0x00000000000000000000000000000000000000aa";
const DOMAIN = "commons.example.org";

interface Actor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  readonly token: string;
  readonly wallet: { key: Uint8Array; address: string };
  readonly destination: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let counter = 0;
let seed = 7000;

/** A fake Base Sepolia node: receipts by hash, a head block and canonical block hashes. */
const chain = {
  head: 5000,
  receipts: new Map<string, Json>(),
  canonical: new Map<number, string>(),
};
const RPC: RpcCall = async (method, params) => {
  switch (method) {
    case "eth_chainId":
      return `0x${SEPOLIA.chainId.toString(16)}`;
    case "eth_blockNumber":
      return `0x${chain.head.toString(16)}`;
    case "eth_getTransactionReceipt":
      return chain.receipts.get(String(params[0])) ?? null;
    case "eth_getBlockByNumber": {
      const hash = chain.canonical.get(Number(BigInt(String(params[0]))));
      return hash ? { hash } : null;
    }
    default:
      throw new Error(`unexpected ${method}`);
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-payouts-"));
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
  credentials = new CredentialService(db, { now: () => new Date(START) });
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const pad = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

/** An operator with an enrolled wallet, one funded agent and a spending policy. */
async function operator(name: string, options: { autoApprove?: boolean; fund?: number } = {}) {
  const op = await identity.createOperator({ kind: "individual", displayName: name });
  const agent = await identity.registerAgent(op.id, { displayName: `${name} ${++counter}` });
  const token = (await credentials.issueCredential(agent.id, { label: name })).token;
  const wallet = testWallet(++seed);
  const destination = wallet.address.toLowerCase();
  await db
    .prepare(
      "INSERT INTO wallet_accounts (address, operator_id, agent_id, enrolled_at) VALUES (?, ?, ?, ?)",
    )
    .bind(destination, op.id, agent.id, new Date(START).toISOString())
    .run();
  const funded = await new Ledger(db, () => new Date(START)).append([
    {
      idempotencyKey: `fund-${++counter}-payouts`,
      agentId: agent.id,
      operatorId: op.id,
      entryType: "operator_funding",
      amountMinor: options.fund ?? 10_000_000,
      currency: "USDC",
    },
  ]);
  expect(funded.ok).toBe(true);
  const set = await new SpendingControls(db, () => new Date(START)).setPolicy({
    operatorId: op.id,
    currency: "USDC",
    perTransactionLimitMinor: 1_000_000,
    dailyLimitMinor: 1_000_000,
    monthlyLimitMinor: 1_000_000,
    minimumReserveMinor: 1_000_000,
    maxAutonomousBalanceMinor: 100_000_000,
    permittedCategories: ["knowledge"],
    withdrawalsNeedApproval: !options.autoApprove,
    setBy: "test",
  });
  expect(set.ok).toBe(true);
  return { agentId: agent.id, operatorId: op.id, token, wallet, destination } as Actor;
}

/** Puts a mined USDC transfer from the platform wallet on the fake chain. */
function mine(to: string, amount: number, options: { from?: string; block?: number } = {}) {
  const txHash = `0x${hex(++counter, 64)}`;
  const block = options.block ?? chain.head - 10;
  const blockHash = `0x${hex(block, 64)}`;
  chain.canonical.set(block, blockHash);
  chain.receipts.set(txHash, {
    status: "0x1",
    blockNumber: `0x${block.toString(16)}`,
    blockHash,
    transactionHash: txHash,
    logs: [
      {
        address: SEPOLIA.usdc,
        topics: [TRANSFER_TOPIC, pad(options.from ?? PLATFORM), pad(to)],
        data: `0x${hex(amount, 64)}`,
        logIndex: "0x0",
      },
    ],
  });
  return txHash;
}

const env = (extra: Json = {}) =>
  ({
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    NOW: () => new Date(START),
    RATE_LIMIT_AGENT_LIMIT: 100000,
    RATE_LIMIT_OPERATOR_LIMIT: 100000,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    REVIEW_INTERFACE: "on",
    REVIEWER_ID: "pilot-reviewer",
    REVIEWER_TOKEN: TOKEN,
    ENROLLMENT: "on",
    ENROLLMENT_DOMAIN: DOMAIN,
    ENROLLMENT_URI: `https://${DOMAIN}/v1/enroll`,
    ENROLLMENT_CHAIN_ID: "1",
    ENROLLMENT_IP_LIMIT: 10000,
    ENROLLMENT_ADDRESS_LIMIT: 10000,
    ENROLLMENT_GLOBAL_LIMIT: 10000,
    PAYMENTS: "sandbox",
    DEPOSITS: "base-sepolia",
    DEPOSIT_ADDRESS: PLATFORM,
    CHAIN_RPC: RPC,
    ...extra,
  }) as never;

async function post(path: string, body: unknown, token?: string, extra: Json = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": `203.0.113.${++counter % 250}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await worker.fetch(
    new Request(`https://${DOMAIN}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env(extra),
  );
  return { status: response.status, body: (await response.json()) as Json };
}
const requestPayout = (a: Actor, amountMinor: number, idempotencyKey = `payout-${++counter}-key`) =>
  post("/v1/commons/payout", { amountMinor, idempotencyKey }, a.token);
const review = (op: string, body: Json = {}) => post(`/v1/review/${op}`, body, TOKEN);
const balances = async (a: Actor) =>
  Object.assign(
    { pending: 0, available: 0, reserved: 0, spent: 0, withdrawn: 0, reversed: 0 },
    (await new Ledger(db).balances(a.agentId)).USDC,
  );

/** The operator's wallet signs a decision on a payout request. */
async function decide(a: Actor, requestId: number, decision: "approve" | "reject", signer = a) {
  const request = { requestId, decision };
  const c = await post("/v1/enroll/spending-challenge", {
    address: a.wallet.address,
    purpose: "payout-approval",
    request,
  });
  if (c.status !== 201) return c;
  const message = c.body.message as string;
  return post("/v1/enroll/payout-approval", {
    message,
    signature: personalSign(message, signer.wallet.key),
    request,
  });
}

describe("payout requests", () => {
  it("is off without the chain configuration", async () => {
    const a = await operator("Off Payouts");
    const off = await post("/v1/commons/payout", {}, a.token, { DEPOSITS: undefined });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe("payouts_disabled");
  });

  it("reserves the amount for the operator's wallet and replays retries", async () => {
    const a = await operator("Payout Requester");
    expect((await requestPayout(a, 999_999)).status).toBe(400);
    // Available 10 USDC, reserve 1 USDC: at most 9 USDC can be paid out.
    expect((await requestPayout(a, 9_500_000)).body.error.code).toBe("minimum_reserve");
    expect((await requestPayout(a, 11_000_000)).status).toBe(402);

    const key = `payout-${++counter}-replay`;
    const created = await requestPayout(a, 2_000_000, key);
    expect(created.status).toBe(201);
    expect(created.body.payout).toMatchObject({
      destination: a.destination,
      amountMinor: 2_000_000,
      currency: "USDC",
      status: "awaiting_approval",
    });
    expect(await balances(a)).toMatchObject({ available: 8_000_000, reserved: 2_000_000 });
    const again = await requestPayout(a, 2_000_000, key);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.payout.requestId).toBe(created.body.payout.requestId);
    expect(await balances(a)).toMatchObject({ reserved: 2_000_000 });

    const list = await post("/v1/commons/payout", {}, a.token);
    expect(list.body).toMatchObject({ schemaVersion: "payout-list/v1", minimumMinor: 1_000_000 });
    expect(list.body.payouts).toHaveLength(1);
  });

  it("needs an enrolled wallet and a spending policy", async () => {
    const op = await identity.createOperator({ kind: "organization", displayName: "No Wallet" });
    const agent = await identity.registerAgent(op.id, { displayName: "No Wallet Agent" });
    const token = (await credentials.issueCredential(agent.id, { label: "n" })).token;
    const refused = await post(
      "/v1/commons/payout",
      { amountMinor: 1_000_000, idempotencyKey: `payout-${++counter}-nowallet` },
      token,
    );
    expect(refused.body.error.code).toBe("not_enrolled");
  });
});

describe("approval and sending", () => {
  it("pays out only after wallet approval and an on-chain transfer that matches", async () => {
    const a = await operator("Payout Approver");
    const created = await requestPayout(a, 2_000_000);
    const requestId = created.body.payout.requestId as number;

    // Not approved yet: the owner cannot record it as sent.
    const early = await review("payout-sent", {
      requestId,
      txHash: mine(a.destination, 2_000_000),
    });
    expect(early.body.error.code).toBe("not_approved");

    // Another operator's wallet cannot approve it.
    const stranger = await operator("Payout Stranger");
    expect((await decide(stranger, requestId, "approve")).status).toBe(404);

    const challenge = await post("/v1/enroll/spending-challenge", {
      address: a.wallet.address,
      purpose: "payout-approval",
      request: { requestId, decision: "approve" },
    });
    expect(challenge.body.message).toContain(
      `Approve Agent Commons payout request ${requestId} of 2 USDC to your wallet ${a.destination}.`,
    );
    const approved = await decide(a, requestId, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.payout.status).toBe("approved");
    expect((await decide(a, requestId, "approve")).status).toBe(409);

    const toSend = await review("payouts");
    expect(toSend.body.payouts.map((p: Json) => p.requestId)).toContain(requestId);

    const cases: [string, string][] = [
      [mine(a.destination, 1_999_999), "transfer_mismatch"],
      [mine(a.destination, 2_000_000, { from: a.destination }), "transfer_mismatch"],
      [mine(stranger.destination, 2_000_000), "transfer_mismatch"],
      [mine(a.destination, 2_000_000, { block: chain.head }), "transfer_unconfirmed"],
      [`0x${"e".repeat(64)}`, "transfer_not_found"],
    ];
    for (const [txHash, code] of cases) {
      expect((await review("payout-sent", { requestId, txHash })).body.error.code, code).toBe(code);
    }

    const txHash = mine(a.destination, 2_000_000);
    const sent = await review("payout-sent", { requestId, txHash });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.payout).toMatchObject({ status: "sent", txHash });
    expect(await balances(a)).toMatchObject({ reserved: 0, withdrawn: 2_000_000 });
    expect((await review("payout-sent", { requestId, txHash })).status).toBe(409);

    // One transfer pays one payout only.
    const auto = await operator("Payout Reuser", { autoApprove: true });
    const second = await requestPayout(auto, 2_000_000);
    expect(second.body.payout.status).toBe("approved");
    const reuse = mine(auto.destination, 2_000_000);
    expect(
      (await review("payout-sent", { requestId: second.body.payout.requestId, txHash: reuse }))
        .status,
    ).toBe(200);
    const third = await requestPayout(auto, 2_000_000);
    const reused = await review("payout-sent", {
      requestId: third.body.payout.requestId,
      txHash: reuse,
    });
    expect(reused.body.error.code).toBe("transfer_already_used");
    expect(await balances(auto)).toMatchObject({ reserved: 2_000_000, withdrawn: 2_000_000 });
  });

  it("releases the amount when the operator or the owner rejects it", async () => {
    const a = await operator("Payout Rejecter");
    const first = await requestPayout(a, 2_000_000);
    const rejected = await decide(a, first.body.payout.requestId, "reject");
    expect(rejected.status).toBe(201);
    expect(rejected.body.payout.status).toBe("rejected");
    expect(await balances(a)).toMatchObject({ available: 10_000_000, reserved: 0 });

    const second = await requestPayout(a, 3_000_000);
    await decide(a, second.body.payout.requestId, "approve");
    const byOwner = await review("payout-reject", {
      requestId: second.body.payout.requestId,
      reason: "Sanctions check pending",
    });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.payout.status).toBe("rejected");
    expect(await balances(a)).toMatchObject({ available: 10_000_000, reserved: 0 });
    expect(
      (await review("payout-reject", { requestId: second.body.payout.requestId, reason: "x" }))
        .status,
    ).toBe(409);
  });

  it("keeps payout records append-only and paid only to the enrolled wallet", async () => {
    await expect(db.prepare("DELETE FROM payout_events").run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("UPDATE payout_requests SET amount_minor = 1").run()).rejects.toThrow(
      /append-only/,
    );
    const a = await operator("Payout Forger");
    const held = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `forged-${++counter}-hold`,
        agentId: a.agentId,
        operatorId: a.operatorId,
        entryType: "reservation",
        amountMinor: 1_000_000,
        currency: "USDC",
      },
    ]);
    if (!held.ok) throw new Error(held.error.code);
    await expect(
      db
        .prepare(
          `INSERT INTO payout_requests (operator_id, agent_id, destination, amount_minor, currency,
             reservation_entry_id, requested_at)
           VALUES (?, ?, ?, 1000000, 'USDC', ?, ?)`,
        )
        .bind(
          a.operatorId,
          a.agentId,
          "0x00000000000000000000000000000000000000ee",
          held.entries[0]!.entryId,
          new Date(START).toISOString(),
        )
        .run(),
    ).rejects.toThrow(/payout_request_invalid/);
  });
});
