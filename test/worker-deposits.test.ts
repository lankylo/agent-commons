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
import worker from "../src/index";

// Test-only placeholder, not a real credential.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const START = Date.parse("2026-11-18T12:00:00.000Z");
const SEPOLIA = NETWORKS["base-sepolia"];
const PLATFORM = "0x00000000000000000000000000000000000000aa";
const FAKE_TOKEN = "0x00000000000000000000000000000000000000bb";

interface Actor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  readonly token: string;
  readonly wallet: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let counter = 0;

/** A fake Base Sepolia node: receipts by hash, a head block and canonical block hashes. */
const chain = {
  chainId: SEPOLIA.chainId,
  head: 1000,
  receipts: new Map<string, Json>(),
  canonical: new Map<number, string>(),
  down: false,
};
const RPC: RpcCall = async (method, params) => {
  if (chain.down) throw new Error("node down");
  switch (method) {
    case "eth_chainId":
      return `0x${chain.chainId.toString(16)}`;
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
  dir = mkdtempSync(join(tmpdir(), "worker-deposits-"));
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

/** An operator with an enrolled wallet and one agent. */
async function walletActor(name: string): Promise<Actor> {
  const operator = await identity.createOperator({ kind: "individual", displayName: name });
  const agent = await identity.registerAgent(operator.id, { displayName: `${name} ${++counter}` });
  const issued = await credentials.issueCredential(agent.id, { label: name });
  const wallet = `0x${hex(++counter, 40)}`;
  await db
    .prepare(
      "INSERT INTO wallet_accounts (address, operator_id, agent_id, enrolled_at) VALUES (?, ?, ?, ?)",
    )
    .bind(wallet, operator.id, agent.id, new Date(START).toISOString())
    .run();
  return { agentId: agent.id, operatorId: operator.id, token: issued.token, wallet };
}

interface TransferSpec {
  readonly from: string;
  readonly amount: number;
  readonly to?: string;
  readonly token?: string;
}

/** Puts a mined transaction on the fake chain and returns its hash. */
function mine(
  transfers: readonly TransferSpec[],
  options: { block?: number; status?: string } = {},
): string {
  const txHash = `0x${hex(++counter, 64)}`;
  const block = options.block ?? chain.head - 10;
  const blockHash = `0x${hex(block, 64)}`;
  chain.canonical.set(block, blockHash);
  chain.receipts.set(txHash, {
    status: options.status ?? "0x1",
    blockNumber: `0x${block.toString(16)}`,
    blockHash,
    transactionHash: txHash,
    logs: transfers.map((t, i) => ({
      address: t.token ?? SEPOLIA.usdc,
      topics: [TRANSFER_TOPIC, pad(t.from), pad(t.to ?? PLATFORM)],
      data: `0x${hex(t.amount, 64)}`,
      logIndex: `0x${i.toString(16)}`,
    })),
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
    PAYMENTS: "sandbox",
    DEPOSITS: "base-sepolia",
    DEPOSIT_ADDRESS: PLATFORM,
    CHAIN_RPC: RPC,
    ...extra,
  }) as never;

async function post(path: string, body: unknown, token: string, extra: Json = {}) {
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(extra),
  );
  return { status: response.status, body: (await response.json()) as Json };
}
const deposit = (a: Actor, txHash: string, extra: Json = {}) =>
  post("/v1/commons/deposit", { txHash }, a.token, extra);
const available = async (a: Actor) =>
  (await new Ledger(db).balances(a.agentId)).USDC?.available ?? 0;

describe("deposit configuration", () => {
  it("is off by default and fails closed when misconfigured", async () => {
    const a = await walletActor("Config Operator");
    const off = await post("/v1/commons/deposit", {}, a.token, { DEPOSITS: undefined });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe("deposits_disabled");
    for (const extra of [
      { DEPOSITS: "base" },
      { PAYMENTS: undefined },
      { DEPOSIT_ADDRESS: "0x123" },
      { BASE_RPC_URL: "http://sepolia.base.org" },
    ]) {
      expect(
        (await post("/v1/commons/deposit", {}, a.token, extra)).status,
        JSON.stringify(extra),
      ).toBe(503);
    }
  });

  it("tells agents where and how to deposit", async () => {
    const a = await walletActor("Instructions Operator");
    const info = await post("/v1/commons/deposit", {}, a.token);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      schemaVersion: "deposit-instructions/v1",
      network: "base-sepolia",
      chainId: 84532,
      token: { symbol: "USDC", address: SEPOLIA.usdc, decimals: 6 },
      depositAddress: PLATFORM,
      minimumMinor: 10_000,
      confirmations: 3,
    });
  });
});

