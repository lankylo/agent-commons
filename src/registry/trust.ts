/**
 * Platform-computed trust signals for exact contribution versions (Phase 5).
 *
 * Everything here is derived by the platform from data a contributor cannot write: the append-only
 * source re-check log, retrieval receipts and feedback reports from OTHER operators. One operator
 * counts once, however many agents it runs, and the contributor's own operator never counts.
 *
 * A version is `verified` only when a named check passed:
 *   - `source_hash_match` (Knowledge): every recorded source matched its stored SHA-256 at its
 *     latest platform re-check;
 *   - `independent_operator_agreement` (both families): at least {@link TRUST_THRESHOLDS.operators}
 *     independent operators reported the content accurate (Knowledge) or the outcome successful
 *     (Execution).
 * It is never verified while a source that matched before no longer matches, or while at least
 * {@link TRUST_THRESHOLDS.operators} independent operators dispute it. Execution recipes are never
 * run by the platform, so Execution verification rests on operator reports alone.
 *
 * `reliabilityScore` is confirming operators divided by reporting operators on the core dimension
 * (accuracy or outcome), and stays null until {@link TRUST_THRESHOLDS.operators} independent
 * operators have reported. `consumerCount` counts independent operators holding a retrieval
 * receipt. `lastVerifiedAt` moves only when every source matched.
 */
import { epochMs, SEARCH_RANKING } from "./search";

export const TRUST_THRESHOLDS = {
  /** Independent operators needed for agreement, a dispute, a stale report or a score. */
  operators: 2,
} as const;

export const TRUST_CHECKS = ["source_hash_match", "independent_operator_agreement"] as const;
export type TrustCheck = (typeof TRUST_CHECKS)[number];

export const TRUST_FLAGS = [
  "source_changed",
  "source_unreachable",
  "source_hash_unconfirmed",
  "disputed",
  "reported_stale",
  "review_overdue",
  "dependency_unavailable",
  "dependency_stale",
] as const;
export type TrustFlag = (typeof TRUST_FLAGS)[number];

