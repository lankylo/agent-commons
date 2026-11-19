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
import { ContributionRegistry } from "../src/registry/creation";
import { Ledger } from "../src/payments/ledger";
import { quote, type PriceList } from "../src/payments/pricing";
import type { ChargeRequest, PaymentProvider } from "../src/payments/provider";
import { SpendingControls, type SpendingPolicyInput } from "../src/payments/spending-controls";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

const START = Date.parse("2026-11-15T10:00:00.000Z");
const PRICE = 250;
// Test-only placeholder, not a real credential.
const REVIEW_TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";

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
let owner: Actor;
let knowledgeId: string;
let executionId: string;
let counter = 0;

/** Knowledge is priced for these tests; Execution stays free. */
const PRICES: PriceList = (family) =>
  family === "knowledge" ? quote(PRICE, "USDC") : quote(0, "USDC");

/** A stand-in provider that records calls and can decline or run a side effect. */
const provider = {
  charges: [] as ChargeRequest[],
  refunds: [] as string[],
  decline: false,
  onCharge: null as null | (() => Promise<void>),
};
const PROVIDER: PaymentProvider = {
  name: "test",
  async charge(request) {
    provider.charges.push(request);
    if (provider.decline) return { ok: false, code: "payment_declined" };
    if (provider.onCharge) await provider.onCharge();
    return { ok: true, providerRef: `test:${request.purchaseRef}` };
  },
  async refund(providerRef) {
    provider.refunds.push(providerRef);
    return { ok: true };
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-purchase-"));
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
  owner = await createOperatorActor("Purchase Owner", true);
  const registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });
  const knowledge = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_KNOWLEDGE_SEED,
    title: "purchaseword knowledge record",
  });
  if (!knowledge.ok) throw new Error(`knowledge fixture failed: ${knowledge.error.code}`);
  knowledgeId = knowledge.contribution.id;
  await listVersion(proxy.env, knowledgeId);
  const execution = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_EXECUTION_SEED,
    title: "purchaseword execution record",
  } as never);
  if (!execution.ok) throw new Error(`execution fixture failed: ${execution.error.code}`);
  executionId = execution.contribution.id;
  await listVersion(proxy.env, executionId);
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function createOperatorActor(name: string, allowListed = false): Promise<Actor> {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  if (allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
  }
  return createAgent(operator.id, name);
}

async function createAgent(operatorId: OperatorId, name: string): Promise<Actor> {
  const agent = await identity.registerAgent(operatorId, {
    displayName: `${name} Agent ${++counter}`,
  });
  const issued = await credentials.issueCredential(agent.id, { label: name });
  return { agentId: agent.id, operatorId, token: issued.token };
}

async function post(path: string, body: unknown, token: string, extra: Json = {}) {
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      DB: db,
      CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
      RATE_LIMIT_AGENT_LIMIT: 100000,
      RATE_LIMIT_OPERATOR_LIMIT: 100000,
      RATE_LIMIT_WINDOW_SECONDS: 60,
      NOW: () => new Date(START),
      PAYMENTS: "sandbox",
      PAYMENT_PROVIDER: PROVIDER,
      PRICE_LIST: PRICES,
      ...extra,
    } as never,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

const key = (label: string) => `test-${label}-${++counter}`;
const buy = (actor: Actor, body: Json = {}, extra: Json = {}) =>
  post(
    "/v1/commons/purchase",
    { contributionId: knowledgeId, version: 1, idempotencyKey: key("buy"), ...body },
    actor.token,
    extra,
  );
const get = (actor: Actor, id = knowledgeId) =>
  post("/v1/commons/get", { contributionId: id, version: 1, maxUtf8Bytes: 64000 }, actor.token);

async function buyerWithPolicy(name: string, overrides: Partial<SpendingPolicyInput> = {}) {
  const actor = await createOperatorActor(name);
  const set = await new SpendingControls(db, () => new Date(START)).setPolicy({
    operatorId: actor.operatorId,
    currency: "USDC",
    perTransactionLimitMinor: 1000,
    dailyLimitMinor: 5000,
    monthlyLimitMinor: 20000,
    minimumReserveMinor: 0,
    maxAutonomousBalanceMinor: 100000,
    permittedCategories: ["knowledge", "execution"],
    withdrawalsNeedApproval: true,
    setBy: "test-operator",
    ...overrides,
  });
  expect(set.ok).toBe(true);
  return actor;
}

