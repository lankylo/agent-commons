import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { RegistryEnv } from "../src/registry/creation";
import { Ledger } from "../src/payments/ledger";
import { NETWORKS, type RpcCall } from "../src/payments/chain";
import { runRemoteReview } from "../src/review/client";
import worker from "../src/index";

// Test-only placeholder, not a real credential.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const START = Date.parse("2026-11-20T09:00:00.000Z");
const DAY = 86_400_000;
const PLATFORM = "0x00000000000000000000000000000000000000aa";
const SEPOLIA = NETWORKS["base-sepolia"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let counter = 0;

/** The platform wallet's USDC balance as the fake node reports it; null makes the call fail. */
const chain = { balance: 0 as number | null, calls: [] as Json[] };
const RPC: RpcCall = async (method, params) => {
  if (method !== "eth_call") throw new Error(`unexpected ${method}`);
  chain.calls.push(params[0] as Json);
  if (chain.balance === null) throw new Error("node down");
  return `0x${chain.balance.toString(16)}`;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-reconcile-"));
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

const env = (atMs = START, extra: Json = {}) =>
  ({
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    NOW: () => new Date(atMs),
    REVIEW_INTERFACE: "on",
    REVIEWER_ID: "pilot-reviewer",
    REVIEWER_TOKEN: TOKEN,
    PAYMENTS: "sandbox",
    DEPOSITS: "base-sepolia",
    DEPOSIT_ADDRESS: PLATFORM,
    CHAIN_RPC: RPC,
    // No network for the trigger's source re-checks.
    SOURCE_FETCHER: async () => new Response("", { status: 503 }),
    ...extra,
  }) as never;

async function reconcileNow(atMs = START, extra: Json = {}) {
  const response = await worker.fetch(
    new Request("https://example.com/v1/review/reconcile", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    env(atMs, extra),
  );
  return { status: response.status, body: (await response.json()) as Json };
}
const codes = (body: Json) => (body.alerts as Json[]).map((a) => a.code).sort();

async function agent(name: string) {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  const a = await identity.registerAgent(operator.id, { displayName: `${name} ${++counter}` });
  await credentials.issueCredential(a.id, { label: name });
  return { agentId: a.id, operatorId: operator.id };
}

describe("reconciliation report", () => {
  it("is clean on an empty ledger with a matching wallet", async () => {
    chain.balance = 0;
    const run = await reconcileNow();
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({
      schemaVersion: "reconciliation/v1",
      ok: true,
      alerts: [],
      owedToAgentsMinor: 0,
      chain: { checked: true, network: "base-sepolia", platformBalanceMinor: 0, coverageMinor: 0 },
    });
    expect(run.body.runId).toBeGreaterThan(0);
    // The balance is read from the official USDC contract for the platform wallet.
    expect(chain.calls.at(-1)).toMatchObject({ to: SEPOLIA.usdc });
    expect(String(chain.calls.at(-1)!.data)).toMatch(/^0x70a08231/);
    expect(String(chain.calls.at(-1)!.data).endsWith(PLATFORM.slice(2))).toBe(true);
  });

  it("flags an underfunded wallet, an unreadable chain and unsettled earnings", async () => {
    const a = await agent("Reconcile Earner");
    const earned = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `earning-${++counter}-x`,
        agentId: a.agentId,
        operatorId: a.operatorId,
        entryType: "task_earning",
        amountMinor: 700,
        currency: "USDC",
      },
    ]);
    expect(earned.ok).toBe(true);

    chain.balance = 500;
    const short = await reconcileNow();
    expect(short.body.ok).toBe(false);
    expect(codes(short.body)).toEqual(["underfunded"]);
    expect(short.body.alerts[0]).toMatchObject({ severity: "critical", value: 200 });
    expect(short.body.chain.coverageMinor).toBe(-200);

    chain.balance = null;
    expect(codes((await reconcileNow()).body)).toEqual(["chain_unavailable"]);

    // Ten days later the earning should have settled: the scheduled trigger was not running.
    chain.balance = 10_000;
    const late = await reconcileNow(START + 10 * DAY);
    expect(codes(late.body)).toEqual(["settlement_backlog"]);
    expect(late.body.settlement.overdue).toBe(1);

    // Without the chain configuration, the wallet is not checked.
    const offChain = await reconcileNow(START, { DEPOSITS: undefined });
    expect(offChain.body.chain).toMatchObject({ checked: false, platformBalanceMinor: null });
  });

  it("flags deposit and payout mismatches, and reports a stop as information", async () => {
    chain.balance = 1_000_000_000;
    const a = await agent("Reconcile Mismatch");
    // A deposit-style funding entry with no on-chain deposit record behind it.
    await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `deposit:84532:0x${"1".repeat(64)}:0`,
        agentId: a.agentId,
        operatorId: a.operatorId,
        entryType: "operator_funding",
        amountMinor: 5_000_000,
        currency: "USDC",
      },
    ]);
    // A withdrawal recorded outside the payout flow.
    const held = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `hold-${++counter}-x`,
        agentId: a.agentId,
        operatorId: a.operatorId,
        entryType: "reservation",
        amountMinor: 1_000_000,
        currency: "USDC",
      },
    ]);
    if (!held.ok) throw new Error(held.error.code);
    await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `withdraw-${++counter}-x`,
        agentId: a.agentId,
        operatorId: a.operatorId,
        entryType: "withdrawal",
        amountMinor: 1_000_000,
        currency: "USDC",
        relatedEntryId: held.entries[0]!.entryId,
      },
    ]);
    const run = await reconcileNow();
    expect(codes(run.body)).toEqual(
      expect.arrayContaining(["deposit_mismatch", "payout_mismatch"]),
    );
    expect(run.body.deposits).toMatchObject({
      chainCreditedMinor: 0,
      ledgerEntriesMinor: 5_000_000,
    });
    expect(run.body.payouts).toMatchObject({ sentMinor: 0, withdrawnMinor: 1_000_000 });

    // Stopped payments are reported as information only.
    const review = (op: string, body: Json) =>
      worker.fetch(
        new Request(`https://example.com/v1/review/${op}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env(),
      );
    await review("payments", { action: "stop", reason: "drill" });
    const stopped = await reconcileNow();
    expect(codes(stopped.body)).toContain("payments_stopped");
    expect(stopped.body.alerts.find((x: Json) => x.code === "payments_stopped").severity).toBe(
      "info",
    );
    await review("payments", { action: "start", reason: "drill over" });
  });
});

describe("monitoring", () => {
  it("records a run from the scheduled trigger and from the reviewer, append-only", async () => {
    const before = (
      await db.prepare("SELECT count(*) AS c FROM reconciliation_runs").first<{ c: number }>()
    )?.c;
    await worker.scheduled({}, env());
    const rows = await db
      .prepare("SELECT trigger_kind, ok, alerts_json FROM reconciliation_runs ORDER BY run_id")
      .all<Json>();
    expect(rows.results).toHaveLength((before ?? 0) + 1);
    expect(rows.results.at(-1)!.trigger_kind).toBe("scheduled");
    expect(rows.results.some((r) => r.trigger_kind === "reviewer")).toBe(true);
    expect(JSON.parse(rows.results.at(-1)!.alerts_json)).toBeInstanceOf(Array);
    await expect(db.prepare("DELETE FROM reconciliation_runs").run()).rejects.toThrow(
      /append-only/,
    );
  });

  it("is available from the remote review client", async () => {
    let path = "";
    const fake = (async (url: URL) => {
      path = new URL(url).pathname;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const result = await runRemoteReview(
      ["reconcile"],
      { baseUrl: "https://commons.example.org", token: TOKEN },
      fake,
    );
    expect(result.exitCode).toBe(0);
    expect(path).toBe("/v1/review/reconcile");
  });
});
