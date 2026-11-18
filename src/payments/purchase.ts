/**
 * Purchase flow (Phase 6, sandbox payments only). A purchase buys the licence
 * `operator-version-perpetual` for one exact listed version: every agent of the buying operator
 * may then retrieve it. Two ways to pay:
 *
 * - `provider`: the payment provider charges the amount, which is recorded as operator funding and
 *   spent at once. Only the sandbox provider exists; it moves no real money.
 * - `balance`: the agent's available ledger balance pays.
 *
 * Order: check the operator's spending controls first (so a refused purchase is never charged),
 * charge, then record funding, reservation, purchase, entitlement and (when already due) the
 * contributor's earning in one D1 batch. D1 triggers
 * re-check every control in that batch; if the batch is refused after a charge, the charge is
 * refunded. Retrying with the same idempotency key never charges or records twice.
 */
import { issueEarningsStatement } from "./earnings";
import { ledgerRefusalOf, type LedgerRefusal } from "./ledger";
import { LICENCE_OPERATOR_VERSION_PERPETUAL, type PriceList, type PriceQuote } from "./pricing";
import type { ChargeRequest, PaymentProvider } from "./provider";

export type PaymentMethod = "provider" | "balance";

export interface PurchaseRequest {
  readonly agentId: string;
  readonly operatorId: string;
  readonly contributionId: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly method: PaymentMethod;
}

export interface Entitlement {
  readonly licence: typeof LICENCE_OPERATOR_VERSION_PERPETUAL;
  readonly grantedAt: string;
}

export type PurchaseRefusal =
  | "not_found"
  | "payment_declined"
  | "provider_unavailable"
  | "licence_withdrawn"
  | Exclude<LedgerRefusal, "duplicate_entry" | "idempotency_conflict">;

export type PurchaseOutcome =
  | {
      readonly ok: true;
      readonly status: "purchased" | "already_entitled" | "not_required";
      readonly price: PriceQuote;
      readonly replayed: boolean;
      readonly entitlement: Entitlement | null;
    }
  | { readonly ok: false; readonly code: PurchaseRefusal; readonly price: PriceQuote | null };

export type AccessDecision =
  | { readonly required: false }
  | { readonly required: true; readonly entitled: boolean; readonly price: PriceQuote };

interface VersionRow {
  family: "knowledge" | "execution";
  contributor_operator_id: string;
  verified: number;
}

const VERSION_SQL = `SELECT v.family, c.contributor_operator_id, COALESCE(t.verified, 0) AS verified
  FROM contribution_versions v
  JOIN contributions c ON c.id = v.contribution_id
  JOIN version_quality_states q
    ON q.contribution_id = v.contribution_id AND q.version = v.version
  LEFT JOIN version_trust t ON t.contribution_id = v.contribution_id AND t.version = v.version
  WHERE v.contribution_id = ? AND v.version = ? AND q.state = 'listed_unverified'`;

/** A licence that still gives access: withdrawn (refunded) licences do not count. */
const ENTITLEMENT_SQL = `SELECT granted_at FROM purchase_entitlements e
  WHERE e.operator_id = ? AND e.contribution_id = ? AND e.version = ?
    AND NOT EXISTS (SELECT 1 FROM entitlement_revocations r
                    WHERE r.purchase_entry_id = e.purchase_entry_id)`;

/** One licence per operator and version: a refunded one cannot be bought again. */
const WITHDRAWN_SQL = `SELECT 1 FROM purchase_entitlements e
  JOIN entitlement_revocations r ON r.purchase_entry_id = e.purchase_entry_id
  WHERE e.operator_id = ? AND e.contribution_id = ? AND e.version = ?`;

const REPLAY_SQL = `SELECT e.granted_at FROM purchase_entitlements e
  JOIN ledger_entries p ON p.entry_id = e.purchase_entry_id
  WHERE p.purchase_ref = ? AND p.agent_id = ? AND p.entry_type = 'purchase'
    AND p.contribution_id = ? AND p.version = ?`;

const LATEST_POLICY = `(SELECT %COL% FROM operator_spending_policies
  WHERE operator_id = ?1 AND currency = ?2 ORDER BY policy_id DESC LIMIT 1)`;
const policyCol = (col: string) => LATEST_POLICY.replace("%COL%", col);
const periodSpent = (chars: number) => `(SELECT COALESCE(SUM(r.amount_minor - COALESCE(
    (SELECT SUM(x.amount_minor) FROM ledger_entries x
     WHERE x.related_entry_id = r.entry_id AND x.entry_type = 'reservation_release'), 0)), 0)
  FROM ledger_entries r
  WHERE r.operator_id = ?1 AND r.currency = ?2 AND r.entry_type = 'reservation'
    AND r.contribution_id IS NOT NULL AND substr(r.created_at, 1, ${chars}) = substr(?6, 1, ${chars}))`;

