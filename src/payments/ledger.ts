/**
 * Append-only agent ledger (Phase 6, no live money). Every entry records the agent and its
 * operator and moves a positive amount of one currency between balance buckets. Balances are
 * derived from the entries and never stored. The rules that keep money consistent (no overdraw,
 * no double use of a reservation or earning, one earning per purchase, no self-purchase earning,
 * operator spending controls) are enforced in D1 by migration 0014, so they hold for every caller.
 * This module validates input, maps D1 refusals to stable codes and makes retries idempotent.
 */
export const LEDGER_ENTRY_TYPES = [
  "operator_funding",
  "task_earning",
  "tip",
  "contribution_revenue_share",
  "settlement",
  "reservation",
  "reservation_release",
  "purchase",
  "fee",
  "refund",
  "reversal",
  "withdrawal",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const LEDGER_BUCKETS = [
  "pending",
  "available",
  "reserved",
  "spent",
  "withdrawn",
  "reversed",
] as const;
export type LedgerBucket = (typeof LEDGER_BUCKETS)[number];
type Bucket = LedgerBucket | "external";

/** The fixed move of each entry type. A reversal draws from `pending` unless told otherwise. */
const MOVES: Readonly<Record<LedgerEntryType, readonly [Bucket, Bucket]>> = {
  operator_funding: ["external", "available"],
  task_earning: ["external", "pending"],
  tip: ["external", "pending"],
  contribution_revenue_share: ["external", "pending"],
  settlement: ["pending", "available"],
  reservation: ["available", "reserved"],
  reservation_release: ["reserved", "available"],
  purchase: ["reserved", "spent"],
  fee: ["available", "spent"],
  refund: ["spent", "available"],
  reversal: ["pending", "reversed"],
  withdrawal: ["reserved", "withdrawn"],
};

export const LEDGER_REFUSALS = [
  "insufficient_balance",
  "related_entry_invalid",
  "related_entry_exhausted",
  "earning_not_eligible",
  "earning_amount_invalid",
  "earning_test_not_met",
  "reward_not_eligible",
  "reward_limit",
  "reward_cap_reached",
  "payments_stopped",
  "spending_suspended",
  "spending_policy_missing",
  "category_not_permitted",
  "per_transaction_limit",
  "daily_limit",
  "monthly_limit",
  "minimum_reserve",
  "duplicate_entry",
  "idempotency_conflict",
] as const;
export type LedgerRefusal = (typeof LEDGER_REFUSALS)[number];

export interface LedgerEntryInput {
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly operatorId: string;
  readonly entryType: LedgerEntryType;
  readonly amountMinor: number;
  readonly currency: string;
  /** Only for `reversal`: reverse an amount that was already settled. */
  readonly fromAvailable?: boolean;
  readonly relatedEntryId?: number;
  readonly purchaseRef?: string;
  readonly contribution?: { readonly id: string; readonly version: number };
}

export interface LedgerEntry {
  readonly entryId: number;
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly operatorId: string;
  readonly entryType: LedgerEntryType;
  readonly fromBucket: Bucket;
  readonly toBucket: Bucket;
  readonly amountMinor: number;
  readonly currency: string;
  readonly relatedEntryId: number | null;
  readonly purchaseRef: string | null;
  readonly contributionId: string | null;
  readonly version: number | null;
  readonly createdAt: string;
}

export type AppendResult =
  | { readonly ok: true; readonly entries: readonly LedgerEntry[]; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly error: { readonly code: "invalid_entry"; readonly field: string };
    }
  | { readonly ok: false; readonly error: { readonly code: LedgerRefusal } };

export type AgentBalances = Readonly<Record<string, Readonly<Record<LedgerBucket, number>>>>;

const MAX_AMOUNT = 1_000_000_000_000;
/** Idempotency keys and purchase references: letters, digits, `_`, `:`, `.` and `-`. */
const KEY = /^[\w:.-]{8,128}$/;
const CURRENCY = /^[A-Z]{3,8}$/;

interface EntryRow {
  entry_id: number;
  idempotency_key: string;
  agent_id: string;
  operator_id: string;
  entry_type: LedgerEntryType;
  from_bucket: Bucket;
  to_bucket: Bucket;
  amount_minor: number;
  currency: string;
  related_entry_id: number | null;
  purchase_ref: string | null;
  contribution_id: string | null;
  version: number | null;
  created_at: string;
}

const ENTRY_COLUMNS = `entry_id, idempotency_key, agent_id, operator_id, entry_type, from_bucket,
  to_bucket, amount_minor, currency, related_entry_id, purchase_ref, contribution_id, version,
  created_at`;

function toEntry(row: EntryRow): LedgerEntry {
  return {
    entryId: row.entry_id,
    idempotencyKey: row.idempotency_key,
    agentId: row.agent_id,
    operatorId: row.operator_id,
    entryType: row.entry_type,
    fromBucket: row.from_bucket,
    toBucket: row.to_bucket,
    amountMinor: row.amount_minor,
    currency: row.currency,
    relatedEntryId: row.related_entry_id,
    purchaseRef: row.purchase_ref,
    contributionId: row.contribution_id,
    version: row.version,
    createdAt: row.created_at,
  };
}

function invalidField(input: LedgerEntryInput): string | null {
  if (typeof input.idempotencyKey !== "string" || !KEY.test(input.idempotencyKey)) {
    return "idempotencyKey";
  }
  if (typeof input.agentId !== "string" || input.agentId.length === 0) return "agentId";
  if (typeof input.operatorId !== "string" || input.operatorId.length === 0) return "operatorId";
  if (!(LEDGER_ENTRY_TYPES as readonly string[]).includes(input.entryType)) return "entryType";
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    input.amountMinor > MAX_AMOUNT
  ) {
    return "amountMinor";
  }
  if (typeof input.currency !== "string" || !CURRENCY.test(input.currency)) return "currency";
  if (input.fromAvailable !== undefined && input.entryType !== "reversal") return "fromAvailable";
  if (
    input.relatedEntryId !== undefined &&
    (!Number.isSafeInteger(input.relatedEntryId) || input.relatedEntryId <= 0)
  ) {
    return "relatedEntryId";
  }
  if (input.purchaseRef !== undefined && !KEY.test(input.purchaseRef)) return "purchaseRef";
  if (
    input.contribution !== undefined &&
    (typeof input.contribution.id !== "string" ||
      input.contribution.id.length === 0 ||
      !Number.isSafeInteger(input.contribution.version) ||
      input.contribution.version <= 0)
  ) {
    return "contribution";
  }
  return null;
}

