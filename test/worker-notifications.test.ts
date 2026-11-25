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
import { Ledger } from "../src/payments/ledger";
import { issueEarnings } from "../src/payments/earnings";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../src/seed/httpbin";
import { NOTIFY_CRON, notifyNew } from "../src/notify/notifications";
import { telegramOf } from "../src/notify/telegram";
import { runRemoteReview } from "../src/review/client";
import worker from "../src/index";
import { listVersion } from "./helpers/quality";

// Test-only placeholders, not real credentials.
const TOKEN = "test-only-Reviewer-Token-0123456789abcdefghijKLMNOP";
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const START = Date.parse("2026-11-20T08:00:00.000Z");
const DAY = 86_400_000;

interface Actor {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
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

/** Messages "delivered" to Telegram; `deliver` false makes delivery fail. */
const telegram = { sent: [] as string[], deliver: true };
const SEND = async (text: string) => {
  if (!telegram.deliver) return false;
  telegram.sent.push(text);
  return true;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-notifications-"));
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
  owner = await actor("Notify Owner", true);
}, 180_000);

afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Json = {}, atMs = START) =>
  ({
    DB: db,
    CONTENT_BUCKET: proxy.env.CONTENT_BUCKET,
    NOW: () => new Date(atMs),
    REVIEW_INTERFACE: "on",
    REVIEWER_ID: "pilot-reviewer",
    REVIEWER_TOKEN: TOKEN,
    NOTIFICATIONS: "telegram",
    TELEGRAM_SEND: SEND,
    // No network for the daily trigger's source re-checks.
    SOURCE_FETCHER: async () => new Response("", { status: 503 }),
    ...extra,
  }) as never;

async function actor(name: string, allowListed = false): Promise<Actor> {
  const operator = await identity.createOperator({ kind: "organization", displayName: name });
  if (allowListed) {
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(operator.id)
      .run();
  }
  const agent = await identity.registerAgent(operator.id, { displayName: `${name} ${++counter}` });
  await credentials.issueCredential(agent.id, { label: name });
  return { agentId: agent.id, operatorId: operator.id };
}

const at = (ms = START) => new Date(ms).toISOString();
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

async function enroll(a: Actor): Promise<string> {
  const address = `0x${hex(++counter, 40)}`;
  await db
    .prepare(
      "INSERT INTO wallet_accounts (address, operator_id, agent_id, enrolled_at) VALUES (?, ?, ?, ?)",
    )
    .bind(address, a.operatorId, a.agentId, at())
    .run();
  return address;
}

async function contribute(family: "knowledge" | "execution", listed: boolean): Promise<string> {
  const seed = family === "knowledge" ? HTTPBIN_KNOWLEDGE_SEED : HTTPBIN_EXECUTION_SEED;
  const created = await registry.createContribution(owner.agentId, {
    ...seed,
    title: `notifyword ${family} ${++counter}`,
  } as never);
  if (!created.ok) throw new Error(created.error.code);
  if (listed) await listVersion(proxy.env, created.contribution.id);
  return created.contribution.id;
}

