/**
 * Settlement, refunds and reversals (Phase 6).
 *
 * - {@link settleDue}: moves earnings and rewards from `pending` to `available`. There is no
 *   hold (owner decision 2026-11-25, migration 0026); ones that name a contribution version settle
 *   only while that version is still verified. Runs on every scheduled trigger and on demand from
 *   the review interface. D1 enforces the verification rule (migration 0021).
 * - {@link refundPurchase}: returns a purchase to the buyer's available balance, claws back the
 *   contributor's share (from pending, and from available for any part already settled) and
 *   withdraws the licence. All in one D1 batch, so it happens completely or not at all.
 * - {@link reverseEarning}: reverses what is left of one earning or reward, for example after a
 *   fake report is found.
 *
 * Every refund and reversal is recorded in `ledger_adjustments` with its reason and who made it.
 */
/** Days an earning waits before settling. 0: it settles on the next run once verified. */
export const SETTLEMENT_HOLD_DAYS = 0;
const EARNINGS = "('task_earning','tip','contribution_revenue_share')";

/** Amounts already drawn from an earning `e`. */
const DRAWN = `
  COALESCE((SELECT SUM(s.amount_minor) FROM ledger_entries s
            WHERE s.related_entry_id = e.entry_id AND s.entry_type = 'settlement'), 0) AS settled,
  COALESCE((SELECT SUM(s.amount_minor) FROM ledger_entries s
            WHERE s.related_entry_id = e.entry_id AND s.entry_type = 'reversal'
              AND s.from_bucket = 'pending'), 0) AS reversed_pending,
  COALESCE((SELECT SUM(s.amount_minor) FROM ledger_entries s
            WHERE s.related_entry_id = e.entry_id AND s.entry_type = 'reversal'
              AND s.from_bucket = 'available'), 0) AS reversed_available`;

/** ?1 now, ?2 limit. One settlement per earning, for whatever is still pending. */
const SETTLE_SQL = `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
    from_bucket, to_bucket, amount_minor, currency, related_entry_id, created_at)
  SELECT 'settle:' || d.entry_id, d.agent_id, d.operator_id, 'settlement', 'pending', 'available',
         d.amount_minor - d.settled - d.reversed_pending, d.currency, d.entry_id, ?1
  FROM (SELECT e.*, ${DRAWN} FROM ledger_entries e
        WHERE e.entry_type IN ${EARNINGS}
          AND julianday(?1) - julianday(e.created_at) >= ${SETTLEMENT_HOLD_DAYS}
          AND NOT EXISTS (SELECT 1 FROM ledger_entries x
                          WHERE x.related_entry_id = e.entry_id AND x.entry_type = 'settlement')
          AND (e.contribution_id IS NULL
               OR EXISTS (SELECT 1 FROM version_trust t
                          WHERE t.contribution_id = e.contribution_id AND t.version = e.version
                            AND t.verified = 1))
        ORDER BY e.entry_id
        LIMIT ?2) d
  WHERE d.amount_minor - d.settled - d.reversed_pending > 0`;

export interface SettleResult {
  readonly settled: number;
}

/** Settles due earnings, at most `limit` per run. Throws when D1 refuses (e.g. stopped). */
export async function settleDue(
  db: D1Database,
  now: () => Date = () => new Date(),
  limit = 200,
): Promise<SettleResult> {
  const result = await db.prepare(SETTLE_SQL).bind(now().toISOString(), limit).run();
  return { settled: result.meta.changes ?? 0 };
}

interface EarningRow {
  entry_id: number;
  agent_id: string;
  operator_id: string;
  amount_minor: number;
  currency: string;
  settled: number;
  reversed_pending: number;
  reversed_available: number;
}

const earningRow = (db: D1Database, where: string, value: string | number) =>
  db
    .prepare(
      `SELECT e.entry_id, e.agent_id, e.operator_id, e.amount_minor, e.currency, ${DRAWN}
       FROM ledger_entries e WHERE ${where}`,
    )
    .bind(value)
    .first<EarningRow>();

/** Statements reversing what remains of one earning, each with its adjustment record. */
function reversalStatements(
  db: D1Database,
  e: EarningRow,
  keyPrefix: string,
  reason: string,
  setBy: string,
  at: string,
): D1PreparedStatement[] {
  const pending = e.amount_minor - e.settled - e.reversed_pending;
  const available = e.settled - e.reversed_available;
  const out: D1PreparedStatement[] = [];
  const add = (suffix: string, from: "pending" | "available", amount: number) => {
    if (amount <= 0) return;
    const key = `${keyPrefix}:${suffix}`;
    out.push(
      db
        .prepare(
          `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
             from_bucket, to_bucket, amount_minor, currency, related_entry_id, created_at)
           VALUES (?, ?, ?, 'reversal', ?, 'reversed', ?, ?, ?, ?)`,
        )
        .bind(key, e.agent_id, e.operator_id, from, amount, e.currency, e.entry_id, at),
      adjustment(db, key, "reversal", reason, setBy, at),
    );
  };
  add("pending", "pending", pending);
  add("available", "available", available);
  return out;
}