/**
 * Read-only mirror of the D1 purchase-reservation triggers (migration 0014), evaluated before any
 * charge. The triggers stay authoritative.
 */
const PRECHECK_SQL = `SELECT
  EXISTS (SELECT 1 FROM operators WHERE id = ?1 AND status <> 'active')
    OR EXISTS (SELECT 1 FROM agents WHERE id = ?3 AND status <> 'active')
    OR COALESCE((SELECT action FROM spending_suspensions WHERE operator_id = ?1 AND agent_id IS NULL
                 ORDER BY suspension_id DESC LIMIT 1), '') = 'suspend'
    OR COALESCE((SELECT action FROM spending_suspensions WHERE operator_id = ?1 AND agent_id = ?3
                 ORDER BY suspension_id DESC LIMIT 1), '') = 'suspend' AS suspended,
  COALESCE((SELECT action FROM platform_payment_controls ORDER BY control_id DESC LIMIT 1), '')
    = 'stop' AS stopped,
  EXISTS (SELECT 1 FROM operator_spending_policies WHERE operator_id = ?1 AND currency = ?2)
    AS has_policy,
  EXISTS (SELECT 1 FROM contribution_versions v, json_each(${policyCol("permitted_categories_json")}) c
          WHERE v.contribution_id = ?4 AND v.version = ?5
            AND (c.value = v.family OR c.value = v.family || ':' || v.content_type)) AS permitted,
  ${policyCol("per_transaction_limit_minor")} AS per_transaction,
  ${policyCol("daily_limit_minor")} AS daily,
  ${policyCol("monthly_limit_minor")} AS monthly,
  ${policyCol("minimum_reserve_minor")} AS reserve,
  ${periodSpent(10)} AS spent_today,
  ${periodSpent(7)} AS spent_month,
  (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
   WHERE agent_id = ?3 AND currency = ?2 AND to_bucket = 'available')
  - (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
     WHERE agent_id = ?3 AND currency = ?2 AND from_bucket = 'available') AS available`;

interface PrecheckRow {
  suspended: number;
  stopped: number;
  has_policy: number;
  permitted: number;
  per_transaction: number | null;
  daily: number | null;
  monthly: number | null;
  reserve: number | null;
  spent_today: number;
  spent_month: number;
  available: number;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function purchaseRefOf(agentId: string, idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`agent-commons/purchase\n${agentId}\n${idempotencyKey}`),
  );
  return `pur_${toHex(new Uint8Array(digest)).slice(0, 40)}`;
}

