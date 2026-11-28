/**
 * Platform-wide payment controls and views (Phase 6).
 *
 * - {@link PlatformControls}: the emergency stop and the verification-reward cap (migration
 *   0019). Both are append-only; the latest row applies. Only the operator-only review interface
 *   changes them.
 * - {@link platformSummary}: what the platform owes agents, its fee income and its reward
 *   exposure, per currency, derived from the ledger.
 * - {@link accountView}: one agent's balances and recent entries, and its operator's policy,
 *   suspension state and spending so far this UTC day and month.
 */
import { Ledger, type LedgerEntry } from "./ledger";
import { PAYMENT_CURRENCY } from "./pricing";
import { SpendingControls, type SpendingPolicy } from "./spending-controls";

/** Reward cap that applies while no cap has been set (100 USDC). Mirrors migration 0019. */
export const DEFAULT_REWARD_CAP_MINOR = 100_000_000;

export interface PaymentControlState {
  readonly stopped: boolean;
  readonly since: string | null;
  readonly reason: string | null;
  readonly rewardCapMinor: number;
  readonly rewardCapIsDefault: boolean;
}

const text = (s: unknown, max: number): s is string =>
  typeof s === "string" && s.trim().length > 0 && s.length <= max;

export class PlatformControls {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async state(): Promise<PaymentControlState> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT action FROM platform_payment_controls ORDER BY control_id DESC LIMIT 1) AS action,
           (SELECT created_at FROM platform_payment_controls ORDER BY control_id DESC LIMIT 1) AS since,
           (SELECT reason FROM platform_payment_controls ORDER BY control_id DESC LIMIT 1) AS reason,
           (SELECT cap_minor FROM platform_reward_caps ORDER BY cap_id DESC LIMIT 1) AS cap`,
      )
      .first<{
        action: string | null;
        since: string | null;
        reason: string | null;
        cap: number | null;
      }>();
    return {
      stopped: row?.action === "stop",
      since: row?.since ?? null,
      reason: row?.reason ?? null,
      rewardCapMinor: row?.cap ?? DEFAULT_REWARD_CAP_MINOR,
      rewardCapIsDefault: row?.cap == null,
    };
  }

  /** Records a stop or start. Returns false when the reason or actor is invalid. */
  async set(action: "stop" | "start", reason: string, setBy: string): Promise<boolean> {
    if (!text(reason, 500) || !text(setBy, 200)) return false;
    await this.db
      .prepare(
        `INSERT INTO platform_payment_controls (action, reason, set_by, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(action, reason, setBy, this.now().toISOString())
      .run();
    return true;
  }

  /** Sets the reward cap in base units. Returns false when an input is invalid. */
  async setRewardCap(capMinor: number, reason: string, setBy: string): Promise<boolean> {
    if (
      !Number.isSafeInteger(capMinor) ||
      capMinor < 0 ||
      capMinor > 1_000_000_000_000 ||
      !text(reason, 500) ||
      !text(setBy, 200)
    ) {
      return false;
    }
    await this.db
      .prepare(
        `INSERT INTO platform_reward_caps (cap_minor, reason, set_by, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(capMinor, reason, setBy, this.now().toISOString())
      .run();
    return true;
  }
}

const sumOf = (where: string) =>
  `COALESCE((SELECT SUM(amount_minor) FROM ledger_entries e WHERE e.currency = c.currency AND ${where}), 0)`;
const reversedOf = (relatedType: string, extra = "") =>
  `COALESCE((SELECT SUM(x.amount_minor) FROM ledger_entries x
     JOIN ledger_entries r ON r.entry_id = x.related_entry_id
     WHERE x.currency = c.currency AND x.entry_type = 'reversal'
       AND r.entry_type = '${relatedType}' ${extra}), 0)`;
const bucket = (name: string) =>
  `${sumOf(`e.to_bucket = '${name}'`)} - ${sumOf(`e.from_bucket = '${name}'`)}`;

const SUMMARY_SQL = `SELECT c.currency,
    ${bucket("pending")} AS pending,
    ${bucket("available")} AS available,
    ${bucket("reserved")} AS reserved,
    ${sumOf("e.entry_type = 'operator_funding'")} AS funded,
    ${sumOf("e.entry_type = 'purchase'")} AS purchases,
    ${sumOf("e.entry_type = 'refund'")} AS refunds,
    ${sumOf("e.entry_type = 'contribution_revenue_share'")} AS shares,
    ${reversedOf("contribution_revenue_share")} AS shares_reversed,
    ${sumOf("e.entry_type = 'task_earning' AND e.contribution_id IS NOT NULL")} AS rewards,
    ${reversedOf("task_earning", "AND r.contribution_id IS NOT NULL")} AS rewards_reversed,
    ${sumOf("e.entry_type = 'withdrawal'")} AS withdrawn
  FROM (SELECT DISTINCT currency FROM ledger_entries) c
  ORDER BY c.currency`;

interface SummaryRow {
  currency: string;
  pending: number;
  available: number;
  reserved: number;
  funded: number;
  purchases: number;
  refunds: number;
  shares: number;
  shares_reversed: number;
  rewards: number;
  rewards_reversed: number;
  withdrawn: number;
}

export interface CurrencySummary {
  readonly currency: string;
  /** What the platform owes agents: every agent balance that can still be paid out or spent. */
  readonly owedToAgents: {
    readonly pendingMinor: number;
    readonly availableMinor: number;
    readonly reservedMinor: number;
    readonly totalMinor: number;
  };
  readonly fundedMinor: number;
  readonly purchasesNetMinor: number;
  readonly contributorSharesNetMinor: number;
  /** Purchases net of refunds, minus contributor shares net of reversals. */
  readonly feeIncomeMinor: number;
  readonly rewardsNetMinor: number;
  /** Fee income minus net rewards: positive when fees have paid for the rewards. */
  readonly netPositionMinor: number;
  readonly withdrawnMinor: number;
}

export interface PlatformSummary {
  readonly schemaVersion: "platform-ledger/v1";
  readonly generatedAt: string;
  readonly controls: PaymentControlState & {
    readonly rewardsIssuedNetMinor: number;
    readonly rewardCapRemainingMinor: number;
  };
  readonly currencies: readonly CurrencySummary[];
}

export async function platformSummary(
  db: D1Database,
  now: () => Date = () => new Date(),
): Promise<PlatformSummary> {
  const [controls, { results }] = await Promise.all([
    new PlatformControls(db, now).state(),
    db.prepare(SUMMARY_SQL).all<SummaryRow>(),
  ]);
  const currencies = results.map((r): CurrencySummary => {
    const purchasesNet = r.purchases - r.refunds;
    const sharesNet = r.shares - r.shares_reversed;
    const rewardsNet = r.rewards - r.rewards_reversed;
    return {
      currency: r.currency,
      owedToAgents: {
        pendingMinor: r.pending,
        availableMinor: r.available,
        reservedMinor: r.reserved,
        totalMinor: r.pending + r.available + r.reserved,
      },
      fundedMinor: r.funded,
      purchasesNetMinor: purchasesNet,
      contributorSharesNetMinor: sharesNet,
      feeIncomeMinor: purchasesNet - sharesNet,
      rewardsNetMinor: rewardsNet,
      netPositionMinor: purchasesNet - sharesNet - rewardsNet,
      withdrawnMinor: r.withdrawn,
    };
  });
  const rewardsIssued = currencies.reduce((n, c) => n + c.rewardsNetMinor, 0);
  return {
    schemaVersion: "platform-ledger/v1",
    generatedAt: now().toISOString(),
    controls: {
      ...controls,
      rewardsIssuedNetMinor: rewardsIssued,
      rewardCapRemainingMinor: Math.max(0, controls.rewardCapMinor - rewardsIssued),
    },
    currencies,
  };
}

const PERIOD_SPENT_SQL = `SELECT
    COALESCE(SUM(CASE WHEN substr(r.created_at, 1, 10) = substr(?3, 1, 10) THEN r.net END), 0)
      AS today,
    COALESCE(SUM(CASE WHEN substr(r.created_at, 1, 7) = substr(?3, 1, 7) THEN r.net END), 0)
      AS month
  FROM (SELECT h.created_at, h.amount_minor - COALESCE(
          (SELECT SUM(x.amount_minor) FROM ledger_entries x
           WHERE x.related_entry_id = h.entry_id AND x.entry_type = 'reservation_release'), 0)
          AS net
        FROM ledger_entries h
        WHERE h.operator_id = ?1 AND h.currency = ?2 AND h.entry_type = 'reservation'
          AND h.contribution_id IS NOT NULL) r`;

export interface AccountView {
  readonly schemaVersion: "account/v1";
  readonly agentId: string;
  readonly operatorId: string;
  readonly currency: string;
  readonly balances: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly policy: SpendingPolicy | null;
  readonly suspended: boolean;
  readonly paymentsStopped: boolean;
  readonly operatorSpentMinor: { readonly today: number; readonly month: number };
  /** The agent's latest entries, newest first (at most 20). */
  readonly recentEntries: readonly LedgerEntry[];
}

export async function accountView(
  db: D1Database,
  agentId: string,
  operatorId: string,
  now: () => Date = () => new Date(),
): Promise<AccountView> {
  const ledger = new Ledger(db, now);
  const controls = new SpendingControls(db, now);
  const [balances, entries, policy, suspended, state, spent] = await Promise.all([
    ledger.balances(agentId),
    ledger.entries(agentId),
    controls.currentPolicy(operatorId, PAYMENT_CURRENCY),
    controls.isSuspended(operatorId, agentId),
    new PlatformControls(db, now).state(),
    db
      .prepare(PERIOD_SPENT_SQL)
      .bind(operatorId, PAYMENT_CURRENCY, now().toISOString())
      .first<{ today: number; month: number }>(),
  ]);
  return {
    schemaVersion: "account/v1",
    agentId,
    operatorId,
    currency: PAYMENT_CURRENCY,
    balances,
    policy,
    suspended,
    paymentsStopped: state.stopped,
    operatorSpentMinor: { today: spent?.today ?? 0, month: spent?.month ?? 0 },
    recentEntries: entries.slice(-20).reverse(),
  };
}