function adjustment(
  db: D1Database,
  key: string,
  kind: "refund" | "reversal",
  reason: string,
  setBy: string,
  at: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ledger_adjustments (ledger_entry_id, kind, reason, set_by, created_at)
       VALUES ((SELECT entry_id FROM ledger_entries WHERE idempotency_key = ?), ?, ?, ?, ?)`,
    )
    .bind(key, kind, reason, setBy, at);
}

const textOk = (s: unknown, max: number) =>
  typeof s === "string" && s.trim().length > 0 && s.length <= max;

export type AdjustmentOutcome =
  | { readonly ok: true; readonly entries: number }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_request"
        | "not_found"
        | "already_done"
        | "insufficient_balance"
        | "payments_stopped";
    };

function refusalOf(error: unknown): AdjustmentOutcome {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  if (/insufficient_balance/.test(message)) return { ok: false, code: "insufficient_balance" };
  if (/payments_stopped/.test(message)) return { ok: false, code: "payments_stopped" };
  if (/UNIQUE constraint failed/.test(message)) return { ok: false, code: "already_done" };
  throw error;
}

/**
 * Refunds one purchase in full, by its purchase reference: the buyer's agent gets the amount back
 * as available balance, the contributor's share is reversed, and the licence is withdrawn.
 */
export async function refundPurchase(
  db: D1Database,
  purchaseRef: string,
  reason: string,
  setBy: string,
  now: () => Date = () => new Date(),
): Promise<AdjustmentOutcome> {
  if (!textOk(purchaseRef, 128) || !textOk(reason, 500) || !textOk(setBy, 200)) {
    return { ok: false, code: "invalid_request" };
  }
  const purchase = await db
    .prepare(
      `SELECT entry_id, agent_id, operator_id, amount_minor, currency FROM ledger_entries
       WHERE purchase_ref = ? AND entry_type = 'purchase'`,
    )
    .bind(purchaseRef)
    .first<{
      entry_id: number;
      agent_id: string;
      operator_id: string;
      amount_minor: number;
      currency: string;
    }>();
  if (!purchase) return { ok: false, code: "not_found" };
  const refunded = await db
    .prepare("SELECT 1 FROM ledger_entries WHERE related_entry_id = ? AND entry_type = 'refund'")
    .bind(purchase.entry_id)
    .first();
  if (refunded) return { ok: false, code: "already_done" };

  const at = now().toISOString();
  const key = `${purchaseRef}:refund`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
           from_bucket, to_bucket, amount_minor, currency, related_entry_id, created_at)
         VALUES (?, ?, ?, 'refund', 'spent', 'available', ?, ?, ?, ?)`,
      )
      .bind(
        key,
        purchase.agent_id,
        purchase.operator_id,
        purchase.amount_minor,
        purchase.currency,
        purchase.entry_id,
        at,
      ),
    adjustment(db, key, "refund", reason, setBy, at),
  ];
  const share = await earningRow(
    db,
    "e.related_entry_id = ? AND e.entry_type = 'contribution_revenue_share'",
    purchase.entry_id,
  );
  if (share) {
    statements.push(...reversalStatements(db, share, `${purchaseRef}:share`, reason, setBy, at));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO entitlement_revocations (purchase_entry_id, reason, revoked_at)
         SELECT purchase_entry_id, ?, ? FROM purchase_entitlements WHERE purchase_entry_id = ?`,
      )
      .bind(reason, at, purchase.entry_id),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    return refusalOf(error);
  }
  // The refund plus each share reversal; adjustment and revocation rows are not ledger entries.
  return { ok: true, entries: (statements.length - 1) / 2 };
}

/** Reverses whatever remains of one earning or reward (pending, then any settled part). */
export async function reverseEarning(
  db: D1Database,
  entryId: number,
  reason: string,
  setBy: string,
  now: () => Date = () => new Date(),
): Promise<AdjustmentOutcome> {
  if (
    !Number.isSafeInteger(entryId) ||
    entryId < 1 ||
    !textOk(reason, 500) ||
    !textOk(setBy, 200)
  ) {
    return { ok: false, code: "invalid_request" };
  }
  const earning = await earningRow(db, `e.entry_id = ? AND e.entry_type IN ${EARNINGS}`, entryId);
  if (!earning) return { ok: false, code: "not_found" };
  const statements = reversalStatements(
    db,
    earning,
    `reverse:${entryId}:${Date.parse(now().toISOString())}`,
    reason,
    setBy,
    now().toISOString(),
  );
  if (statements.length === 0) return { ok: false, code: "already_done" };
  try {
    await db.batch(statements);
  } catch (error) {
    return refusalOf(error);
  }
  return { ok: true, entries: statements.length / 2 };
}