function moveOf(input: LedgerEntryInput): readonly [Bucket, Bucket] {
  if (input.entryType === "reversal" && input.fromAvailable) return ["available", "reversed"];
  return MOVES[input.entryType];
}

/** Same request as a stored entry: a retry with the same key replays instead of failing. */
function sameAs(input: LedgerEntryInput, entry: LedgerEntry): boolean {
  const [from, to] = moveOf(input);
  return (
    entry.agentId === input.agentId &&
    entry.operatorId === input.operatorId &&
    entry.entryType === input.entryType &&
    entry.fromBucket === from &&
    entry.toBucket === to &&
    entry.amountMinor === input.amountMinor &&
    entry.currency === input.currency &&
    entry.relatedEntryId === (input.relatedEntryId ?? null) &&
    entry.purchaseRef === (input.purchaseRef ?? null) &&
    entry.contributionId === (input.contribution?.id ?? null) &&
    entry.version === (input.contribution?.version ?? null)
  );
}

/** Maps a D1 constraint or trigger failure to a stable refusal code; null when unrecognized. */
export function ledgerRefusalOf(error: unknown): LedgerRefusal | null {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  for (const code of LEDGER_REFUSALS) {
    if (message.includes(code)) return code;
  }
  if (/ledger_entries\.idempotency_key/.test(message)) return "idempotency_conflict";
  if (/UNIQUE constraint failed: ledger_entries/.test(message)) return "duplicate_entry";
  return null;
}

