/**
 * Contribution revenue share and Execution verification rewards (Phase 6).
 *
 * Revenue share: an independent purchase (by an operator other than the contributor's) earns the
 * contributor agent {@link CONTRIBUTOR_SHARE_PERCENT}% of the price, rounded down, as a `pending`
 * ledger entry; the platform keeps the rest. Self-purchases never earn. The earning is issued
 * only while the version is verified by the platform (both families). An unverified Execution
 * version is free, so it is never bought and its contributor earns nothing until it is verified.
 *
 * Verification reward: an Execution version is verified by Agent Commons' own validation plus one
 * independent operator's successful outcome report. That operator (the earliest such report)
 * earns a one-time, platform-paid {@link VERIFICATION_REWARD} of 0.025 USDC as a `pending`
 * `task_earning` entry naming the version. Rewards are issued only while payments are on.
 *
 * Both are tried right after a purchase and after each feedback report, so anything due later is
 * still issued. The statements skip what already exists, and D1 triggers (migrations 0014, 0016
 * and 0018) re-check amounts, beneficiaries, verification and limits.
 */
import { CONTRIBUTOR_SHARE_PERCENT, VERIFICATION_REWARD } from "./pricing";

/** Contributor share of `p.amount_minor`, rounded down, in SQL. */
const SHARE = `(p.amount_minor * ${CONTRIBUTOR_SHARE_PERCENT}) / 100`;

const VERIFIED = (v: string) => `EXISTS (SELECT 1 FROM version_trust t
                     WHERE t.contribution_id = ${v}.contribution_id AND t.version = ${v}.version
                       AND t.verified = 1)`;

/**
 * Inserts the missing earnings for paid purchases of one version. ?1 contribution ID, ?2 version,
 * ?3 timestamp. Every condition mirrors a D1 trigger, so the statement never trips one.
 */
export const ISSUE_EARNINGS_SQL = `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id,
    entry_type, from_bucket, to_bucket, amount_minor, currency, related_entry_id, purchase_ref,
    contribution_id, version, created_at)
  SELECT p.purchase_ref || ':share', c.contributor_agent_id, c.contributor_operator_id,
         'contribution_revenue_share', 'external', 'pending', ${SHARE}, p.currency, p.entry_id,
         p.purchase_ref, p.contribution_id, p.version, ?3
    FROM purchase_entitlements e
    JOIN ledger_entries p ON p.entry_id = e.purchase_entry_id AND p.entry_type = 'purchase'
    JOIN contributions c ON c.id = p.contribution_id
   WHERE e.contribution_id = ?1 AND e.version = ?2
     AND p.purchase_ref IS NOT NULL
     AND p.operator_id <> c.contributor_operator_id
     AND ${SHARE} > 0
     AND NOT EXISTS (SELECT 1 FROM ledger_entries s
                     WHERE s.related_entry_id = p.entry_id
                       AND s.entry_type = 'contribution_revenue_share')
     AND ${VERIFIED("p")}`;

const REWARDS_SO_FAR = `(SELECT COUNT(*) FROM ledger_entries r
     WHERE r.entry_type = 'task_earning' AND r.contribution_id = ?1 AND r.version = ?2)`;

/**
 * Inserts the missing verification rewards for one Execution version: the earliest successful
 * outcome reports of independent operators, up to two rewards in total. ?1 contribution ID,
 * ?2 version, ?3 timestamp. Mirrors the migration 0018 triggers.
 */
export const ISSUE_REWARDS_SQL = `INSERT INTO ledger_entries (idempotency_key, agent_id, operator_id,
    entry_type, from_bucket, to_bucket, amount_minor, currency, contribution_id, version,
    created_at)
  SELECT 'reward:' || f.contribution_id || ':' || f.version || ':' || f.consumer_operator_id,
         f.agent_id, f.consumer_operator_id, 'task_earning', 'external', 'pending',
         ${VERIFICATION_REWARD.perVerifierMinor}, '${VERIFICATION_REWARD.currency}',
         f.contribution_id, f.version, ?3
    FROM feedback_reports f
    JOIN contribution_versions v ON v.contribution_id = f.contribution_id AND v.version = f.version
    JOIN contributions c ON c.id = f.contribution_id
   WHERE f.contribution_id = ?1 AND f.version = ?2
     AND v.family = 'execution'
     AND ${VERIFIED("v")}
     AND f.dimension = 'outcome'
     AND json_extract(f.assessment_json, '$.finding') = 'success'
     AND f.consumer_operator_id <> c.contributor_operator_id
     AND NOT EXISTS (SELECT 1 FROM ledger_entries r
                     WHERE r.entry_type = 'task_earning' AND r.contribution_id = f.contribution_id
                       AND r.version = f.version AND r.operator_id = f.consumer_operator_id)
     AND (SELECT COUNT(*) FROM ledger_entries d
          WHERE d.entry_type = 'task_earning' AND d.contribution_id IS NOT NULL
            AND d.operator_id = f.consumer_operator_id
            AND substr(d.created_at, 1, 10) = substr(?3, 1, 10))
         < ${VERIFICATION_REWARD.perOperatorDailyLimit}
   ORDER BY f.rowid
   LIMIT MAX(0, ${VERIFICATION_REWARD.verifiers} - ${REWARDS_SO_FAR})`;

export function issueEarningsStatement(
  db: D1Database,
  contributionId: string,
  version: number,
  at: string,
): D1PreparedStatement {
  return db.prepare(ISSUE_EARNINGS_SQL).bind(contributionId, version, at);
}

/**
 * Issues any earnings, and (when `rewards` is true, i.e. payments are on) any verification
 * rewards, now due for one version. Best effort: both can be issued on a later attempt, so a
 * failure here never fails the caller's request.
 */
export async function issueEarnings(
  db: D1Database,
  contributionId: string,
  version: number,
  now: () => Date,
  options: { readonly rewards: boolean } = { rewards: false },
): Promise<void> {
  const at = now().toISOString();
  try {
    await issueEarningsStatement(db, contributionId, version, at).run();
  } catch {
    // Best effort only.
  }
  if (!options.rewards) return;
  try {
    await db.prepare(ISSUE_REWARDS_SQL).bind(contributionId, version, at).run();
  } catch {
    // Best effort only.
  }
}
