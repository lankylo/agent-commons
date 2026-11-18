/**
 * Reconciliation report and monitoring (Phase 6).
 *
 * Checks that the ledger agrees with itself and with the chain, and lists anything needing the
 * owner's attention as alerts:
 *
 * - critical: a negative balance bucket; credited deposits that differ from deposit ledger entries;
 *   sent payouts that differ from withdrawals; the platform wallet holding less USDC than the
 *   platform owes agents (`underfunded`);
 * - warning: approved payouts waiting to be sent for more than 2 days; earnings past the 7-day
 *   hold that have not settled for 2 more days; verification rewards at 80% of the cap or more;
 *   the chain could not be read;
 * - info: payments are stopped.
 *
 * Runs daily from the scheduled trigger and on demand from the review interface. Each run is
 * recorded (migration 0023) with only aggregate figures and alert codes.
 */
import type { ChainReader, NetworkConfig } from "./chain";
import { platformSummary } from "./platform";
import { PAYMENT_CURRENCY } from "./pricing";
import { SETTLEMENT_HOLD_DAYS } from "./settlement";

export const MONITORING_THRESHOLDS = Object.freeze({
  payoutWaitDays: 2,
  settlementGraceDays: 2,
  rewardCapWarnRatio: 0.8,
});

export type AlertSeverity = "critical" | "warning" | "info";

export interface ReconciliationAlert {
  readonly code: string;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly value?: number;
}

export interface ReconciliationReport {
  readonly schemaVersion: "reconciliation/v1";
  readonly generatedAt: string;
  readonly currency: string;
  readonly ok: boolean;
  readonly alerts: readonly ReconciliationAlert[];
  readonly ledger: { readonly negativeBuckets: number };
  readonly owedToAgentsMinor: number;
  readonly deposits: { readonly chainCreditedMinor: number; readonly ledgerEntriesMinor: number };
  readonly payouts: {
    readonly sentMinor: number;
    readonly withdrawnMinor: number;
    readonly awaitingApproval: number;
    readonly approvedUnsent: number;
    readonly oldestApprovedAt: string | null;
  };
  readonly settlement: { readonly overdue: number };
  readonly rewards: { readonly issuedNetMinor: number; readonly capMinor: number };
  readonly chain: {
    readonly checked: boolean;
    readonly network: string | null;
    readonly platformBalanceMinor: number | null;
    readonly coverageMinor: number | null;
  };
}

export interface ChainCheck {
  readonly network: NetworkConfig;
  readonly platformAddress: string;
  readonly reader: ChainReader;
}

const NEGATIVE_SQL = `SELECT COUNT(*) AS n FROM (
    SELECT agent_id, bucket, SUM(delta) AS total FROM (
      SELECT agent_id, to_bucket AS bucket, amount_minor AS delta
        FROM ledger_entries WHERE currency = ?1
      UNION ALL
      SELECT agent_id, from_bucket AS bucket, -amount_minor AS delta
        FROM ledger_entries WHERE currency = ?1
    ) WHERE bucket <> 'external' GROUP BY agent_id, bucket HAVING total < 0)`;

const FIGURES_SQL = `SELECT
    (SELECT COALESCE(SUM(amount_minor), 0) FROM chain_deposits) AS chain_credited,
    (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
     WHERE entry_type = 'operator_funding' AND idempotency_key LIKE 'deposit:%') AS deposit_entries,
    (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payout_requests p
     WHERE EXISTS (SELECT 1 FROM payout_events e
                   WHERE e.request_id = p.request_id AND e.event = 'sent')) AS payouts_sent,
    (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries
     WHERE entry_type = 'withdrawal' AND currency = ?1) AS withdrawn,
    (SELECT COUNT(*) FROM payout_requests p
     WHERE NOT EXISTS (SELECT 1 FROM payout_events e WHERE e.request_id = p.request_id))
      AS awaiting,
    (SELECT COUNT(*) FROM payout_requests p
     WHERE (SELECT e.event FROM payout_events e WHERE e.request_id = p.request_id
            ORDER BY e.event_id DESC LIMIT 1) = 'approved') AS approved_unsent,
    (SELECT MIN(e.created_at) FROM payout_events e
     WHERE e.event = 'approved'
       AND NOT EXISTS (SELECT 1 FROM payout_events x
                       WHERE x.request_id = e.request_id AND x.event_id > e.event_id))
      AS oldest_approved,
    (SELECT COUNT(*) FROM ledger_entries r
     WHERE r.entry_type IN ('task_earning','tip','contribution_revenue_share')
       AND julianday(?2) - julianday(r.created_at) >= ?3
       AND NOT EXISTS (SELECT 1 FROM ledger_entries x
                       WHERE x.related_entry_id = r.entry_id
                         AND x.entry_type IN ('settlement','reversal'))
       AND (r.contribution_id IS NULL
            OR EXISTS (SELECT 1 FROM version_trust t
                       WHERE t.contribution_id = r.contribution_id AND t.version = r.version
                         AND t.verified = 1))) AS overdue`;

interface FiguresRow {
  chain_credited: number;
  deposit_entries: number;
  payouts_sent: number;
  withdrawn: number;
  awaiting: number;
  approved_unsent: number;
  oldest_approved: string | null;
  overdue: number;
}

