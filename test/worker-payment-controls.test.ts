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
import { Ledger, type LedgerEntryInput } from "../src/payments/ledger";
import { quote, type PriceList } from "../src/payments/pricing";
import type { PaymentProvider, ChargeRequest } from "../src/payments/provider";
import { SpendingControls } from "../src/payments/spending-controls";
import { runRemoteReview } from "../src/review/client";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

// Test-only placeholder, not a real credential.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const START = Date.parse("2026-11-18T10:00:00.000Z");

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

const charges: ChargeRequest[] = [];
const PROVIDER: PaymentProvider = {
  name: "test",
  async charge(request) {
    charges.push(request);
    return { ok: true, providerRef: `test:${request.purchaseRef}` };
  },
  async refund() {
    return { ok: true };
  },
};
const PRICES: PriceList = (family) => quote(family === "knowledge" ? 400 : 0, "USDC");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-payment-controls-"));
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
  owner = await actor("Controls Owner", true);
  const registry = new ContributionRegistry(proxy.env, { now: () => new Date(START) });
  const knowledge = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_KNOWLEDGE_SEED,
    title: "controlsword knowledge record",
  });
  if (!knowledge.ok) throw new Error(knowledge.error.code);
  knowledgeId = knowledge.contribution.id;
  await listVersion(proxy.env, knowledgeId);
  const execution = await registry.createContribution(owner.agentId, {
    ...HTTPBIN_EXECUTION_SEED,
    title: "controlsword execution record",
  } as never);
  if (!execution.ok) throw new Error(execution.error.code);
  executionId = execution.contribution.id;
  await listVersion(proxy.env, executionId);
  // Both records verified, so purchases earn and Execution rewards are possible.
  for (const id of [knowledgeId, executionId]) {
    await db
      .prepare(
        `INSERT INTO version_trust (contribution_id, version, source_status, verified, updated_at)
         VALUES (?, 1, 'matched', 1, ?)`,
      )
      .bind(id, new Date(START).toISOString())
      .run();
  }
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
    PAYMENT_PROVIDER: PROVIDER,
    PRICE_LIST: PRICES,
    ...extra,
  }) as never;

async function post(path: string, body: unknown, token: string) {
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(),
  );
  return { status: response.status, body: (await response.json()) as Json };
}
const review = (op: string, body: Json = {}) => post(`/v1/review/${op}`, body, TOKEN);

const key = (label: string) => `test-${label}-${++counter}`;
const ledger = () => new Ledger(db, () => new Date(START));
const entry = (
  a: Actor,
  entryType: LedgerEntryInput["entryType"],
  amountMinor: number,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput => ({
  idempotencyKey: key(entryType),
  agentId: a.agentId,
  operatorId: a.operatorId,
  entryType,
  amountMinor,
  currency: "USDC",
  ...extra,
});
const code = (r: Awaited<ReturnType<Ledger["append"]>>) => (r.ok ? "ok" : r.error.code);

async function buyerWithPolicy(name: string) {
  const a = await actor(name);
  const set = await new SpendingControls(db, () => new Date(START)).setPolicy({
    operatorId: a.operatorId,
    currency: "USDC",
    perTransactionLimitMinor: 1000,
    dailyLimitMinor: 5000,
    monthlyLimitMinor: 20000,
    minimumReserveMinor: 0,
    maxAutonomousBalanceMinor: 100000,
    permittedCategories: ["knowledge", "execution"],
    withdrawalsNeedApproval: true,
    setBy: "test",
  });
  expect(set.ok).toBe(true);
  return a;
}

/** A verifier operator with a successful outcome report on the Execution record. */
async function verifier(name: string) {
  const a = await actor(name);
  await db
    .prepare(
      `INSERT INTO feedback_reports (consumer_operator_id, agent_id, contribution_id, version,
         dimension, assessment_json)
       VALUES (?, ?, ?, 1, 'outcome', '{"finding":"success"}')`,
    )
    .bind(a.operatorId, a.agentId, executionId)
    .run();
  return a;
}
const reward = (a: Actor) =>
  entry(a, "task_earning", 25_000, { contribution: { id: executionId, version: 1 } });

describe("emergency stop", () => {
  it("stops every payment at once, keeps unwinding possible, and restarts", async () => {
    const buyer = await buyerWithPolicy("Stop Buyer");
    const funded = await ledger().append([entry(buyer, "operator_funding", 1000)]);
    expect(funded.ok).toBe(true);
    const held = await ledger().append([entry(buyer, "reservation", 100)]);
    if (!held.ok) throw new Error(code(held));

    const stopped = await review("payments", { action: "stop", reason: "Incident drill" });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      schemaVersion: "payment-controls/v1",
      stopped: true,
      reason: "Incident drill",
    });

    expect(code(await ledger().append([entry(buyer, "operator_funding", 1)]))).toBe(
      "payments_stopped",
    );
    expect(code(await ledger().append([entry(buyer, "reservation", 1)]))).toBe("payments_stopped");
    // A purchase is refused before anything is charged.
    const before = charges.length;
    const bought = await post(
      "/v1/commons/purchase",
      { contributionId: knowledgeId, version: 1, idempotencyKey: key("stopped") },
      buyer.token,
    );
    expect(bought.status).toBe(503);
    expect(bought.body.error.code).toBe("payments_stopped");
    expect(charges.length).toBe(before);
    // Unwinding still works.
    expect(
      code(
        await ledger().append([
          entry(buyer, "reservation_release", 100, { relatedEntryId: held.entries[0]!.entryId }),
        ]),
      ),
    ).toBe("ok");

    expect((await review("payments", { action: "start", reason: "Drill over" })).body.stopped).toBe(
      false,
    );
    expect(code(await ledger().append([entry(buyer, "operator_funding", 1)]))).toBe("ok");
  });

  it("validates control requests", async () => {
    expect((await review("payments", { action: "stop" })).status).toBe(400);
    expect((await review("payments", { action: "pause", reason: "x" })).status).toBe(400);
    expect((await review("payments", { action: "cap", capMinor: -1, reason: "x" })).status).toBe(
      400,
    );
    expect((await review("payments", { action: "stop", reason: "x", extra: 1 })).status).toBe(400);
    expect((await post("/v1/review/payments", {}, "wrong-token")).status).toBe(401);
  });
});