const receipts = async (actor: Actor) =>
  Number(
    (
      await db
        .prepare("SELECT count(*) AS c FROM retrieval_receipts WHERE agent_id = ?")
        .bind(actor.agentId)
        .first<{ c: number }>()
    )?.c,
  );

describe("purchase switch", () => {
  it("is off unless PAYMENTS is sandbox, and refuses invalid values and read-only mode", async () => {
    const actor = await buyerWithPolicy("Switch Buyer");
    expect((await buy(actor, {}, { PAYMENTS: undefined })).body.error.code).toBe(
      "payments_disabled",
    );
    expect((await buy(actor, {}, { PAYMENTS: "production" })).status).toBe(503);
    expect((await buy(actor, {}, { PILOT_MODE: "read-only" })).body.error.code).toBe(
      "pilot_read_only",
    );
    expect(provider.charges.filter((c) => c.agentId === actor.agentId)).toHaveLength(0);
  });

  it("validates the request and never accepts identity fields", async () => {
    const actor = await buyerWithPolicy("Validation Buyer");
    for (const body of [
      { idempotencyKey: "short" },
      { method: "card" },
      { version: 0 },
      { operatorId: actor.operatorId },
      { extra: true },
    ]) {
      expect((await buy(actor, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await buy(actor, { contributionId: "missing-0001" })).status).toBe(404);
  });
});

describe("live payments", () => {
  const LIVE = { PAYMENTS: "live" };

  it("pays only from the agent's balance and never charges a provider", async () => {
    const actor = await buyerWithPolicy("Live Buyer");
    // Asking for the provider is refused outright.
    const provided = await buy(actor, { method: "provider" }, LIVE);
    expect(provided.status).toBe(400);
    expect(provided.body.error.code).toBe("balance_only");
    // Without a method, live mode pays from the balance: nothing deposited yet.
    const broke = await buy(actor, {}, LIVE);
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe("insufficient_balance");
    expect((await get(actor)).status).toBe(402);

    const funded = await new Ledger(db, () => new Date(START)).append([
      {
        idempotencyKey: key("live-fund"),
        agentId: actor.agentId,
        operatorId: actor.operatorId,
        entryType: "operator_funding",
        amountMinor: 1000,
        currency: "USDC",
      },
    ]);
    expect(funded.ok).toBe(true);
    const bought = await buy(actor, {}, LIVE);
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ status: "purchased", paymentMode: "live" });
    expect(await new Ledger(db).balances(actor.agentId)).toMatchObject({
      USDC: { available: 1000 - PRICE, spent: PRICE },
    });
    // The injected test provider is never used in live mode.
    expect(provider.charges.filter((c) => c.agentId === actor.agentId)).toHaveLength(0);
  });
});