const DAY_MS = 86_400_000;

export async function reconcile(
  db: D1Database,
  now: () => Date = () => new Date(),
  chain?: ChainCheck,
): Promise<ReconciliationReport> {
  const at = now();
  const iso = at.toISOString();
  const [negative, figures, summary] = await Promise.all([
    db.prepare(NEGATIVE_SQL).bind(PAYMENT_CURRENCY).first<{ n: number }>(),
    db
      .prepare(FIGURES_SQL)
      .bind(PAYMENT_CURRENCY, iso, SETTLEMENT_HOLD_DAYS + MONITORING_THRESHOLDS.settlementGraceDays)
      .first<FiguresRow>(),
    platformSummary(db, now),
  ]);
  const f = figures!;
  const usdc = summary.currencies.find((c) => c.currency === PAYMENT_CURRENCY);
  const owed = usdc?.owedToAgents.totalMinor ?? 0;
  const alerts: ReconciliationAlert[] = [];
  const alert = (code: string, severity: AlertSeverity, message: string, value?: number) =>
    alerts.push(
      value === undefined ? { code, severity, message } : { code, severity, message, value },
    );

  const negativeBuckets = negative?.n ?? 0;
  if (negativeBuckets > 0) {
    alert(
      "negative_balance",
      "critical",
      "Some agent balance buckets are negative.",
      negativeBuckets,
    );
  }
  if (f.chain_credited !== f.deposit_entries) {
    alert(
      "deposit_mismatch",
      "critical",
      "Credited on-chain deposits differ from deposit ledger entries.",
      f.deposit_entries - f.chain_credited,
    );
  }
  if (f.payouts_sent !== f.withdrawn) {
    alert(
      "payout_mismatch",
      "critical",
      "Sent payouts differ from recorded withdrawals.",
      f.withdrawn - f.payouts_sent,
    );
  }
  if (
    f.oldest_approved !== null &&
    at.getTime() - Date.parse(f.oldest_approved) > MONITORING_THRESHOLDS.payoutWaitDays * DAY_MS
  ) {
    alert(
      "payouts_waiting",
      "warning",
      `Approved payouts have waited more than ${MONITORING_THRESHOLDS.payoutWaitDays} days to be sent.`,
      f.approved_unsent,
    );
  }
  if (f.overdue > 0) {
    alert(
      "settlement_backlog",
      "warning",
      "Earnings past the hold have not settled; check the scheduled trigger.",
      f.overdue,
    );
  }
  const rewards = summary.controls.rewardsIssuedNetMinor;
  const cap = summary.controls.rewardCapMinor;
  if (cap > 0 && rewards >= cap * MONITORING_THRESHOLDS.rewardCapWarnRatio) {
    alert("reward_cap_near", "warning", "Verification rewards are near or at the cap.", rewards);
  }
  if (summary.controls.stopped) {
    alert("payments_stopped", "info", "Payments are stopped.");
  }

  let platformBalance: number | null = null;
  if (chain) {
    try {
      const balance = await chain.reader.tokenBalance(chain.network.usdc, chain.platformAddress);
      platformBalance = balance === null ? null : Number(balance);
    } catch {
      platformBalance = null;
    }
    if (platformBalance === null) {
      alert("chain_unavailable", "warning", "The platform wallet balance could not be read.");
    } else if (platformBalance < owed) {
      alert(
        "underfunded",
        "critical",
        "The platform wallet holds less USDC than the platform owes agents.",
        owed - platformBalance,
      );
    }
  }

  return {
    schemaVersion: "reconciliation/v1",
    generatedAt: iso,
    currency: PAYMENT_CURRENCY,
    ok: !alerts.some((a) => a.severity !== "info"),
    alerts,
    ledger: { negativeBuckets },
    owedToAgentsMinor: owed,
    deposits: { chainCreditedMinor: f.chain_credited, ledgerEntriesMinor: f.deposit_entries },
    payouts: {
      sentMinor: f.payouts_sent,
      withdrawnMinor: f.withdrawn,
      awaitingApproval: f.awaiting,
      approvedUnsent: f.approved_unsent,
      oldestApprovedAt: f.oldest_approved,
    },
    settlement: { overdue: f.overdue },
    rewards: { issuedNetMinor: rewards, capMinor: cap },
    chain: {
      checked: chain !== undefined,
      network: chain?.network.network ?? null,
      platformBalanceMinor: platformBalance,
      coverageMinor: platformBalance === null ? null : platformBalance - owed,
    },
  };
}

/** Records a run, append-only, and returns its ID. */
export async function recordRun(
  db: D1Database,
  report: ReconciliationReport,
  trigger: "scheduled" | "reviewer",
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO reconciliation_runs (ran_at, trigger_kind, ok, alerts_json, report_json)
       VALUES (?, ?, ?, ?, ?) RETURNING run_id`,
    )
    .bind(
      report.generatedAt,
      trigger,
      report.ok ? 1 : 0,
      JSON.stringify(report.alerts),
      JSON.stringify(report),
    )
    .first<{ run_id: number }>();
  return row?.run_id ?? 0;
}
