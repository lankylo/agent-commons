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
import { Ledger, type LedgerEntryInput } from "../src/payments/ledger";
import { PILOT_PRICES } from "../src/payments/pricing";
import { SpendingControls, type SpendingPolicyInput } from "../src/payments/spending-controls";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

const START = Date.parse("2026-11-15T10:00:00.000Z");
const DAY = 86_400_000;

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
let buyer: Actor;
let knowledgeId: string;
let executionId: string;
let counter = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-payments-"));
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
  owner = await createOperatorActor("Payments Owner", true);
  buyer = await createOperatorActor("Payments Buyer");
  registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });

  const knowledge = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_KNOWLEDGE_SEED,
    title: "pricingword knowledge record",
  });
  if (!knowledge.ok) throw new Error(`knowledge fixture failed: ${knowledge.error.code}`);
  knowledgeId = knowledge.contribution.id;
  await listVersion(proxy.env, knowledgeId);
  const execution = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_EXECUTION_SEED,
    title: "pricingword execution record",
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

async function post(path: string, body: unknown, token: string) {
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
    } as never,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

const key = (label: string) => `test-${label}-${++counter}`;
const ledgerAt = (atMs = START) => new Ledger(db, () => new Date(atMs));
const controlsAt = (atMs = START) => new SpendingControls(db, () => new Date(atMs));

/** A fresh operator with one agent, funded with `amount` USD minor units. */
async function fundedActor(name: string, amount: number): Promise<Actor> {
  const actor = await createOperatorActor(name);
  const funded = await ledgerAt().append([
    entry(actor, "operator_funding", amount, { idempotencyKey: key("fund") }),
  ]);
  expect(funded.ok).toBe(true);
  return actor;
}

function entry(
  actor: Actor,
  entryType: LedgerEntryInput["entryType"],
  amountMinor: number,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return {
    idempotencyKey: key(entryType),
    agentId: actor.agentId,
    operatorId: actor.operatorId,
    entryType,
    amountMinor,
    currency: "USD",
    ...extra,
  };
}

function policy(actor: Actor, overrides: Partial<SpendingPolicyInput> = {}): SpendingPolicyInput {
  return {
    operatorId: actor.operatorId,
    currency: "USD",
    perTransactionLimitMinor: 500,
    dailyLimitMinor: 1000,
    monthlyLimitMinor: 5000,
    minimumReserveMinor: 0,
    maxAutonomousBalanceMinor: 100000,
    permittedCategories: ["knowledge", "execution"],
    withdrawalsNeedApproval: true,
    setBy: "test-operator",
    ...overrides,
  };
}

/** A purchase reservation for an exact version. */
const reserve = (actor: Actor, amount: number, id = knowledgeId, atMs = START) =>
  ledgerAt(atMs).append([
    entry(actor, "reservation", amount, { contribution: { id, version: 1 } }),
  ]);

const refusal = (result: Awaited<ReturnType<Ledger["append"]>>) =>
  result.ok ? "ok" : result.error.code;

describe("prices", () => {
  it("shows a free price and the licence for every search result and full get", async () => {
    const found = await post(
      "/v1/commons/search",
      { query: "pricingword", maxUtf8Bytes: 64000 },
      buyer.token,
    );
    expect(found.status).toBe(200);
    const results = found.body.data.results as { contributionId: string; family: string }[];
    expect(results.length).toBe(2);
    expect(found.body.pricing).toEqual(
      results.map((r) => ({
        contributionId: r.contributionId,
        version: 1,
        amountMinor: 0,
        currency: "USD",
        licence: "operator-version-perpetual",
        paymentRequired: false,
      })),
    );

    for (const [id, family] of [
      [knowledgeId, "knowledge"],
      [executionId, "execution"],
    ] as const) {
      const got = await post(
        "/v1/commons/get",
        { contributionId: id, version: 1, maxUtf8Bytes: 64000 },
        buyer.token,
      );
      expect(got.status).toBe(200);
      expect(got.body.price).toEqual(PILOT_PRICES[family]);
    }
  });

  it("prices Knowledge and Execution separately, both free during the pilot", () => {
    expect(PILOT_PRICES.knowledge.amountMinor).toBe(0);
    expect(PILOT_PRICES.execution.amountMinor).toBe(0);
    expect(PILOT_PRICES.knowledge.paymentRequired).toBe(false);
    expect(PILOT_PRICES.execution.paymentRequired).toBe(false);
  });
});