describe("paid access", () => {
  it("needs a purchase before a priced version is returned, with nothing leaked or counted", async () => {
    const actor = await buyerWithPolicy("Gate Buyer");
    const refused = await get(actor);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe("payment_required");
    expect(refused.body.error.details.price).toMatchObject({
      amountMinor: PRICE,
      currency: "USDC",
    });
    expect(JSON.stringify(refused.body)).not.toContain("httpbin");
    expect(await receipts(actor)).toBe(0);
    // Free versions and the contributor's own versions need no purchase.
    expect((await get(actor, executionId)).status).toBe(200);
    expect((await get(owner)).status).toBe(200);
    expect((await buy(actor, { contributionId: executionId })).body.status).toBe("not_required");
    expect((await buy(owner)).body.status).toBe("not_required");
  });

  it("buys through the provider once, for every agent of the operator, and replays retries", async () => {
    const actor = await buyerWithPolicy("Provider Buyer");
    const sibling = await createAgent(actor.operatorId, "Provider Buyer Sibling");
    const idempotencyKey = key("provider");
    const bought = await buy(actor, { idempotencyKey });
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({
      schemaVersion: "purchase-result/v1",
      status: "purchased",
      paymentMode: "sandbox",
      replayed: false,
      price: { amountMinor: PRICE, currency: "USDC", licence: "operator-version-perpetual" },
      entitlement: { licence: "operator-version-perpetual" },
    });
    const again = await buy(actor, { idempotencyKey });
    expect(again.body).toMatchObject({ status: "purchased", replayed: true });
    expect((await buy(sibling)).body.status).toBe("already_entitled");
    expect(provider.charges.filter((c) => c.agentId === actor.agentId)).toHaveLength(1);
    expect(provider.charges.filter((c) => c.agentId === sibling.agentId)).toHaveLength(0);

    expect((await get(actor)).status).toBe(200);
    expect((await get(sibling)).status).toBe(200);
    // The charge was recorded as funding and spent at once: nothing is left over.
    expect(await new Ledger(db).balances(actor.agentId)).toEqual({
      USDC: { pending: 0, available: 0, reserved: 0, spent: PRICE, withdrawn: 0, reversed: 0 },
    });
  });

  it("records nothing when the provider declines", async () => {
    const actor = await buyerWithPolicy("Declined Buyer");
    provider.decline = true;
    try {
      const declined = await buy(actor);
      expect(declined.status).toBe(402);
      expect(declined.body.error.code).toBe("payment_declined");
    } finally {
      provider.decline = false;
    }
    expect(await new Ledger(db).entries(actor.agentId)).toEqual([]);
    expect((await get(actor)).status).toBe(402);
  });

  it("checks spending controls before charging", async () => {
    const noPolicy = await createOperatorActor("No Policy Buyer");
    expect((await buy(noPolicy)).body.error.code).toBe("spending_policy_missing");
    const narrow = await buyerWithPolicy("Narrow Buyer", { permittedCategories: ["execution"] });
    expect((await buy(narrow)).body.error.code).toBe("category_not_permitted");
    const small = await buyerWithPolicy("Small Buyer", { perTransactionLimitMinor: 100 });
    expect((await buy(small)).body.error.code).toBe("per_transaction_limit");
    for (const actor of [noPolicy, narrow, small]) {
      expect(provider.charges.filter((c) => c.agentId === actor.agentId)).toHaveLength(0);
    }
  });

  it("refunds a charge whose purchase is refused when it is recorded", async () => {
    const actor = await buyerWithPolicy("Raced Buyer");
    // The operator suspends the agent while the charge is in flight.
    provider.onCharge = async () => {
      await new SpendingControls(db, () => new Date(START)).suspend(
        { operatorId: actor.operatorId, agentId: actor.agentId },
        "suspended mid-purchase",
        "test-operator",
      );
    };
    try {
      const raced = await buy(actor);
      expect(raced.status).toBe(403);
      expect(raced.body.error.code).toBe("spending_suspended");
    } finally {
      provider.onCharge = null;
    }
    const charge = provider.charges.find((c) => c.agentId === actor.agentId);
    expect(provider.refunds).toContain(`test:${charge?.purchaseRef}`);
    expect(await new Ledger(db).entries(actor.agentId)).toEqual([]);
    expect((await get(actor)).status).toBe(402);
  });

  it("pays from the available balance when asked to", async () => {
    const actor = await buyerWithPolicy("Balance Buyer");
    const ledger = new Ledger(db, () => new Date(START));
    expect((await buy(actor, { method: "balance" })).body.error.code).toBe("insufficient_balance");
    const funded = await ledger.append([
      {
        idempotencyKey: key("fund"),
        agentId: actor.agentId,
        operatorId: actor.operatorId,
        entryType: "operator_funding",
        amountMinor: 1000,
        currency: "USDC",
      },
    ]);
    expect(funded.ok).toBe(true);
    expect((await buy(actor, { method: "balance" })).body.status).toBe("purchased");
    expect(provider.charges.filter((c) => c.agentId === actor.agentId)).toHaveLength(0);
    expect((await ledger.balances(actor.agentId)).USDC).toMatchObject({
      available: 1000 - PRICE,
      spent: PRICE,
    });
    expect((await get(actor)).status).toBe(200);
  });

  it("keeps entitlements append-only and tied to a recorded purchase", async () => {
    const actor = await createOperatorActor("Forged Entitlement");
    await expect(
      db
        .prepare(
          `INSERT INTO purchase_entitlements (operator_id, contribution_id, version,
             purchase_entry_id, licence, granted_at)
           VALUES (?, ?, 1, (SELECT MIN(entry_id) FROM ledger_entries), 'operator-version-perpetual', ?)`,
        )
        .bind(actor.operatorId, knowledgeId, new Date(START).toISOString())
        .run(),
    ).rejects.toThrow(/entitlement_unpaid|UNIQUE/);
    await expect(db.prepare("DELETE FROM purchase_entitlements").run()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("contributor earnings", () => {
  const earnings = async (id: string) =>
    (
      await db
        .prepare(
          `SELECT amount_minor, currency, to_bucket, operator_id FROM ledger_entries
           WHERE agent_id = ? AND entry_type = 'contribution_revenue_share' AND contribution_id = ?`,
        )
        .bind(owner.agentId, id)
        .all<{ amount_minor: number; currency: string; to_bucket: string; operator_id: string }>()
    ).results;

  const setVerified = (id: string, verified: 0 | 1) =>
    db
      .prepare(
        `INSERT INTO version_trust (contribution_id, version, source_status, verified, updated_at)
         VALUES (?, 1, 'matched', ?, ?)
         ON CONFLICT (contribution_id, version) DO UPDATE SET verified = excluded.verified`,
      )
      .bind(id, verified, new Date(START).toISOString())
      .run();

  /** Independent purchases of a version: each should end with exactly one earning. */
  const purchases = async (id: string) =>
    Number(
      (
        await db
          .prepare(
            `SELECT count(*) AS c FROM ledger_entries
             WHERE entry_type = 'purchase' AND contribution_id = ? AND operator_id <> ?`,
          )
          .bind(id, owner.operatorId)
          .first<{ c: number }>()
      )?.c,
    );

  it("pays the contributor half of every verified Knowledge purchase, pending", async () => {
    // Earlier tests bought this record while it was unverified: those earnings are issued with the
    // next purchase once it is verified.
    expect(await earnings(knowledgeId)).toHaveLength(0);
    expect(await purchases(knowledgeId)).toBeGreaterThan(0);
    await setVerified(knowledgeId, 1);
    const actor = await buyerWithPolicy("Verified Knowledge Buyer");
    expect((await buy(actor)).body.status).toBe("purchased");
    const after = await earnings(knowledgeId);
    expect(after).toHaveLength(await purchases(knowledgeId));
    for (const earning of after) {
      expect(earning).toEqual({
        amount_minor: PRICE / 2,
        currency: "USDC",
        to_bucket: "pending",
        operator_id: owner.operatorId,
      });
    }
    // A retry never pays twice.
    const idempotencyKey = key("retry-earning");
    const other = await buyerWithPolicy("Verified Knowledge Retry");
    await buy(other, { idempotencyKey });
    await buy(other, { idempotencyKey });
    expect(await earnings(knowledgeId)).toHaveLength(after.length + 1);
    expect(await purchases(knowledgeId)).toBe(after.length + 1);
  });

  it("pays nothing for an unverified Knowledge purchase until it is verified", async () => {
    await setVerified(knowledgeId, 0);
    const before = (await earnings(knowledgeId)).length;
    const actor = await buyerWithPolicy("Unverified Knowledge Buyer");
    expect((await buy(actor)).body.status).toBe("purchased");
    expect(await earnings(knowledgeId)).toHaveLength(before);
  });

  it("rewards one external validator of a free Execution, then pays its contributor on use", async () => {
    const EXECUTION_PRICE = 1000;
    // Like the paid price list: unverified Execution is free, verified Execution is priced.
    const prices: PriceList = (family, verified) =>
      family === "execution" ? quote(verified ? EXECUTION_PRICE : 0, "USDC") : quote(PRICE, "USDC");
    const withPrices = { PRICE_LIST: prices };

    const rewards = async () =>
      (
        await db
          .prepare(
            `SELECT agent_id, operator_id, amount_minor, currency, to_bucket FROM ledger_entries
             WHERE entry_type = 'task_earning' AND contribution_id = ? ORDER BY entry_id`,
          )
          .bind(executionId)
          .all<Json>()
      ).results;
    const verifier = async (name: string) => {
      const actor = await createOperatorActor(name);
      const got = await post(
        "/v1/commons/get",
        { contributionId: executionId, version: 1, maxUtf8Bytes: 64000 },
        actor.token,
        withPrices,
      );
      expect(got.status, name).toBe(200);
      return actor;
    };
    const reportSuccess = (actor: Actor, extra: Json = {}) =>
      post(
        "/v1/commons/feedback",
        {
          contributionId: executionId,
          version: 1,
          assessment: {
            outcome: {
              finding: "success",
              observedAt: new Date(START).toISOString(),
              steps: ["fetch", "extract", "check_echo"].map((stepId) => ({
                stepId,
                result: "passed",
              })),
            },
          },
        },
        actor.token,
        { ...withPrices, ...extra },
      );

    // Unverified: free, so nothing to buy and nothing earned.
    const early = await buyerWithPolicy("Unverified Execution Buyer");
    expect((await buy(early, { contributionId: executionId }, withPrices)).body.status).toBe(
      "not_required",
    );

    const first = await verifier("Execution Validator One");
    const second = await verifier("Execution Validator Two");
    // An external success report alone does not verify it, so nothing is paid.
    expect((await reportSuccess(first)).status).toBe(200);
    expect(await rewards()).toEqual([]);
    // Agent Commons validates it while payments are off: verified, but no reward accrues.
    const validated = await post(
      "/v1/review/validate",
      { contributionId: executionId, version: 1, note: "Ran the recipe" },
      REVIEW_TOKEN,
      {
        REVIEW_INTERFACE: "on",
        REVIEWER_ID: "pilot-reviewer",
        REVIEWER_TOKEN: REVIEW_TOKEN,
        PAYMENTS: undefined,
      },
    );
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    expect(validated.body.trust.verified).toBe(true);
    expect(await rewards()).toEqual([]);
    // With payments on, only the first external validator is paid, once: 0.025 USDC.
    expect((await reportSuccess(second)).status).toBe(200);
    expect(await rewards()).toEqual([
      {
        agent_id: first.agentId,
        operator_id: first.operatorId,
        amount_minor: 25_000,
        currency: "USDC",
        to_bucket: "pending",
      },
    ]);
    expect((await reportSuccess(first)).status).toBe(200);
    expect(await rewards()).toHaveLength(1);

    // Verified: now priced, and each independent purchase pays the contributor half.
    const buyer = await buyerWithPolicy("Verified Execution Buyer");
    const bought = await buy(buyer, { contributionId: executionId }, withPrices);
    expect(bought.body).toMatchObject({
      status: "purchased",
      price: { amountMinor: EXECUTION_PRICE },
    });
    expect(await earnings(executionId)).toEqual([
      {
        amount_minor: EXECUTION_PRICE / 2,
        currency: "USDC",
        to_bucket: "pending",
        operator_id: owner.operatorId,
      },
    ]);
  });

  it("refuses rewards that break the rules, in D1", async () => {
    const ledger = new Ledger(db, () => new Date(START));
    const forged = (actor: Actor, amountMinor: number, id: string) =>
      ledger.append([
        {
          idempotencyKey: key("reward"),
          agentId: actor.agentId,
          operatorId: actor.operatorId,
          entryType: "task_earning",
          amountMinor,
          currency: "USDC",
          contribution: { id, version: 1 },
        },
      ]);
    const code = (r: Awaited<ReturnType<typeof forged>>) => (r.ok ? "ok" : r.error.code);

    // A fresh verified Execution version with one successful report and no rewards yet.
    const created = await new ContributionRegistry(proxy.env, {
      now: () => new Date(START),
    }).createContribution(owner.agentId, {
      ...HTTPBIN_EXECUTION_SEED,
      title: "purchaseword execution reward rules",
    } as never);
    if (!created.ok) throw new Error(created.error.code);
    const id = created.contribution.id;
    await listVersion(proxy.env, id);
    const reporter = await createOperatorActor("Reward Reporter");
    const bystander = await createOperatorActor("Reward Bystander");
    await db.batch([
      db
        .prepare(
          `INSERT INTO version_trust (contribution_id, version, source_status, verified, updated_at)
           VALUES (?, 1, 'none', 1, ?)`,
        )
        .bind(id, new Date(START).toISOString()),
      db
        .prepare(
          `INSERT INTO feedback_reports (consumer_operator_id, agent_id, contribution_id, version,
             dimension, assessment_json)
           VALUES (?, ?, ?, 1, 'outcome', '{"finding":"success"}')`,
        )
        .bind(reporter.operatorId, reporter.agentId, id),
    ]);
    expect(code(await forged(reporter, 50_000, id))).toBe("reward_not_eligible");
    expect(code(await forged(bystander, 25_000, id))).toBe("reward_not_eligible");
    expect(code(await forged(owner, 25_000, id))).toBe("reward_not_eligible");
    expect(code(await forged(reporter, 25_000, id))).toBe("ok");

    // The first record already paid its one external validator: another is over the limit.
    const third = await db
      .prepare(
        `SELECT f.agent_id, f.consumer_operator_id FROM feedback_reports f
         WHERE f.contribution_id = ? AND f.dimension = 'outcome'
           AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.entry_type = 'task_earning'
                           AND r.operator_id = f.consumer_operator_id)
         LIMIT 1`,
      )
      .bind(executionId)
      .first<{ agent_id: string; consumer_operator_id: string }>();
    const verifier = { agentId: third!.agent_id, operatorId: third!.consumer_operator_id } as Actor;
    expect(code(await forged(verifier, 25_000, executionId))).toBe("reward_limit");
  });
});
