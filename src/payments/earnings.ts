/**
 * Contribution revenue share (Phase 6). An independent purchase (by an operator other than the
 * contributor's) earns the contributor agent {@link CONTRIBUTOR_SHARE_PERCENT}% of the price,
 * rounded down, as a `pending` ledger entry; the platform keeps the rest. Self-purchases never earn.
 *
 * The earning is issued only once the family success test is met:
 *   - Knowledge: the version is verified by the platform (its sources match their recorded hashes,
 *     or independent operators agree it is accurate);
 *   - Execution: the purchasing operator reported a successful outcome, with every step passed.
 * Earnings are tried right after a purchase and again after each feedback report, so an earning
 * whose test is met later is still issued. One earning per purchase at most: the statement skips a
 * purchase that already has one, and D1 triggers (migrations 0014 and 0016) re-check the amount,
 * the beneficiary and the success test.
 */
import { CONTRIBUTOR_SHARE_PERCENT } from "./pricing";

/** Contributor share of `p.amount_minor`, rounded down, in SQL. */
const SHARE = `(p.amount_minor * ${CONTRIBUTOR_SHARE_PERCENT}) / 100`;

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
    JOIN contribution_versions v ON v.contribution_id = p.contribution_id AND v.version = p.version
   WHERE e.contribution_id = ?1 AND e.version = ?2
     AND p.purchase_ref IS NOT NULL
     AND p.operator_id <> c.contributor_operator_id
     AND ${SHARE} > 0
     AND NOT EXISTS (SELECT 1 FROM ledger_entries s
                     WHERE s.related_entry_id = p.entry_id
                       AND s.entry_type = 'contribution_revenue_share')
     AND ((v.family = 'knowledge'
           AND EXISTS (SELECT 1 FROM version_trust t
                       WHERE t.contribution_id = v.contribution_id AND t.version = v.version
                         AND t.verified = 1))
       OR (v.family = 'execution'
           AND EXISTS (SELECT 1 FROM feedback_reports f
                       WHERE f.consumer_operator_id = p.operator_id
                         AND f.contribution_id = v.contribution_id AND f.version = v.version
                         AND f.dimension = 'outcome'
                         AND json_extract(f.assessment_json, '$.finding') = 'success')))`;

export function issueEarningsStatement(
  db: D1Database,
  contributionId: string,
  version: number,
  at: string,
): D1PreparedStatement {
  return db.prepare(ISSUE_EARNINGS_SQL).bind(contributionId, version, at);
}

/**
 * Issues any earnings now due for one version. Best effort: earnings can always be issued on a
 * later attempt, so a failure here never fails the caller's request.
 */
export async function issueEarnings(
  db: D1Database,
  contributionId: string,
  version: number,
  now: () => Date,
): Promise<void> {
  try {
    await issueEarningsStatement(db, contributionId, version, now().toISOString()).run();
  } catch {
    // Best effort only.
  }
}