describe("ledger", () => {
  it("records agent and operator on every entry and derives balances from entries", async () => {
    const actor = await fundedActor("Ledger Balance", 1000);
    const ledger = ledgerAt();
    const held = await ledger.append([
      entry(actor, "reservation", 300, { idempotencyKey: key("hold") }),
    ]);
    if (!held.ok) throw new Error(refusal(held));
    const reservation = held.entries[0]!;
    expect(
      refusal(
        await ledger.append([
          entry(actor, "purchase", 200, {
            relatedEntryId: reservation.entryId,
            contribution: { id: knowledgeId, version: 1 },
          }),
          entry(actor, "reservation_release", 100, { relatedEntryId: reservation.entryId }),
        ]),
      ),
    ).toBe("ok");
    expect(await ledger.balances(actor.agentId)).toEqual({
      USD: { pending: 0, available: 800, reserved: 0, spent: 200, withdrawn: 0, reversed: 0 },
    });
    for (const e of await ledger.entries(actor.agentId)) {
      expect(e.agentId).toBe(actor.agentId);
      expect(e.operatorId).toBe(actor.operatorId);
    }
  });

  it("never lets a bucket go below zero, and records nothing from a refused batch", async () => {
    const actor = await fundedActor("Ledger Overdraw", 100);
    const ledger = ledgerAt();
    expect(refusal(await ledger.append([entry(actor, "reservation", 101)]))).toBe(
      "insufficient_balance",
    );
    expect(refusal(await ledger.append([entry(actor, "fee", 60), entry(actor, "fee", 60)]))).toBe(
      "insufficient_balance",
    );
    expect((await ledger.balances(actor.agentId)).USD?.available).toBe(100);
  });

  it("replays a retry with the same key and refuses a different request under that key", async () => {
    const actor = await fundedActor("Ledger Retry", 500);
    const ledger = ledgerAt();
    const request = entry(actor, "fee", 50, { idempotencyKey: key("retry") });
    const first = await ledger.append([request]);
    const again = await ledger.append([request]);
    expect(first.ok && !first.replayed).toBe(true);
    expect(again.ok && again.replayed).toBe(true);
    if (first.ok && again.ok) expect(again.entries[0]!.entryId).toBe(first.entries[0]!.entryId);
    expect(refusal(await ledger.append([{ ...request, amountMinor: 51 }]))).toBe(
      "idempotency_conflict",
    );
    expect((await ledger.balances(actor.agentId)).USD?.spent).toBe(50);
  });

  it("never draws more from a reservation, earning or purchase than it holds", async () => {
    const actor = await fundedActor("Ledger Bounds", 1000);
    const ledger = ledgerAt();
    const held = await ledger.append([entry(actor, "reservation", 300)]);
    if (!held.ok) throw new Error(refusal(held));
    const reservationId = held.entries[0]!.entryId;
    const bought = await ledger.append([
      entry(actor, "purchase", 250, {
        relatedEntryId: reservationId,
        contribution: { id: knowledgeId, version: 1 },
      }),
    ]);
    if (!bought.ok) throw new Error(refusal(bought));
    expect(
      refusal(
        await ledger.append([
          entry(actor, "reservation_release", 51, { relatedEntryId: reservationId }),
        ]),
      ),
    ).toBe("related_entry_exhausted");
    const purchaseId = bought.entries[0]!.entryId;
    expect(
      refusal(await ledger.append([entry(actor, "refund", 200, { relatedEntryId: purchaseId })])),
    ).toBe("ok");
    expect(
      refusal(await ledger.append([entry(actor, "refund", 51, { relatedEntryId: purchaseId })])),
    ).toBe("related_entry_exhausted");
    // A purchase must draw on a reservation of the same agent.
    const other = await fundedActor("Ledger Other", 100);
    expect(refusal(await ledger.append([entry(other, "reservation", 50)]))).toBe("ok");
    expect(
      refusal(
        await ledger.append([
          entry(other, "purchase", 10, {
            relatedEntryId: reservationId,
            contribution: { id: knowledgeId, version: 1 },
          }),
        ]),
      ),
    ).toBe("related_entry_invalid");
  });

  it("keeps entries append-only", async () => {
    const actor = await fundedActor("Ledger Append Only", 10);
    await expect(
      db
        .prepare("UPDATE ledger_entries SET amount_minor = 1 WHERE agent_id = ?")
        .bind(actor.agentId)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare("DELETE FROM ledger_entries WHERE agent_id = ?").bind(actor.agentId).run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("earnings", () => {
  /** An independent purchase of the Knowledge record by a funded buyer. */
  async function independentPurchase(amount: number) {
    const purchaser = await fundedActor("Earning Buyer", 10000);
    expect(
      (await controlsAt().setPolicy(policy(purchaser, { perTransactionLimitMinor: 1000 }))).ok,
    ).toBe(true);
    const held = await reserve(purchaser, amount);
    if (!held.ok) throw new Error(refusal(held));
    const bought = await ledgerAt().append([
      entry(purchaser, "purchase", amount, {
        relatedEntryId: held.entries[0]!.entryId,
        contribution: { id: knowledgeId, version: 1 },
        purchaseRef: key("purchase"),
      }),
    ]);
    if (!bought.ok) throw new Error(refusal(bought));
    return bought.entries[0]!;
  }

  const share = (purchaseId: number, amount: number, beneficiary = owner) =>
    entry(beneficiary, "contribution_revenue_share", amount, {
      relatedEntryId: purchaseId,
      contribution: { id: knowledgeId, version: 1 },
    });

  it("creates one pending earning per independent purchase, which settles or reverses", async () => {
    const ledger = ledgerAt();
    // Spare balances, so that only the per-earning bounds can refuse below.
    expect(refusal(await ledger.append([entry(owner, "operator_funding", 1000)]))).toBe("ok");
    const spare = await independentPurchase(400);
    expect(refusal(await ledger.append([share(spare.entryId, 300)]))).toBe("ok");

    const purchase = await independentPurchase(400);
    const earned = await ledger.append([share(purchase.entryId, 300)]);
    if (!earned.ok) throw new Error(refusal(earned));
    expect(earned.entries[0]!.toBucket).toBe("pending");
    expect(refusal(await ledger.append([share(purchase.entryId, 300)]))).toBe("duplicate_entry");

    const earningId = earned.entries[0]!.entryId;
    const settle = (amount: number) =>
      ledger.append([entry(owner, "settlement", amount, { relatedEntryId: earningId })]);
    expect(refusal(await settle(200))).toBe("ok");
    expect(
      refusal(await ledger.append([entry(owner, "reversal", 100, { relatedEntryId: earningId })])),
    ).toBe("ok");
    expect(refusal(await settle(1))).toBe("related_entry_exhausted");
    // A refund after finality claws back the settled part from available.
    expect(
      refusal(
        await ledger.append([
          entry(owner, "reversal", 200, { relatedEntryId: earningId, fromAvailable: true }),
        ]),
      ),
    ).toBe("ok");
    expect(
      refusal(
        await ledger.append([
          entry(owner, "reversal", 1, { relatedEntryId: earningId, fromAvailable: true }),
        ]),
      ),
    ).toBe("related_entry_exhausted");
  });

  it("never pays an earning for a self-purchase or to an agent other than the contributor", async () => {
    // The contributor's own operator buys its record.
    const sibling = await createAgent(owner.operatorId, "Owner Sibling");
    await ledgerAt().append([entry(sibling, "operator_funding", 1000)]);
    expect((await controlsAt().setPolicy(policy(sibling))).ok).toBe(true);
    const held = await reserve(sibling, 100);
    if (!held.ok) throw new Error(refusal(held));
    const bought = await ledgerAt().append([
      entry(sibling, "purchase", 100, {
        relatedEntryId: held.entries[0]!.entryId,
        contribution: { id: knowledgeId, version: 1 },
      }),
    ]);
    if (!bought.ok) throw new Error(refusal(bought));
    expect(refusal(await ledgerAt().append([share(bought.entries[0]!.entryId, 50)]))).toBe(
      "earning_not_eligible",
    );

    const purchase = await independentPurchase(100);
    expect(refusal(await ledgerAt().append([share(purchase.entryId, 50, sibling)]))).toBe(
      "earning_not_eligible",
    );
  });
});

describe("operator spending controls", () => {
  it("refuses a purchase reservation without a policy, or outside the permitted categories", async () => {
    const actor = await fundedActor("Controls Categories", 1000);
    expect(refusal(await reserve(actor, 10))).toBe("spending_policy_missing");
    expect(
      (await controlsAt().setPolicy(policy(actor, { permittedCategories: ["execution"] }))).ok,
    ).toBe(true);
    expect(refusal(await reserve(actor, 10, knowledgeId))).toBe("category_not_permitted");
    expect(refusal(await reserve(actor, 10, executionId))).toBe("ok");
    expect(
      (
        await controlsAt().setPolicy(
          policy(actor, { permittedCategories: ["knowledge:api-reference"] }),
        )
      ).ok,
    ).toBe(true);
    expect(refusal(await reserve(actor, 10, knowledgeId))).toBe("ok");
    expect(refusal(await reserve(actor, 10, executionId))).toBe("category_not_permitted");
  });

  it("enforces per-transaction, daily and monthly limits across all agents of the operator", async () => {
    const actor = await fundedActor("Controls Limits", 100000);
    const sibling = await createAgent(actor.operatorId, "Controls Limits Sibling");
    await ledgerAt().append([entry(sibling, "operator_funding", 100000)]);
    expect((await controlsAt().setPolicy(policy(actor))).ok).toBe(true);

    expect(refusal(await reserve(actor, 501))).toBe("per_transaction_limit");
    expect(refusal(await reserve(actor, 500))).toBe("ok");
    expect(refusal(await reserve(sibling, 500))).toBe("ok");
    // The daily limit of 1000 is used up by the two agents together.
    expect(refusal(await reserve(sibling, 1))).toBe("daily_limit");

    // A released reservation no longer counts toward the day.
    const held = await reserve(actor, 1, knowledgeId, START + DAY);
    if (!held.ok) throw new Error(refusal(held));
    const release = await ledgerAt(START + DAY).append([
      entry(actor, "reservation_release", 1, { relatedEntryId: held.entries[0]!.entryId }),
    ]);
    expect(release.ok).toBe(true);
    for (let day = 1; day <= 4; day++) {
      expect(refusal(await reserve(actor, 500, knowledgeId, START + day * DAY))).toBe("ok");
      expect(refusal(await reserve(sibling, 500, knowledgeId, START + day * DAY))).toBe("ok");
    }
    // 5000 reserved this month: the monthly limit is reached on a fresh day.
    expect(refusal(await reserve(actor, 1, knowledgeId, START + 5 * DAY))).toBe("monthly_limit");
  });

  it("keeps the minimum reserve unspent", async () => {
    const actor = await fundedActor("Controls Reserve", 1000);
    expect(
      (
        await controlsAt().setPolicy(
          policy(actor, {
            minimumReserveMinor: 600,
            perTransactionLimitMinor: 1000,
            dailyLimitMinor: 5000,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(refusal(await reserve(actor, 401))).toBe("minimum_reserve");
    expect(refusal(await reserve(actor, 400))).toBe("ok");
    expect(refusal(await reserve(actor, 700))).toBe("insufficient_balance");
  });

  it("blocks spending and withdrawals for a suspended agent or operator until resumed", async () => {
    const actor = await fundedActor("Controls Suspension", 1000);
    const sibling = await createAgent(actor.operatorId, "Controls Suspension Sibling");
    await ledgerAt().append([entry(sibling, "operator_funding", 1000)]);
    const controls = controlsAt();
    expect((await controls.setPolicy(policy(actor))).ok).toBe(true);

    expect(
      (
        await controls.suspend(
          { operatorId: actor.operatorId, agentId: actor.agentId },
          "lost key",
          "op",
        )
      ).ok,
    ).toBe(true);
    expect(await controls.isSuspended(actor.operatorId, actor.agentId)).toBe(true);
    expect(await controls.isSuspended(actor.operatorId, sibling.agentId)).toBe(false);
    expect(refusal(await reserve(actor, 10))).toBe("spending_suspended");
    expect(refusal(await ledgerAt().append([entry(actor, "reservation", 10)]))).toBe(
      "spending_suspended",
    );
    expect(refusal(await reserve(sibling, 10))).toBe("ok");

    expect(
      (await controls.suspend({ operatorId: actor.operatorId, agentId: null }, "incident", "op"))
        .ok,
    ).toBe(true);
    expect(refusal(await reserve(sibling, 10))).toBe("spending_suspended");
    expect(
      (await controls.resume({ operatorId: actor.operatorId, agentId: null }, "resolved", "op")).ok,
    ).toBe(true);
    expect(refusal(await reserve(sibling, 10))).toBe("ok");
    // The agent-level suspension still applies after the operator-wide one ends.
    expect(refusal(await reserve(actor, 10))).toBe("spending_suspended");
    expect(
      (
        await controls.resume(
          { operatorId: actor.operatorId, agentId: actor.agentId },
          "new key",
          "op",
        )
      ).ok,
    ).toBe(true);
    expect(refusal(await reserve(actor, 10))).toBe("ok");
  });

  it("validates policies and keeps their history", async () => {
    const actor = await createOperatorActor("Controls Validation");
    const controls = controlsAt();
    const bad = async (overrides: Partial<SpendingPolicyInput>) => {
      const result = await controls.setPolicy(policy(actor, overrides));
      return result.ok ? "ok" : result.error.field;
    };
    expect(await bad({ currency: "usd" })).toBe("currency");
    expect(await bad({ perTransactionLimitMinor: -1 })).toBe("perTransactionLimitMinor");
    expect(await bad({ perTransactionLimitMinor: 2000 })).toBe("perTransactionLimitMinor");
    expect(await bad({ dailyLimitMinor: 9000 })).toBe("dailyLimitMinor");
    expect(await bad({ permittedCategories: ["anything"] })).toBe("permittedCategories");
    expect(await bad({ setBy: " " })).toBe("setBy");
    expect(await bad({})).toBe("ok");
    expect(await bad({ perTransactionLimitMinor: 100 })).toBe("ok");
    expect((await controls.currentPolicy(actor.operatorId, "USD"))?.perTransactionLimitMinor).toBe(
      100,
    );
    await expect(
      db
        .prepare(
          "UPDATE operator_spending_policies SET daily_limit_minor = 0 WHERE operator_id = ?",
        )
        .bind(actor.operatorId)
        .run(),
    ).rejects.toThrow(/append-only/);
    expect(
      (await controls.suspend({ operatorId: actor.operatorId, agentId: null }, "test", "op")).ok,
    ).toBe(true);
    await expect(
      db
        .prepare("DELETE FROM spending_suspensions WHERE operator_id = ?")
        .bind(actor.operatorId)
        .run(),
    ).rejects.toThrow(/append-only/);
  });
});