export const SOURCE_STATUSES = [
  "none",
  "unchecked",
  "matched",
  "unconfirmed",
  "changed",
  "unreachable",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface VersionTrust {
  readonly contributionId: string;
  readonly version: number;
  readonly verified: boolean;
  /** Checks that currently pass. Empty when none does. */
  readonly checks: readonly TrustCheck[];
  /** Reasons for caution. A flag never hides a version; it informs the consuming agent. */
  readonly flags: readonly TrustFlag[];
  readonly sourceStatus: SourceStatus;
  readonly sourceCheckedAt: string | null;
  readonly confirmingOperators: number;
  readonly disputingOperators: number;
  readonly reportingOperators: number;
}

/** Compact per-result form returned beside search results. */
export interface TrustSummary {
  readonly contributionId: string;
  readonly version: number;
  readonly verified: boolean;
  readonly checks: readonly TrustCheck[];
  readonly flags: readonly TrustFlag[];
}

export interface VersionRef {
  readonly id: string;
  readonly version: number;
}

const LATEST_CHECKS_CTE = `latest AS (
  SELECT sc.contribution_id, sc.version, sc.ordinal, sc.outcome, sc.checked_at,
         EXISTS (SELECT 1 FROM source_checks p
                  WHERE p.contribution_id = sc.contribution_id AND p.version = sc.version
                    AND p.ordinal = sc.ordinal AND p.outcome = 'match'
                    AND p.check_id < sc.check_id) AS matched_before
    FROM source_checks sc
   WHERE sc.check_id = (SELECT MAX(x.check_id) FROM source_checks x
                         WHERE x.contribution_id = sc.contribution_id
                           AND x.version = sc.version AND x.ordinal = sc.ordinal)
)`;

const FINDING = "json_extract(f.assessment_json, '$.finding')";
const CORE = "f.dimension IN ('accuracy','outcome')";

/** ?1 operator threshold, ?2 now, ?3 contribution ID or NULL for every listed version, ?4 version. */
const REFRESH_TRUST_SQL = `WITH ${LATEST_CHECKS_CTE},
src AS (
  SELECT ks.contribution_id, ks.version, COUNT(*) AS total,
         SUM(CASE WHEN l.outcome = 'match' THEN 1 ELSE 0 END) AS matched,
         SUM(CASE WHEN l.outcome = 'mismatch' AND l.matched_before = 1 THEN 1 ELSE 0 END)
           AS changed,
         SUM(CASE WHEN l.outcome = 'mismatch' AND l.matched_before = 0 THEN 1 ELSE 0 END)
           AS unconfirmed,
         SUM(CASE WHEN l.outcome = 'unreachable' THEN 1 ELSE 0 END) AS unreachable,
         MIN(l.checked_at) AS checked_at
    FROM knowledge_sources ks
    LEFT JOIN latest l
      ON l.contribution_id = ks.contribution_id AND l.version = ks.version
     AND l.ordinal = ks.ordinal
   GROUP BY ks.contribution_id, ks.version
),
fb AS (
  SELECT f.contribution_id, f.version,
         SUM(CASE WHEN ${CORE} AND ${FINDING} IN ('accurate','success') THEN 1 ELSE 0 END)
           AS confirming,
         SUM(CASE WHEN ${CORE} AND ${FINDING} IN ('inaccurate','failure') THEN 1 ELSE 0 END)
           AS disputing,
         SUM(CASE WHEN ${CORE}
                   AND ${FINDING} IN ('accurate','inaccurate','mixed','success','failure','partial')
                  THEN 1 ELSE 0 END) AS reporting,
         SUM(CASE WHEN f.dimension = 'staleness' AND ${FINDING} = 'appears_stale'
                  THEN 1 ELSE 0 END) AS stale
    FROM feedback_reports f
    JOIN contributions c ON c.id = f.contribution_id
   WHERE f.consumer_operator_id <> c.contributor_operator_id
   GROUP BY f.contribution_id, f.version
)
INSERT INTO version_trust
  (contribution_id, version, source_status, source_checked_at, confirming_operators,
   disputing_operators, reporting_operators, stale_reports, verified, updated_at)
SELECT v.contribution_id, v.version,
       CASE WHEN s.total IS NULL THEN 'none'
            WHEN s.changed > 0 THEN 'changed'
            WHEN s.unreachable > 0 THEN 'unreachable'
            WHEN s.unconfirmed > 0 THEN 'unconfirmed'
            WHEN s.matched = s.total THEN 'matched'
            ELSE 'unchecked' END,
       s.checked_at,
       COALESCE(b.confirming, 0), COALESCE(b.disputing, 0), COALESCE(b.reporting, 0),
       COALESCE(b.stale, 0),
       CASE WHEN COALESCE(b.disputing, 0) >= ?1 THEN 0
            WHEN COALESCE(s.changed, 0) > 0 THEN 0
            WHEN s.total IS NOT NULL AND s.matched = s.total THEN 1
            WHEN COALESCE(b.confirming, 0) >= ?1 THEN 1
            ELSE 0 END,
       ?2
  FROM contribution_versions v
  JOIN version_quality_states q
    ON q.contribution_id = v.contribution_id AND q.version = v.version
   AND q.state = 'listed_unverified'
  LEFT JOIN src s ON s.contribution_id = v.contribution_id AND s.version = v.version
  LEFT JOIN fb b ON b.contribution_id = v.contribution_id AND b.version = v.version
 WHERE (?3 IS NULL OR (v.contribution_id = ?3 AND v.version = ?4))
    ON CONFLICT (contribution_id, version) DO UPDATE SET
       source_status = excluded.source_status,
       source_checked_at = excluded.source_checked_at,
       confirming_operators = excluded.confirming_operators,
       disputing_operators = excluded.disputing_operators,
       reporting_operators = excluded.reporting_operators,
       stale_reports = excluded.stale_reports,
       verified = excluded.verified,
       updated_at = excluded.updated_at`;

const INDEPENDENT_CONSUMERS = `(SELECT COUNT(DISTINCT a.operator_id)
     FROM retrieval_receipts r
     JOIN agents a ON a.id = r.agent_id
     JOIN contributions c ON c.id = r.contribution_id
    WHERE r.contribution_id = version_platform_state.contribution_id
      AND r.version = version_platform_state.version
      AND a.operator_id <> c.contributor_operator_id)`;

const OWN_TRUST = `FROM version_trust t
    WHERE t.contribution_id = version_platform_state.contribution_id
      AND t.version = version_platform_state.version`;

/** Same parameters as {@link REFRESH_TRUST_SQL}; runs after it in one batch. */
const REFRESH_PLATFORM_STATE_SQL = `UPDATE version_platform_state SET
  consumer_count = ${INDEPENDENT_CONSUMERS},
  reliability_score = (SELECT CASE WHEN t.reporting_operators >= ?1
                                   THEN ROUND(1.0 * t.confirming_operators
                                              / t.reporting_operators, 4) END
                         ${OWN_TRUST}),
  last_verified_at = COALESCE(
    (SELECT t.source_checked_at ${OWN_TRUST} AND t.source_status = 'matched'),
    last_verified_at),
  updated_at = ?2
 WHERE EXISTS (SELECT 1 ${OWN_TRUST})
   AND (?3 IS NULL OR (contribution_id = ?3 AND version = ?4))`;

/** ?1 now, ?2 contribution ID, ?3 version. Writes only when the count actually changes. */
const REFRESH_CONSUMERS_SQL = `UPDATE version_platform_state SET
  consumer_count = ${INDEPENDENT_CONSUMERS},
  updated_at = ?1
 WHERE contribution_id = ?2 AND version = ?3
   AND consumer_count <> ${INDEPENDENT_CONSUMERS}`;

const dueMs = (v: string, p: string): string =>
  `(MAX(${epochMs(`${v}.as_of`)}, COALESCE(${epochMs(`${p}.last_verified_at`)}, ${epochMs(`${v}.as_of`)}))
     + ${v}.review_interval_days * ${SEARCH_RANKING.msPerDay})`;

/** ?1 JSON array of `{id, version}`, ?2 reference time in epoch milliseconds. */
const READ_SQL = `SELECT v.contribution_id AS id, v.version AS version, v.family AS family,
       t.source_status AS source_status, t.source_checked_at AS source_checked_at,
       COALESCE(t.confirming_operators, 0) AS confirming,
       COALESCE(t.disputing_operators, 0) AS disputing,
       COALESCE(t.reporting_operators, 0) AS reporting,
       COALESCE(t.stale_reports, 0) AS stale_reports,
       COALESCE(t.verified, 0) AS verified,
       CASE WHEN ${dueMs("v", "p")} IS NULL OR ?2 >= ${dueMs("v", "p")} THEN 1 ELSE 0 END
         AS overdue,
       (SELECT COUNT(*)
          FROM contribution_references r
          LEFT JOIN version_quality_states dq
            ON dq.contribution_id = r.to_contribution_id AND dq.version = r.to_version
         WHERE r.from_contribution_id = v.contribution_id AND r.from_version = v.version
           AND COALESCE(dq.state, '') <> 'listed_unverified') AS deps_unavailable,
       (SELECT COUNT(*)
          FROM contribution_references r
          JOIN version_quality_states dq
            ON dq.contribution_id = r.to_contribution_id AND dq.version = r.to_version
           AND dq.state = 'listed_unverified'
          JOIN contribution_versions dv
            ON dv.contribution_id = r.to_contribution_id AND dv.version = r.to_version
          JOIN version_platform_state dp
            ON dp.contribution_id = dv.contribution_id AND dp.version = dv.version
         WHERE r.from_contribution_id = v.contribution_id AND r.from_version = v.version
           AND (${dueMs("dv", "dp")} IS NULL OR ?2 >= ${dueMs("dv", "dp")})) AS deps_stale
  FROM json_each(?1) j
  JOIN contribution_versions v
    ON v.contribution_id = json_extract(j.value, '$.id')
   AND v.version = json_extract(j.value, '$.version')
  JOIN version_platform_state p
    ON p.contribution_id = v.contribution_id AND p.version = v.version
  LEFT JOIN version_trust t
    ON t.contribution_id = v.contribution_id AND t.version = v.version`;

interface ReadRow {
  id: string;
  version: number;
  family: string;
  source_status: string | null;
  source_checked_at: string | null;
  confirming: number;
  disputing: number;
  reporting: number;
  stale_reports: number;
  verified: number;
  overdue: number;
  deps_unavailable: number;
  deps_stale: number;
}

function isSourceStatus(value: unknown): value is SourceStatus {
  return typeof value === "string" && (SOURCE_STATUSES as readonly string[]).includes(value);
}

function toTrust(row: ReadRow): VersionTrust {
  const fallback: SourceStatus = row.family === "knowledge" ? "unchecked" : "none";
  const sourceStatus = isSourceStatus(row.source_status) ? row.source_status : fallback;
  const threshold = TRUST_THRESHOLDS.operators;

  const checks: TrustCheck[] = [];
  if (sourceStatus === "matched") checks.push("source_hash_match");
  if (row.confirming >= threshold) checks.push("independent_operator_agreement");

  const flags: TrustFlag[] = [];
  if (sourceStatus === "changed") flags.push("source_changed");
  if (sourceStatus === "unreachable") flags.push("source_unreachable");
  if (sourceStatus === "unconfirmed") flags.push("source_hash_unconfirmed");
  if (row.disputing >= threshold) flags.push("disputed");
  if (row.stale_reports >= threshold) flags.push("reported_stale");
  if (row.overdue === 1) flags.push("review_overdue");
  if (row.deps_unavailable > 0) flags.push("dependency_unavailable");
  if (row.deps_stale > 0) flags.push("dependency_stale");

  return Object.freeze({
    contributionId: row.id,
    version: row.version,
    // The stored value already applies the dispute and source-change rules.
    verified: row.verified === 1 && checks.length > 0,
    checks: Object.freeze(checks),
    flags: Object.freeze(flags),
    sourceStatus,
    sourceCheckedAt: row.source_checked_at,
    confirmingOperators: row.confirming,
    disputingOperators: row.disputing,
    reportingOperators: row.reporting,
  });
}

export function toTrustSummary(trust: VersionTrust): TrustSummary {
  return {
    contributionId: trust.contributionId,
    version: trust.version,
    verified: trust.verified,
    checks: trust.checks,
    flags: trust.flags,
  };
}

export const trustKey = (id: string, version: number): string => `${id}\u0000${version}`;

export class TrustStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Recomputes the trust summary and platform state from the stored checks, receipts and feedback.
   * With no target it covers every listed version. Idempotent: the same stored data always gives
   * the same result.
   */
  async refresh(target?: VersionRef): Promise<void> {
    const params = [
      TRUST_THRESHOLDS.operators,
      this.now().toISOString(),
      target?.id ?? null,
      target?.version ?? null,
    ];
    await this.db.batch([
      this.db.prepare(REFRESH_TRUST_SQL).bind(...params),
      this.db.prepare(REFRESH_PLATFORM_STATE_SQL).bind(...params),
    ]);
  }

  /** Updates only the independent-consumer count of one version, and only when it changed. */
  async refreshConsumers(target: VersionRef): Promise<void> {
    await this.db
      .prepare(REFRESH_CONSUMERS_SQL)
      .bind(this.now().toISOString(), target.id, target.version)
      .run();
  }

  /** Trust for exact versions, keyed by {@link trustKey}. Unknown versions are absent. */
  async read(refs: readonly VersionRef[]): Promise<ReadonlyMap<string, VersionTrust>> {
    const out = new Map<string, VersionTrust>();
    if (refs.length === 0) return out;
    const keys = JSON.stringify(refs.map((r) => ({ id: r.id, version: r.version })));
    const { results } = await this.db
      .prepare(READ_SQL)
      .bind(keys, this.now().getTime())
      .all<ReadRow>();
    for (const row of results) out.set(trustKey(row.id, row.version), toTrust(row));
    return out;
  }
}

/** Refreshes without ever failing the caller's request: trust is derived data and can be redone. */
export async function refreshTrustBestEffort(
  db: D1Database,
  now: () => Date,
  target: VersionRef,
  scope: "all" | "consumers",
): Promise<void> {
  try {
    const store = new TrustStore(db, now);
    await (scope === "all" ? store.refresh(target) : store.refreshConsumers(target));
  } catch {
    // Best effort only.
  }
}
