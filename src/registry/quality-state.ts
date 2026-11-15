/**
 * Platform-owned quality state of an exact contribution version (storage foundation only).
 * Nothing here decides, changes or enforces visibility: search and retrieval do not consult it,
 * and no reviewer decision path exists yet. It is never contributor-supplied.
 */
export const QUALITY_STATES = ["pending", "listed_unverified", "rejected", "withdrawn"] as const;
export type QualityState = (typeof QUALITY_STATES)[number];

export function isQualityState(value: unknown): value is QualityState {
  return typeof value === "string" && (QUALITY_STATES as readonly string[]).includes(value);
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
}