export class Ledger {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Appends the entries atomically, in order: all are recorded or none. Retrying with the same
   * idempotency keys and the same content returns the stored entries with `replayed: true`.
   */
  async append(inputs: readonly LedgerEntryInput[]): Promise<AppendResult> {
    if (inputs.length === 0 || inputs.length > 20) {
      return { ok: false, error: { code: "invalid_entry", field: "entries" } };
    }
    for (const input of inputs) {
      const field = invalidField(input);
      if (field) return { ok: false, error: { code: "invalid_entry", field } };
    }
    if (new Set(inputs.map((i) => i.idempotencyKey)).size !== inputs.length) {
      return { ok: false, error: { code: "invalid_entry", field: "idempotencyKey" } };
    }

    const existing = await this.byKeys(inputs.map((i) => i.idempotencyKey));
    if (existing.length > 0) {
      const byKey = new Map(existing.map((e) => [e.idempotencyKey, e]));
      const replay =
        existing.length === inputs.length &&
        inputs.every((i) => {
          const stored = byKey.get(i.idempotencyKey);
          return stored !== undefined && sameAs(i, stored);
        });
      return replay
        ? { ok: true, entries: inputs.map((i) => byKey.get(i.idempotencyKey)!), replayed: true }
        : { ok: false, error: { code: "idempotency_conflict" } };
    }

    const createdAt = this.now().toISOString();
    const statements = inputs.map((input) => {
      const [from, to] = moveOf(input);
      return this.db
        .prepare(
          `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id, entry_type,
             from_bucket, to_bucket, amount_minor, currency, related_entry_id, purchase_ref,
             contribution_id, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.idempotencyKey,
          input.agentId,
          input.operatorId,
          input.entryType,
          from,
          to,
          input.amountMinor,
          input.currency,
          input.relatedEntryId ?? null,
          input.purchaseRef ?? null,
          input.contribution?.id ?? null,
          input.contribution?.version ?? null,
          createdAt,
        );
    });
    try {
      await this.db.batch(statements);
    } catch (error) {
      const code = ledgerRefusalOf(error);
      if (code === "idempotency_conflict") return this.append(inputs);
      if (code) return { ok: false, error: { code } };
      throw error;
    }
    const stored = await this.byKeys(inputs.map((i) => i.idempotencyKey));
    const byKey = new Map(stored.map((e) => [e.idempotencyKey, e]));
    return { ok: true, entries: inputs.map((i) => byKey.get(i.idempotencyKey)!), replayed: false };
  }

  /** Balances per currency and bucket, derived from every entry of the agent. */
  async balances(agentId: string): Promise<AgentBalances> {
    const { results } = await this.db
      .prepare(
        `SELECT currency, bucket, SUM(delta) AS amount FROM (
           SELECT currency, to_bucket AS bucket, amount_minor AS delta
             FROM ledger_entries WHERE agent_id = ?1
           UNION ALL
           SELECT currency, from_bucket AS bucket, -amount_minor AS delta
             FROM ledger_entries WHERE agent_id = ?1
         ) WHERE bucket <> 'external' GROUP BY currency, bucket`,
      )
      .bind(agentId)
      .all<{ currency: string; bucket: LedgerBucket; amount: number }>();
    const out: Record<string, Record<LedgerBucket, number>> = {};
    for (const row of results) {
      out[row.currency] ??= Object.fromEntries(LEDGER_BUCKETS.map((b) => [b, 0])) as Record<
        LedgerBucket,
        number
      >;
      out[row.currency]![row.bucket] = row.amount;
    }
    return out;
  }

  async entries(agentId: string): Promise<readonly LedgerEntry[]> {
    const { results } = await this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM ledger_entries WHERE agent_id = ? ORDER BY entry_id`)
      .bind(agentId)
      .all<EntryRow>();
    return results.map(toEntry);
  }

  private async byKeys(keys: readonly string[]): Promise<LedgerEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM ledger_entries
         WHERE idempotency_key IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(keys))
      .all<EntryRow>();
    return results.map(toEntry);
  }
}