describe("reward cap", () => {
  it("defaults to 100 USDC and refuses rewards above the cap", async () => {
    const state = await review("payments");
    expect(state.body).toMatchObject({ rewardCapMinor: 100_000_000, rewardCapIsDefault: true });

    expect(
      (await review("payments", { action: "cap", capMinor: 25_000, reason: "test" })).status,
    ).toBe(200);
    const first = await verifier("Capped Verifier One");
    const second = await verifier("Capped Verifier Two");
    expect(code(await ledger().append([reward(first)]))).toBe("ok");
    expect(code(await ledger().append([reward(second)]))).toBe("reward_cap_reached");

    expect(
      (await review("payments", { action: "cap", capMinor: 100_000_000, reason: "restore" })).body
        .rewardCapIsDefault,
    ).toBe(false);
    expect(code(await ledger().append([reward(second)]))).toBe("ok");
  });
});

describe("platform ledger summary", () => {
  it("reports what is owed to agents, fee income and reward exposure", async () => {
    const buyer = await buyerWithPolicy("Summary Buyer");
    const bought = await post(
      "/v1/commons/purchase",
      { contributionId: knowledgeId, version: 1, idempotencyKey: key("summary") },
      buyer.token,
    );
    expect(bought.body.status).toBe("purchased");

    const summary = await review("ledger");
    expect(summary.status).toBe(200);
    expect(summary.body.schemaVersion).toBe("platform-ledger/v1");
    const usdc = (summary.body.currencies as Json[]).find((c) => c.currency === "USDC")!;
    // Totals across this file: one 400 purchase with a 200 contributor share, two rewards.
    expect(usdc).toMatchObject({
      purchasesNetMinor: 400,
      contributorSharesNetMinor: 200,
      feeIncomeMinor: 200,
      rewardsNetMinor: 50_000,
      netPositionMinor: 200 - 50_000,
    });
    expect(usdc.owedToAgents.pendingMinor).toBe(200 + 50_000);
    expect(usdc.owedToAgents.totalMinor).toBe(
      usdc.owedToAgents.pendingMinor +
        usdc.owedToAgents.availableMinor +
        usdc.owedToAgents.reservedMinor,
    );
    expect(summary.body.controls).toMatchObject({
      stopped: false,
      rewardsIssuedNetMinor: 50_000,
      rewardCapRemainingMinor: 100_000_000 - 50_000,
    });
  });
});

describe("agent account view", () => {
  it("shows the agent's balances, recent entries and its operator's policy and spending", async () => {
    const buyer = await buyerWithPolicy("Account Buyer");
    await post(
      "/v1/commons/purchase",
      { contributionId: knowledgeId, version: 1, idempotencyKey: key("account") },
      buyer.token,
    );
    const account = await post("/v1/commons/account", {}, buyer.token);
    expect(account.status).toBe(200);
    expect(account.body).toMatchObject({
      schemaVersion: "account/v1",
      agentId: buyer.agentId,
      operatorId: buyer.operatorId,
      currency: "USDC",
      suspended: false,
      paymentsStopped: false,
      operatorSpentMinor: { today: 400, month: 400 },
      policy: { perTransactionLimitMinor: 1000 },
    });
    expect(account.body.balances.USDC).toMatchObject({ spent: 400, available: 0 });
    expect(account.body.recentEntries[0].entryType).toBe("purchase");

    expect(
      (await post("/v1/commons/account", { agentId: owner.agentId }, buyer.token)).status,
    ).toBe(400);
    expect((await post("/v1/commons/account", {}, "not-a-token")).status).toBe(401);
  });
});

describe("remote review client", () => {
  it("sends payment control and ledger commands", async () => {
    const sent: Json[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      sent.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const config = { baseUrl: "https://commons.example.org", token: TOKEN };
    for (const argv of [
      ["ledger"],
      ["payments"],
      ["payments", "stop", "incident"],
      ["payments", "cap", "50000000", "first month"],
    ]) {
      expect((await runRemoteReview(argv, config, fake)).exitCode, argv.join(" ")).toBe(0);
    }
    expect(sent).toEqual([
      { path: "/v1/review/ledger", body: {} },
      { path: "/v1/review/payments", body: {} },
      { path: "/v1/review/payments", body: { action: "stop", reason: "incident" } },
      {
        path: "/v1/review/payments",
        body: { action: "cap", capMinor: 50_000_000, reason: "first month" },
      },
    ]);
    expect((await runRemoteReview(["payments", "pause", "x"], config, fake)).exitCode).toBe(2);
  });
});
