import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialService } from "../src/identity/credentials";
import { IdentityRepository } from "../src/identity/repository";
import type { AgentId, OperatorId } from "../src/identity/types";
import { ContributionRegistry, type RegistryEnv } from "../src/registry/creation";
import { NOTIFY_CRON } from "../src/notify/notifications";
import { Ledger } from "../src/payments/ledger";
import { quote, type PriceList } from "../src/payments/pricing";
import type { PaymentProvider } from "../src/payments/provider";
import { settleDue } from "../src/payments/settlement";
import { SpendingControls } from "../src/payments/spending-controls";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

// Test-only placeholder, not a real credential.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const START = Date.parse("2026-11-18T10:00:00.000Z");
const DAY = 86_400_000;
const PRICE = 400;

interface Actor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  readonly token: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let proxy: PlatformProxy<RegistryEnv>;
let dir: string;
let db: D1Database;
let identity: IdentityRepository;
let credentials: CredentialService;
let registry: ContributionRegistry;
let owner: Actor;
let counter = 0;

const PROVIDER: PaymentProvider = {
  name: "test",
  async charge(request) {
    return { ok: true, providerRef: `test:${request.purchaseRef}` };
  },
  async refund() {
    return { ok: true };
  },
};
const PRICES: PriceList = () => quote(PRICE, "USDC");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-settlement-"));
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
  registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });
  owner = await actor("Settlement Owner", true);
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function actor(name: string, allowListed = false): Promise<Actor> {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  if (allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
  }
  const agent = await identity.registerAgent(operator.id, { displayName: `${name} ${++counter}` });
  const issued = await credentials.issueCredential(agent.id, { label: name });
  return { agentId: agent.id, operatorId: operator.id, token: issued.token };
}

/** A new listed, verified version of the given family by the owner. */
async function record(family: "knowledge" | "execution"): Promise<string> {
  const seed = family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED;
  const created = await registry.createContribution(owner.agentId, {
    ...seed,
    title: `settleword ${family} ${++counter}`,
  } as never);
  if (!created.ok) throw new Error(created.error.code);
  const id = created.contribution.id;
  await listVersion(proxy.env, id);
  await setVerified(id, 1);
  return id;
}

const setVerified = (id: string, verified: 0 | 1) =>
  db
    .prepare(
      `INSERT INTO version_trust (contribution_id, version, source_status, verified, updated_at)
       VALUES (?, 1, 'matched', ?, ?)
       ON CONFLICT (contribution_id, version) DO UPDATE SET verified = excluded.verified`,
    )
    .bind(id, verified, new Date(START).toISOString())
    .run();

async function post(path: string, body: unknown, token: string, atMs = START) {
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      DB: db,
      CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
      NOW: () => new Date(atMs),
      RATE_LIMIT_AGENT_LIMIT: 100000,
      RATE_LIMIT_OPERATOR_LIMIT: 100000,
      RATE_LIMIT_WINDOW_SECONDS: 60,
      REVIEW_INTERFACE: "on",
      REVIEWER_ID: "pilot-reviewer",
      REVIEWER_TOKEN: TOKEN,
      PAYMENTS: "sandbox",
      PAYMENT_PROVIDER: PROVIDER,
      PRICE_LIST: PRICES,
    } as never,
  );
  return { status: response.status, body: (await response.json()) as Json };
}
const review = (op: string, body: Json = {}, atMs = START) =>
  post(`/v1/review/${op}`, body, TOKEN, atMs);

/** An independent buyer purchases the version; returns the buyer and the purchase reference. */
async function purchase(id: string) {
  const buyer = await actor("Settlement Buyer");
  const set = await new SpendingControls(db, () => new Date(START)).setPolicy({
    operatorId: buyer.operatorId,
    currency: "USDC",
    perTransactionLimitMinor: 1000,
    dailyLimitMinor: 10000,
    monthlyLimitMinor: 100000,
    minimumReserveMinor: 0,
    maxAutonomousBalanceMinor: 100000,
    permittedCategories: ["knowledge", "execution"],
    withdrawalsNeedApproval: true,
    setBy: "test",
  });
  expect(set.ok).toBe(true);
  const bought = await post(
    "/v1/commons/purchase",
    { contributionId: id, version: 1, idempotencyKey: `settle-buy-${++counter}` },
    buyer.token,
  );
  expect(bought.body.status, JSON.stringify(bought.body)).toBe("purchased");
  const row = await db
    .prepare(
      `SELECT purchase_ref FROM ledger_entries
       WHERE agent_id = ? AND entry_type = 'purchase' AND contribution_id = ?`,
    )
    .bind(buyer.agentId, id)
    .first<{ purchase_ref: string }>();
  return { buyer, purchaseRef: row!.purchase_ref };
}

