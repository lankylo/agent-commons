/**
 * Operator-only pilot usage snapshot. Aggregate counts over existing tables: no identifiers, no
 * contribution or report text. Counts are operational signals, not proof of
 * demand or value. Successful searches and full retrievals are counted per UTC day in
 * `usage_daily_counts` (migration 0012); activity before that migration is not measured.
 */
export type UsageOperation = "search" | "retrieval";

export const USAGE_RECENT_DAYS = 30;

export interface PilotUsageDay {
  readonly day: string;
  readonly searches: number;
  readonly retrievals: number;
}

export interface PilotUsageSnapshot {
  readonly schemaVersion: "pilot-usage/v1";
  readonly notice: string;
  readonly generatedAt: string;
  readonly enrollment: {
    readonly enrolledWallets: number;
    readonly operators: number;
    readonly agents: number;
  };
  readonly contributions: {
    readonly contributionIds: number;
    readonly contributingOperators: number;
    readonly versionsByState: Readonly<Record<string, number>>;
    readonly listedVersionsByFamily: Readonly<Record<string, number>>;
  };
  readonly retrieval: {
    readonly receipts: number;
    readonly retrievingAgents: number;
    readonly independentOperatorReceipts: number;
  };
  readonly feedback: {
    readonly reports: number;
    readonly reportingOperators: number;
  };
  readonly needs: {
    readonly distinctReports: number;
    readonly totalSubmissions: number;
    readonly reportingOperators: number;
  };
  readonly activity: {
    readonly searches: number;
    readonly retrievals: number;
    readonly recentDays: readonly PilotUsageDay[];
  };
  readonly notMeasured: readonly string[];
}

interface TotalsRow {
  wallets: number;
  operators: number;
  agents: number;
  contributions: number;
  contributing_operators: number;
  receipts: number;
  retrieving_agents: number;
  independent_receipts: number;
  feedback_reports: number;
  feedback_operators: number;
  needs_reports: number;
  needs_submissions: number;
  needs_operators: number;
}

const TOTALS_SQL = `SELECT
  (SELECT COUNT(*) FROM wallet_accounts) AS wallets,
  (SELECT COUNT(*) FROM operators) AS operators,
  (SELECT COUNT(*) FROM agents) AS agents,
  (SELECT COUNT(*) FROM contributions) AS contributions,
  (SELECT COUNT(DISTINCT contributor_operator_id) FROM contributions) AS contributing_operators,
  (SELECT COUNT(*) FROM retrieval_receipts) AS receipts,
  (SELECT COUNT(DISTINCT agent_id) FROM retrieval_receipts) AS retrieving_agents,
  (SELECT COUNT(*)
     FROM retrieval_receipts r
     JOIN agents a ON a.id = r.agent_id
     JOIN contributions c ON c.id = r.contribution_id
    WHERE a.operator_id <> c.contributor_operator_id) AS independent_receipts,
  (SELECT COUNT(*) FROM feedback_reports) AS feedback_reports,
  (SELECT COUNT(DISTINCT consumer_operator_id) FROM feedback_reports) AS feedback_operators,
  (SELECT COUNT(*) FROM needs_reports) AS needs_reports,
  (SELECT COALESCE(SUM(report_count), 0) FROM needs_reports) AS needs_submissions,
  (SELECT COUNT(DISTINCT operator_id) FROM needs_reports) AS needs_operators`;

const STATES_SQL = `SELECT s.state AS state, v.family AS family, COUNT(*) AS n
  FROM version_quality_states s
  JOIN contribution_versions v
    ON v.contribution_id = s.contribution_id AND v.version = s.version
 GROUP BY s.state, v.family`;

const ACTIVITY_TOTALS_SQL = `SELECT
  COALESCE(SUM(CASE WHEN operation = 'search' THEN count ELSE 0 END), 0) AS searches,
  COALESCE(SUM(CASE WHEN operation = 'retrieval' THEN count ELSE 0 END), 0) AS retrievals
  FROM usage_daily_counts`;

const ACTIVITY_DAYS_SQL = `SELECT day,
  SUM(CASE WHEN operation = 'search' THEN count ELSE 0 END) AS searches,
  SUM(CASE WHEN operation = 'retrieval' THEN count ELSE 0 END) AS retrievals
  FROM usage_daily_counts
 GROUP BY day
 ORDER BY day DESC
 LIMIT ?`;

const RECORD_SQL = `INSERT INTO usage_daily_counts (day, operation, count) VALUES (?, ?, 1)
  ON CONFLICT (day, operation) DO UPDATE SET count = count + 1`;

/**
 * Adds one to today's counter for a successful search or full retrieval. Stores no identity or
 * request content. Counting is best effort: a failure here must never fail the agent's request.
 */
export async function recordUsage(
  db: D1Database,
  operation: UsageOperation,
  now: Date,
): Promise<void> {
  try {
    const statement = db.prepare(RECORD_SQL);
    await statement.bind(now.toISOString().slice(0, 10), operation).run();
  } catch {
    // Best effort only.
  }
}

export class PilotUsage {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(): Promise<PilotUsageSnapshot> {
    const totals = await this.db.prepare(TOTALS_SQL).first<TotalsRow>();
    if (!totals) throw new Error("usage totals unavailable");
    const states = await this.db
      .prepare(STATES_SQL)
      .all<{ state: string; family: string; n: number }>();
    const activity = await this.db
      .prepare(ACTIVITY_TOTALS_SQL)
      .first<{ searches: number; retrievals: number }>();
    const days = await this.db
      .prepare(ACTIVITY_DAYS_SQL)
      .bind(USAGE_RECENT_DAYS)
      .all<PilotUsageDay>();

    const versionsByState: Record<string, number> = {};
    const listedVersionsByFamily: Record<string, number> = {};
    for (const row of states.results) {
      versionsByState[row.state] = (versionsByState[row.state] ?? 0) + row.n;
      if (row.state === "listed_unverified") {
        listedVersionsByFamily[row.family] = (listedVersionsByFamily[row.family] ?? 0) + row.n;
      }
    }

    return {
      schemaVersion: "pilot-usage/v1",
      notice:
        "Aggregate operational counts only. They contain no identities and are not proof of " +
        "demand or value.",
      generatedAt: this.now().toISOString(),
      enrollment: {
        enrolledWallets: totals.wallets,
        operators: totals.operators,
        agents: totals.agents,
      },
      contributions: {
        contributionIds: totals.contributions,
        contributingOperators: totals.contributing_operators,
        versionsByState,
        listedVersionsByFamily,
      },
      retrieval: {
        receipts: totals.receipts,
        retrievingAgents: totals.retrieving_agents,
        independentOperatorReceipts: totals.independent_receipts,
      },
      feedback: {
        reports: totals.feedback_reports,
        reportingOperators: totals.feedback_operators,
      },
      needs: {
        distinctReports: totals.needs_reports,
        totalSubmissions: totals.needs_submissions,
        reportingOperators: totals.needs_operators,
      },
      activity: {
        searches: activity?.searches ?? 0,
        retrievals: activity?.retrievals ?? 0,
        recentDays: days.results,
      },
      notMeasured: ["searches and retrievals made before the usage counter was deployed"],
    };
  }
}