describe("crediting deposits", () => {
  it("credits a confirmed USDC transfer from the operator's wallet exactly once", async () => {
    const a = await walletActor("Depositor");
    const tx = mine([{ from: a.wallet, amount: 5_000_000 }]);
    const credited = await deposit(a, tx);
    expect(credited.status).toBe(201);
    expect(credited.body).toMatchObject({
      schemaVersion: "deposit-result/v1",
      status: "credited",
      amountMinor: 5_000_000,
      network: "base-sepolia",
    });
    expect(await available(a)).toBe(5_000_000);

    const again = await deposit(a, tx.toUpperCase().replace("0X", "0x"));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("already_credited");
    expect(await available(a)).toBe(5_000_000);

    // Another agent of the same operator sees it as already credited, not as new money.
    const sibling = await identity.registerAgent(a.operatorId, { displayName: "Sibling" });
    const siblingToken = (await credentials.issueCredential(sibling.id, { label: "s" })).token;
    const fromSibling = await post("/v1/commons/deposit", { txHash: tx }, siblingToken);
    expect(fromSibling.body.status).toBe("already_credited");
  });

  it("credits each matching log of a transaction and skips dust", async () => {
    const a = await walletActor("Batch Depositor");
    const other = await walletActor("Batch Other");
    const tx = mine([
      { from: a.wallet, amount: 1_000_000 },
      { from: a.wallet, amount: 9_999 }, // dust: below 0.01 USDC
      { from: other.wallet, amount: 2_000_000 }, // someone else's transfer
      { from: a.wallet, amount: 2_500_000 },
    ]);
    const credited = await deposit(a, tx);
    expect(credited.body.amountMinor).toBe(3_500_000);
    expect(credited.body.credited.map((c: Json) => c.logIndex)).toEqual([0, 3]);
    // The other operator's transfer in the same transaction cannot then be claimed by them.
    expect((await deposit(other, tx)).body.error.code).toBe("deposit_not_yours");
  });

  it("waits for confirmations, and refuses reorgs, failures and the wrong network", async () => {
    const a = await walletActor("Careful Depositor");
    const fresh = mine([{ from: a.wallet, amount: 1_000_000 }], { block: chain.head - 1 });
    const pending = await deposit(a, fresh);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({
      status: "unconfirmed",
      confirmations: { have: 2, need: 3 },
    });
    chain.head += 1;
    expect((await deposit(a, fresh)).status).toBe(201);

    const reorged = mine([{ from: a.wallet, amount: 1_000_000 }]);
    const block = Number(BigInt(chain.receipts.get(reorged)!.blockNumber));
    chain.canonical.set(block, `0x${"f".repeat(64)}`);
    expect((await deposit(a, reorged)).body.error.code).toBe("deposit_not_found");

    const failed = mine([{ from: a.wallet, amount: 1_000_000 }], { status: "0x0" });
    expect((await deposit(a, failed)).body.error.code).toBe("deposit_failed");

    const elsewhere = mine([{ from: a.wallet, amount: 1_000_000 }]);
    chain.chainId = 1;
    try {
      expect((await deposit(a, elsewhere)).body.error.code).toBe("wrong_network");
    } finally {
      chain.chainId = SEPOLIA.chainId;
    }
    chain.down = true;
    try {
      expect((await deposit(a, elsewhere)).status).toBe(503);
    } finally {
      chain.down = false;
    }
  });

  it("refuses fake tokens, other recipients, other senders, dust and unknown transactions", async () => {
    const a = await walletActor("Picky Depositor");
    const stranger = "0x00000000000000000000000000000000000000cc";
    const cases: [string, string][] = [
      [mine([{ from: a.wallet, amount: 1_000_000, token: FAKE_TOKEN }]), "not_a_deposit"],
      [mine([{ from: a.wallet, amount: 1_000_000, to: stranger }]), "not_a_deposit"],
      [mine([{ from: stranger, amount: 1_000_000 }]), "deposit_not_yours"],
      [mine([{ from: a.wallet, amount: 9_999 }]), "deposit_too_small"],
      [`0x${"e".repeat(64)}`, "deposit_not_found"],
    ];
    for (const [tx, code] of cases) {
      expect((await deposit(a, tx)).body.error.code, code).toBe(code);
    }
    expect(await available(a)).toBe(0);
    expect((await post("/v1/commons/deposit", { txHash: "0x1234" }, a.token)).status).toBe(400);
  });

  it("refuses operators without an enrolled wallet, and holds deposits while payments are stopped", async () => {
    const operator = await identity.createOperator({
      kind: "organization",
      displayName: "No Wallet",
    });
    const agent = await identity.registerAgent(operator.id, { displayName: "No Wallet Agent" });
    const token = (await credentials.issueCredential(agent.id, { label: "n" })).token;
    const tx = mine([{ from: "0x00000000000000000000000000000000000000dd", amount: 1_000_000 }]);
    expect((await post("/v1/commons/deposit", { txHash: tx }, token)).body.error.code).toBe(
      "not_enrolled",
    );

    const a = await walletActor("Stopped Depositor");
    const held = mine([{ from: a.wallet, amount: 1_000_000 }]);
    await post("/v1/review/payments", { action: "stop", reason: "drill" }, TOKEN);
    try {
      const refused = await deposit(a, held);
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe("payments_stopped");
    } finally {
      await post("/v1/review/payments", { action: "start", reason: "drill over" }, TOKEN);
    }
    // Nothing was recorded, so the same transfer is credited once payments restart.
    expect((await deposit(a, held)).status).toBe(201);
  });

  it("keeps deposit records append-only and tied to a matching ledger entry", async () => {
    await expect(db.prepare("DELETE FROM chain_deposits").run()).rejects.toThrow(/append-only/);
    await expect(
      db
        .prepare(
          `INSERT INTO chain_deposits (chain_id, tx_hash, log_index, token_address, from_address,
             to_address, amount_minor, block_number, block_hash, ledger_entry_id, credited_at)
           VALUES (84532, ?, 0, ?, ?, ?, 999, 1, ?, (SELECT MIN(entry_id) FROM ledger_entries), ?)`,
        )
        .bind(
          `0x${"d".repeat(64)}`,
          SEPOLIA.usdc,
          PLATFORM,
          PLATFORM,
          `0x${"d".repeat(64)}`,
          new Date(START).toISOString(),
        )
        .run(),
    ).rejects.toThrow(/deposit_ledger_mismatch|UNIQUE/);
  });
});