async function deposit(a: Actor, from: string, amountMinor: number) {
  const txHash = `0x${hex(++counter, 64)}`;
  const funded = await new Ledger(db, () => new Date(START)).append([
    {
      idempotencyKey: `deposit:84532:${txHash}:0`,
      agentId: a.agentId,
      operatorId: a.operatorId,
      entryType: "operator_funding",
      amountMinor,
      currency: "USDC",
    },
  ]);
  if (!funded.ok) throw new Error(funded.error.code);
  await db
    .prepare(
      `INSERT INTO chain_deposits (chain_id, tx_hash, log_index, token_address, from_address,
         to_address, amount_minor, block_number, block_hash, ledger_entry_id, credited_at)
       VALUES (84532, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      txHash,
      `0x${hex(1, 40)}`,
      from,
      `0x${hex(2, 40)}`,
      amountMinor,
      `0x${hex(1, 64)}`,
      funded.entries[0]!.entryId,
      at(),
    )
    .run();
}

/** A payout request for the operator's wallet; approved when asked. */
async function payout(a: Actor, destination: string, amountMinor: number, approved: boolean) {
  const held = await new Ledger(db, () => new Date(START)).append([
    {
      idempotencyKey: `payout-hold-${++counter}`,
      agentId: a.agentId,
      operatorId: a.operatorId,
      entryType: "reservation",
      amountMinor,
      currency: "USDC",
    },
  ]);
  if (!held.ok) throw new Error(held.error.code);
  const request = await db
    .prepare(
      `INSERT INTO payout_requests (operator_id, agent_id, destination, amount_minor, currency,
         reservation_entry_id, requested_at)
       VALUES (?, ?, ?, ?, 'USDC', ?, ?) RETURNING request_id`,
    )
    .bind(a.operatorId, a.agentId, destination, amountMinor, held.entries[0]!.entryId, at())
    .first<{ request_id: number }>();
  if (approved) {
    await db
      .prepare(
        `INSERT INTO payout_events (request_id, event, reason, set_by, created_at)
         VALUES (?, 'approved', 'policy', 'test', ?)`,
      )
      .bind(request!.request_id, at())
      .run();
  }
  return request!.request_id;
}

const message = () => telegram.sent.at(-1) ?? "";

describe("Telegram settings", () => {
  it("is off unless configured, and invalid without a well-formed token and chat ID", () => {
    expect(telegramOf({}).mode).toBe("off");
    expect(telegramOf({ NOTIFICATIONS: "off" }).mode).toBe("off");
    expect(telegramOf({ NOTIFICATIONS: "email" }).mode).toBe("invalid");
    expect(telegramOf({ NOTIFICATIONS: "telegram", TELEGRAM_CHAT_ID: "42" }).mode).toBe("invalid");
    expect(
      telegramOf({
        NOTIFICATIONS: "telegram",
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_CHAT_ID: "x",
      }).mode,
    ).toBe("invalid");
    expect(
      telegramOf({ NOTIFICATIONS: "telegram", TELEGRAM_BOT_TOKEN: "abc", TELEGRAM_CHAT_ID: "42" })
        .mode,
    ).toBe("invalid");
    expect(
      telegramOf({
        NOTIFICATIONS: "telegram",
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_CHAT_ID: "-100123",
      }).mode,
    ).toBe("on");
  });

  it("sends nothing while off", async () => {
    await contribute("knowledge", false);
    expect(await notifyNew(db, { NOTIFICATIONS: "off" })).toEqual({ status: "off", items: 0 });
    await worker.scheduled({ cron: NOTIFY_CRON }, env({ NOTIFICATIONS: undefined }));
    expect(telegram.sent).toEqual([]);
  });
});

describe("new-item notifications", () => {
  let buyer: Actor;
  let wallet: string;
  let executionId: string;
  let dueRequest: number;

  it("announces the owner's work on the first run and records existing activity silently", async () => {
    buyer = await actor("Notify Buyer");
    wallet = await enroll(buyer);
    await deposit(buyer, wallet, 5_000_000);
    const knowledgeId = await contribute("knowledge", false);
    executionId = await contribute("execution", true);
    dueRequest = await payout(buyer, wallet, 1_000_000, true);

    await worker.scheduled({ cron: NOTIFY_CRON }, env());
    expect(telegram.sent).toHaveLength(1);
    const text = message();
    expect(text).toContain("Manual payments due from you (1)");
    expect(text).toContain(`#${dueRequest}: send 1 USDC to ${wallet}`);
    expect(text).toContain(`payout-sent ${dueRequest} <txHash>`);
    expect(text).toContain(`validate ${executionId} 1`);
    expect(text).toContain(`inspect ${knowledgeId} 1`);
    // Existing activity is not announced on the first run.
    expect(text).not.toContain("Deposits credited");
    expect(text).not.toContain("New operators");
    expect(text).not.toContain(TOKEN);

    // Nothing new: nothing is sent again.
    expect((await notifyNew(db, env() as never)).status).toBe("nothing");
    await worker.scheduled({ cron: NOTIFY_CRON }, env());
    expect(telegram.sent).toHaveLength(1);
  });

  it("announces new activity once, and retries after a failed delivery", async () => {
    const verifier = await actor("Notify Verifier");
    const verifierWallet = await enroll(verifier);
    await deposit(verifier, verifierWallet, 2_000_000);
    const waiting = await payout(verifier, verifierWallet, 1_000_000, false);
    await db
      .prepare(
        `INSERT INTO needs_reports (id, operator_id, agent_id, fingerprint, category, summary,
           desired_outcome, search_terms_json, created_at, last_reported_at, expires_at)
         VALUES (?, ?, ?, ?, 'missing_information', 'notifyword rate limits for an API',
           'A reference', '["rate limits"]', ?, ?, ?)`,
      )
      .bind(
        `need-${++counter}`,
        verifier.operatorId,
        verifier.agentId,
        "c".repeat(64),
        at(),
        at(),
        at(START + 90 * DAY),
      )
      .run();
    // The platform validated the recipe and the verifier reported a successful run: verified,
    // and the verifier earns the reward.
    await db.batch([
      db
        .prepare(
          `INSERT INTO platform_validations (contribution_id, version, action, note, set_by,
             created_at) VALUES (?, 1, 'validate', 'checked', 'pilot-reviewer', ?)`,
        )
        .bind(executionId, at()),
      db
        .prepare(
          `INSERT INTO feedback_reports (consumer_operator_id, agent_id, contribution_id, version,
             dimension, assessment_json) VALUES (?, ?, ?, 1, 'outcome', ?)`,
        )
        .bind(
          verifier.operatorId,
          verifier.agentId,
          executionId,
          JSON.stringify({ finding: "success", observedAt: at(), steps: [] }),
        ),
      db
        .prepare(
          `INSERT INTO version_trust (contribution_id, version, source_status, verified, updated_at)
           VALUES (?, 1, 'none', 1, ?)
           ON CONFLICT (contribution_id, version) DO UPDATE SET verified = 1`,
        )
        .bind(executionId, at()),
    ]);
    await issueEarnings(db, executionId, 1, () => new Date(START), { rewards: true });
    const reward = await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'task_earning'")
      .first<{ n: number }>();
    expect(reward?.n).toBe(1);

    telegram.deliver = false;
    expect((await notifyNew(db, env() as never)).status).toBe("failed");
    expect(telegram.sent).toHaveLength(1);
    telegram.deliver = true;

    await worker.scheduled({ cron: NOTIFY_CRON }, env());
    expect(telegram.sent).toHaveLength(2);
    const text = message();
    expect(text).toContain("Verified by an external operator (1)");
    expect(text).toContain(`verified by operator ${verifier.operatorId}; reward 0.025 USDC earned`);
    expect(text).toContain("New outcome and accuracy reports (1)");
    expect(text).toContain(`outcome success, from operator ${verifier.operatorId}`);
    expect(text).toContain("Payouts waiting for the operator's wallet approval (1)");
    expect(text).toContain(`#${waiting}: 1 USDC`);
    expect(text).toContain("Deposits credited (1)");
    expect(text).toContain("2 USDC from operator");
    expect(text).toContain("New operators (1)");
    expect(text).toContain("New needs reports (1)");
    expect(text).toContain("missing_information: notifyword rate limits");
    // Already announced: the due payout and the validation are not repeated.
    expect(text).not.toContain("Manual payments due");
    expect(text).not.toContain("waiting for your validation");

    await worker.scheduled({ cron: NOTIFY_CRON }, env());
    expect(telegram.sent).toHaveLength(2);
    // The record is append-only.
    await expect(db.prepare("DELETE FROM notifications_sent").run()).rejects.toThrow(/append-only/);
  });

  it("sends a daily summary with what is still waiting and the reconciliation result", async () => {
    await worker.scheduled({ cron: "17 3 * * *" }, env({}, START + DAY));
    const text = message();
    expect(text.startsWith("Agent Commons: daily summary")).toBe(true);
    expect(text).toContain(`Activity since ${at(START).slice(0, 10)} (UTC)`);
    expect(text).toContain("Deposits 7 USDC");
    expect(text).toContain("verification rewards 0.025 USDC");
    expect(text).toContain("New operators 2");
    expect(text).toContain(`Payouts to send 1 (1 USDC)`);
    expect(text).toContain("Payouts awaiting operator approval 1");
    expect(text).toMatch(/Reconciliation/);
  });
});