const shareOf = (purchaseRef: string) =>
  db
    .prepare(
      `SELECT entry_id FROM ledger_entries
       WHERE purchase_ref = ? AND entry_type = 'contribution_revenue_share'`,
    )
    .bind(purchaseRef)
    .first<{ entry_id: number }>();
/** USDC buckets of an agent, with zero for an agent that has no USDC entries yet. */
const balances = async (a: Actor) =>
  Object.assign(
    { pending: 0, available: 0, reserved: 0, spent: 0, withdrawn: 0, reversed: 0 },
    (await new Ledger(db).balances(a.agentId)).USDC,
  );

describe("settlement", () => {
  it("settles verified earnings at once, with no hold, once", async () => {
    const id = await record("knowledge");
    const { purchaseRef } = await purchase(id);
    const share = await shareOf(purchaseRef);
    expect(share).not.toBeNull();
    const before = await balances(owner);

    // The same instant the earning was recorded: settled, with no waiting period.
    const run = await review("settle", {}, START);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ schemaVersion: "settlement-run/v1" });
    expect(run.body.settled).toBeGreaterThanOrEqual(1);
    const after = await balances(owner);
    expect(after.available - before.available).toBeGreaterThanOrEqual(PRICE / 2);
    expect((await review("settle", {}, START)).body.settled).toBe(0);
  });

  it("lets D1 accept a settlement recorded the moment the earning was", async () => {
    const id = await record("knowledge");
    const { purchaseRef } = await purchase(id);
    const share = (await shareOf(purchaseRef))!;
    const direct = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `instant-${++counter}-settle`,
        agentId: owner.agentId,
        operatorId: owner.operatorId,
        entryType: "settlement",
        amountMinor: PRICE / 2,
        currency: "USDC",
        relatedEntryId: share.entry_id,
      },
    ]);
    expect(direct.ok ? "ok" : direct.error.code).toBe("ok");
  });

  it("keeps an earning pending while its version is not verified", async () => {
    const id = await record("knowledge");
    const { purchaseRef } = await purchase(id);
    const share = (await shareOf(purchaseRef))!;
    await setVerified(id, 0);
    await settleDue(db, () => new Date(START + 8 * DAY));
    const settled = await db
      .prepare(
        "SELECT 1 FROM ledger_entries WHERE related_entry_id = ? AND entry_type = 'settlement'",
      )
      .bind(share.entry_id)
      .first();
    expect(settled).toBeNull();
    const direct = await new Ledger(db, () => new Date(START + 8 * DAY)).append([
      {
        idempotencyKey: `unverified-${++counter}-settle`,
        agentId: owner.agentId,
        operatorId: owner.operatorId,
        entryType: "settlement",
        amountMinor: PRICE / 2,
        currency: "USDC",
        relatedEntryId: share.entry_id,
      },
    ]);
    expect(direct.ok ? "ok" : direct.error.code).toBe("settlement_unverified");
    await setVerified(id, 1);
  });

  it("settles from the scheduled trigger and not while payments are stopped", async () => {
    // An earning that names no version, so the trigger's source re-checks cannot affect it.
    const worker1 = await actor("Task Worker");
    const earned = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `task-${++counter}-earning`,
        agentId: worker1.agentId,
        operatorId: worker1.operatorId,
        entryType: "task_earning",
        amountMinor: 500,
        currency: "USDC",
      },
    ]);
    if (!earned.ok) throw new Error(earned.error.code);
    const scheduledEnv = {
      DB: db,
      NOW: () => new Date(START + 9 * DAY),
      // No network: every source re-check sees the source as unavailable.
      SOURCE_FETCHER: async () => new Response("", { status: 503 }),
    } as never;

    await review("payments", { action: "stop", reason: "drill" });
    try {
      expect((await review("settle", {}, START + 9 * DAY)).status).toBe(503);
      await worker.scheduled({}, scheduledEnv);
      expect((await balances(worker1)).available).toBe(0);
    } finally {
      await review("payments", { action: "start", reason: "drill over" });
    }
    await worker.scheduled({}, scheduledEnv);
    expect(await balances(worker1)).toMatchObject({ pending: 0, available: 500 });
  });

  it("settles from the frequent notification trigger too", async () => {
    const worker2 = await actor("Quick Worker");
    const earned = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `task-${++counter}-earning`,
        agentId: worker2.agentId,
        operatorId: worker2.operatorId,
        entryType: "task_earning",
        amountMinor: 300,
        currency: "USDC",
      },
    ]);
    if (!earned.ok) throw new Error(earned.error.code);
    await worker.scheduled({ cron: NOTIFY_CRON }, { DB: db, NOW: () => new Date(START) } as never);
    expect(await balances(worker2)).toMatchObject({ pending: 0, available: 300 });
  });
});

