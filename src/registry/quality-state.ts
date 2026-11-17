/**
 * Platform-owned quality state of an exact contribution version. It is never contributor-supplied.
 * The consumer visibility gate (public search/get) treats only `listed_unverified` as visible;
 * that means "allowed to list", not independently verified. Reviewer decisions live elsewhere.
 */
export const QUALITY_STATES = ["pending", "listed_unverified", "rejected", "withdrawn"] as const;
export type QualityState = (typeof QUALITY_STATES)[number];

export function isQualityState(value: unknown): value is QualityState {
  return typeof value === "string" && (QUALITY_STATES as readonly string[]).includes(value);
}

/** Label attached to every publicly returned search/get response. */
export const CONSUMER_QUALITY_LABEL = Object.freeze({
  state: "listed_unverified",
  independentlyVerified: false,
  note: "Listed by the platform; content has not been independently verified.",
} as const);

/** Label for one exact version: verified only when the platform's own checks say so. */
export function versionQualityLabel(verified: boolean) {
  if (!verified) return CONSUMER_QUALITY_LABEL;
  return Object.freeze({
    state: "listed_verified",
    independentlyVerified: true,
    note: "Listed by the platform; verified by the platform checks named in trust.checks.",
  } as const);
}

/** Label for a search response, whose results may differ: per-result detail is in `trust`. */
export function searchQualityLabel(anyVerified: boolean) {
  if (!anyVerified) return CONSUMER_QUALITY_LABEL;
  return Object.freeze({
    state: "listed",
    independentlyVerified: false,
    note: "Results are listed by the platform. Only results marked verified in trust passed a platform check; the rest are not independently verified.",
  } as const);
}

export interface VersionQualityState {
  readonly contributionId: string;
  readonly version: number;
  readonly state: QualityState;
  readonly updatedAt: string;
}

export class QualityStateStore {
  constructor(private readonly db: D1Database) {}

  /** Returns null when the exact version has no state row. Throws on an unrecognized stored state. */
  async get(contributionId: string, version: number): Promise<VersionQualityState | null> {
    const row = await this.db
      .prepare(
        "SELECT state, updated_at FROM version_quality_states WHERE contribution_id = ? AND version = ?",
      )
      .bind(contributionId, version)
      .first<{ state: unknown; updated_at: string }>();
    if (!row) return null;
    if (!isQualityState(row.state)) throw new Error("unrecognized stored quality state");
    return { contributionId, version, state: row.state, updatedAt: row.updated_at };
  }

  /** True only when the exact version has a stored `listed_unverified` state. */
  async isListed(contributionId: string, version: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS ok FROM version_quality_states WHERE contribution_id = ? AND version = ? AND state = 'listed_unverified'",
      )
      .bind(contributionId, version)
      .first();
    return row !== null;
  }

  /** Subset of exact `{id, version}` keys that are listed, as `id\u0000version` strings. */
  async listedKeys(
    refs: readonly { readonly id: string; readonly version: number }[],
  ): Promise<ReadonlySet<string>> {
    if (refs.length === 0) return new Set();
    const { results } = await this.db
      .prepare(
        `SELECT q.contribution_id AS id, q.version AS version
           FROM json_each(?) j
           JOIN version_quality_states q
             ON q.contribution_id = json_extract(j.value, '$.id')
            AND q.version = json_extract(j.value, '$.version')
          WHERE q.state = 'listed_unverified'`,
      )
      .bind(JSON.stringify(refs.map((r) => ({ id: r.id, version: r.version }))))
      .all<{ id: string; version: number }>();
    return new Set(results.map((r) => `${r.id}\u0000${r.version}`));
  }
}