export class PurchaseService {
  constructor(
    private readonly db: D1Database,
    private readonly prices: PriceList,
    private readonly provider: PaymentProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether retrieving this listed version needs a purchase, and whether the operator has one. */
  async access(
    operatorId: string,
    contributionId: string,
    version: number,
  ): Promise<AccessDecision> {
    const row = await this.version(contributionId, version);
    if (!row) return { required: false };
    const price = this.prices(row.family, row.verified === 1);
    if (!price.paymentRequired || row.contributor_operator_id === operatorId) {
      return { required: false };
    }
    const entitlement = await this.db
      .prepare(ENTITLEMENT_SQL)
      .bind(operatorId, contributionId, version)
      .first();
    return { required: true, entitled: entitlement !== null, price };
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const row = await this.version(request.contributionId, request.version);
    if (!row) return { ok: false, code: "not_found", price: null };
    const price = this.prices(row.family, row.verified === 1);
    const done = (
      status: "purchased" | "already_entitled" | "not_required",
      grantedAt: string | null,
      replayed = false,
    ): PurchaseOutcome => ({
      ok: true,
      status,
      price,
      replayed,
      entitlement:
        grantedAt === null ? null : { licence: LICENCE_OPERATOR_VERSION_PERPETUAL, grantedAt },
    });
    if (!price.paymentRequired || row.contributor_operator_id === request.operatorId) {
      return done("not_required", null);
    }

    const ref = await purchaseRefOf(request.agentId, request.idempotencyKey);
    const replay = await this.replayOf(ref, request);
    if (replay) return done("purchased", replay, true);
    const held = await this.entitledAt(request);
    if (held) return done("already_entitled", held);
    const withdrawn = await this.db
      .prepare(WITHDRAWN_SQL)
      .bind(request.operatorId, request.contributionId, request.version)
      .first();
    if (withdrawn) return { ok: false, code: "licence_withdrawn", price };

    const refusal = await this.precheck(request, price);
    if (refusal) return { ok: false, code: refusal, price };

    const charge: ChargeRequest = {
      purchaseRef: ref,
      operatorId: request.operatorId,
      agentId: request.agentId,
      amountMinor: price.amountMinor,
      currency: price.currency,
    };
    let providerRef: string | null = null;
    if (request.method === "provider") {
      const charged = await this.provider.charge(charge);
      if (!charged.ok) return { ok: false, code: charged.code, price };
      providerRef = charged.providerRef;
    }

    const grantedAt = this.now().toISOString();
    try {
      await this.db.batch(this.recordStatements(ref, request, price, grantedAt));
    } catch (error) {
      const code = ledgerRefusalOf(error);
      const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
      // A concurrent retry with the same key recorded it first: report that purchase.
      const raced = await this.replayOf(ref, request);
      if (raced) return done("purchased", raced, true);
      if (providerRef !== null) await this.provider.refund(providerRef, charge);
      if (/purchase_entitlements/.test(message)) {
        const other = await this.entitledAt(request);
        if (other) return done("already_entitled", other);
      }
      if (code && code !== "duplicate_entry" && code !== "idempotency_conflict") {
        return { ok: false, code, price };
      }
      throw error;
    }
    return done("purchased", grantedAt);
  }

  private version(contributionId: string, version: number) {
    return this.db.prepare(VERSION_SQL).bind(contributionId, version).first<VersionRow>();
  }

  private async replayOf(ref: string, request: PurchaseRequest): Promise<string | null> {
    const row = await this.db
      .prepare(REPLAY_SQL)
      .bind(ref, request.agentId, request.contributionId, request.version)
      .first<{ granted_at: string }>();
    return row?.granted_at ?? null;
  }

  private async entitledAt(request: PurchaseRequest): Promise<string | null> {
    const row = await this.db
      .prepare(ENTITLEMENT_SQL)
      .bind(request.operatorId, request.contributionId, request.version)
      .first<{ granted_at: string }>();
    return row?.granted_at ?? null;
  }

  private async precheck(
    request: PurchaseRequest,
    price: PriceQuote,
  ): Promise<PurchaseRefusal | null> {
    const row = await this.db
      .prepare(PRECHECK_SQL)
      .bind(
        request.operatorId,
        price.currency,
        request.agentId,
        request.contributionId,
        request.version,
        this.now().toISOString(),
      )
      .first<PrecheckRow>();
    if (!row) return "spending_policy_missing";
    const amount = price.amountMinor;
    if (row.stopped === 1) return "payments_stopped";
    if (row.suspended === 1) return "spending_suspended";
    if (row.has_policy !== 1) return "spending_policy_missing";
    if (row.permitted !== 1) return "category_not_permitted";
    if (amount > (row.per_transaction ?? 0)) return "per_transaction_limit";
    if (row.spent_today + amount > (row.daily ?? 0)) return "daily_limit";
    if (row.spent_month + amount > (row.monthly ?? 0)) return "monthly_limit";
    // A provider charge is recorded as funding just before the reservation.
    const available = row.available + (request.method === "provider" ? amount : 0);
    if (available < amount) return "insufficient_balance";
    if (available - amount < (row.reserve ?? 0)) return "minimum_reserve";
    return null;
  }

  private recordStatements(
    ref: string,
    request: PurchaseRequest,
    price: PriceQuote,
    at: string,
  ): D1PreparedStatement[] {
    const insert = (
      suffix: string,
      type: string,
      from: string,
      to: string,
      relatedSuffix: string | null,
      withVersion: boolean,
    ) =>
      this.db
        .prepare(
          `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
             from_bucket, to_bucket, amount_minor, currency, related_entry_id, purchase_ref,
             contribution_id, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?), ?, ?, ?, ?)`,
        )
        .bind(
          `${ref}:${suffix}`,
          request.agentId,
          request.operatorId,
          type,
          from,
          to,
          price.amountMinor,
          price.currency,
          relatedSuffix === null ? null : `${ref}:${relatedSuffix}`,
          ref,
          withVersion ? request.contributionId : null,
          withVersion ? request.version : null,
          at,
        );
    return [
      ...(request.method === "provider"
        ? [insert("fund", "operator_funding", "external", "available", null, false)]
        : []),
      insert("hold", "reservation", "available", "reserved", null, true),
      insert("buy", "purchase", "reserved", "spent", "hold", true),
      this.db
        .prepare(
          `INSERT INTO purchase_entitlements (operator_id, contribution_id, version,
             purchase_entry_id, licence, granted_at)
           VALUES (?, ?, ?, (SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?), ?, ?)`,
        )
        .bind(
          request.operatorId,
          request.contributionId,
          request.version,
          `${ref}:buy`,
          LICENCE_OPERATOR_VERSION_PERPETUAL,
          at,
        ),
      // The contributor's share, when the success test is already met (verified Knowledge).
      issueEarningsStatement(this.db, request.contributionId, request.version, at),
    ];
  }
}