describe("notify review command", () => {
  const notify = (body: Json, extra: Json = {}) =>
    worker.fetch(
      new Request("https://example.com/v1/review/notify", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env(extra),
    );

  it("sends a test message, runs the jobs on demand and reports the configuration", async () => {
    const test = await notify({});
    expect(test.status).toBe(200);
    expect(await test.json()).toMatchObject({
      schemaVersion: "notify-result/v1",
      action: "test",
      status: "sent",
    });
    expect(message()).toContain("test notification");
    expect(((await (await notify({ action: "now" })).json()) as Json).status).toBe("nothing");
    expect(((await (await notify({ action: "digest" })).json()) as Json).status).toBe("sent");
    expect(message()).toContain("daily summary");

    expect((await notify({ action: "nope" })).status).toBe(400);
    expect((await notify({}, { NOTIFICATIONS: undefined })).status).toBe(409);
    const invalid = await notify({}, { TELEGRAM_SEND: undefined });
    expect(invalid.status).toBe(503);
    telegram.deliver = false;
    expect((await notify({})).status).toBe(502);
    telegram.deliver = true;
  });

  it("is available from the remote review client", async () => {
    const seen: Json[] = [];
    const fake = (async (url: URL, init?: RequestInit) => {
      seen.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const options = { baseUrl: "https://commons.example.org", token: TOKEN };
    expect((await runRemoteReview(["notify"], options, fake)).exitCode).toBe(0);
    expect((await runRemoteReview(["notify", "now"], options, fake)).exitCode).toBe(0);
    expect((await runRemoteReview(["notify", "later"], options, fake)).exitCode).not.toBe(0);
    expect(seen).toEqual([
      { path: "/v1/review/notify", body: { action: "test" } },
      { path: "/v1/review/notify", body: { action: "now" } },
    ]);
  });
});