describe("refunds", () => {
  it("refunds the buyer, reverses the share and withdraws the licence", async () => {
    const id = await record("knowledge");
    const { buyer, purchaseRef } = await purchase(id);
    expect((await balances(buyer)).spent).toBe(PRICE);

    const refunded = await review("refund", { purchaseRef, reason: "Content did not match" });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    expect(refunded.body).toMatchObject({ schemaVersion: "ledger-adjustment/v1", kind: "refund" });
    expect(await balances(buyer)).toMatchObject({ spent: 0, available: PRICE });
    const share = (await shareOf(purchaseRef))!;
    const reversed = await db
      .prepare(
        "SELECT SUM(amount_minor) AS n FROM ledger_entries WHERE related_entry_id = ? AND entry_type = 'reversal'",
      )
      .bind(share.entry_id)
      .first<{ n: number }>();
    expect(reversed?.n).toBe(PRICE / 2);
    const reasons = await db
      .prepare("SELECT kind, reason, set_by FROM ledger_adjustments ORDER BY adjustment_id")
      .all<Json>();
    expect(reasons.results).toContainEqual({
      kind: "refund",
      reason: "Content did not match",
      set_by: "reviewer:pilot-reviewer",
    });

    // The licence is withdrawn: the version needs payment again, and cannot be re-bought.
    const got = await post(
      "/v1/commons/get",
      { contributionId: id, version: 1, maxUtf8Bytes: 64000 },
      buyer.token,
    );
    expect(got.status).toBe(402);
    const again = await post(
      "/v1/commons/purchase",
      { contributionId: id, version: 1, idempotencyKey: `rebuy-${++counter}` },
      buyer.token,
    );
    expect(again.body.error.code).toBe("licence_withdrawn");
    expect((await review("refund", { purchaseRef, reason: "again" })).status).toBe(409);
  });

  it("claws back a share that was already settled", async () => {
    const id = await record("knowledge");
    const { purchaseRef } = await purchase(id);
    await settleDue(db, () => new Date(START + 7 * DAY));
    const before = await balances(owner);
    expect((await review("refund", { purchaseRef, reason: "Late dispute" })).status).toBe(200);
    expect((await balances(owner)).available).toBe(before.available - PRICE / 2);
  });

  it("refuses unknown purchases and bad requests", async () => {
    expect((await review("refund", { purchaseRef: "pur_missing", reason: "x" })).status).toBe(404);
    expect((await review("refund", { purchaseRef: "pur_missing" })).status).toBe(400);
    expect((await review("refund", { purchaseRef: "x", reason: "y", extra: 1 })).status).toBe(400);
  });
});

describe("reversals", () => {
  it("reverses what is left of a verification reward", async () => {
    const id = await record("execution");
    const verifier = await actor("Fake Verifier");
    await db
      .prepare(
        `INSERT INTO feedback_reports (consumer_operator_id, agent_id, contribution_id, version,
           dimension, assessment_json)
         VALUES (?, ?, ?, 1, 'outcome', '{"finding":"success"}')`,
      )
      .bind(verifier.operatorId, verifier.agentId, id)
      .run();
    const issued = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: `reward-${++counter}-x`,
        agentId: verifier.agentId,
        operatorId: verifier.operatorId,
        entryType: "task_earning",
        amountMinor: 25_000,
        currency: "USDC",
        contribution: { id, version: 1 },
      },
    ]);
    if (!issued.ok) throw new Error(issued.error.code);
    const entryId = issued.entries[0]!.entryId;

    const reversed = await review("reverse", { entryId, reason: "Report was fake" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(await balances(verifier)).toMatchObject({ pending: 0, reversed: 25_000 });
    expect((await review("reverse", { entryId, reason: "again" })).status).toBe(409);
    expect((await review("reverse", { entryId: 999999, reason: "x" })).status).toBe(404);
  });

  it("only withdraws a licence whose purchase was refunded in full", async () => {
    const id = await record("knowledge");
    const { purchaseRef } = await purchase(id);
    await expect(
      db
        .prepare(
          `INSERT INTO entitlement_revocations (purchase_entry_id, reason, revoked_at)
           SELECT entry_id, 'x', ? FROM ledger_entries
           WHERE purchase_ref = ? AND entry_type = 'purchase'`,
        )
        .bind(new Date(START).toISOString(), purchaseRef)
        .run(),
    ).rejects.toThrow(/revocation_not_refunded/);
  });
});
