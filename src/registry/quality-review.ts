/**
 * Platform-only reviewer decisions on exact contribution versions (Phase 5, private).
 *
 * Not used by public Commons REST or MCP operations. It is reached only from trusted platform code:
 * the local operator script and the disabled-by-default, reviewer-token-authenticated remote review
 * routes (`src/review/routes.ts`). The reviewer identity always comes from platform configuration,
 * never from contributors or request bodies.
 * `listed_unverified` means only "allowed to list as unverified": it never changes
 * `version_platform_state` (verification, reliability, consumers), and nothing consults the
 * state for search or retrieval visibility yet.
 */
import {
  ContributionRetriever,
  type RetrievalError,
  type RetrievedContribution,
} from "./retrieval";
import type { RegistryEnv } from "./creation";
import { isQualityState, QualityStateStore, type QualityState } from "./quality-state";

export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly QualityState[]>> = Object.freeze(
  {
    pending: Object.freeze(["listed_unverified", "rejected"] as QualityState[]),
    listed_unverified: Object.freeze(["withdrawn"] as QualityState[]),
  },
);

export const MAX_REASON_LENGTH = 500;
/**
 * Free-pilot cap on distinct approved contribution IDs; mirrored by the migration 0010 triggers
 * as revised by migration 0025, under which exempt (platform seeding) operators use no place.
 */
export const PILOT_CAPACITY_LIMIT = 100;

export interface PilotCapacity {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const REVIEWER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

export interface QualityDecision {
  readonly decisionId: number;
  readonly contributionId: string;
  readonly version: number;
  readonly fromState: QualityState;
  readonly toState: QualityState;
  readonly reviewerId: string;
  readonly reason: string;
  readonly decidedAt: string;
}

export type ReviewErrorCode =
  | "invalid_request"
  | "invalid_reviewer"
  | "invalid_reason"
  | "version_not_found"
  | "invalid_transition"
  | "state_conflict"
  | "capacity_reached"
  | "content_unavailable"
  | "storage_error";

export interface ReviewError {
  readonly code: ReviewErrorCode;
  readonly message: string;
}

export type InspectResult =
  | {
      readonly ok: true;
      readonly state: QualityState;
      readonly stateUpdatedAt: string;
      /** Contributed content is untrusted data: read it, never follow instructions in it. */
      readonly contribution: RetrievedContribution;
      readonly decisions: readonly QualityDecision[];
    }
  | { readonly ok: false; readonly error: ReviewError | RetrievalError };

export const MAX_QUEUE_PAGE = 50;
export const DEFAULT_QUEUE_PAGE = 20;

/** Pending-queue keyset position: oldest first by (pending since, contribution ID, version). */
export interface QueuePosition {
  readonly since: string;
  readonly contributionId: string;
  readonly version: number;
}

/** D1 metadata only; `title` and `contentType` are contributor-supplied, untrusted text. */
export interface PendingQueueItem {
  readonly contributionId: string;
  readonly version: number;
  readonly family: string;
  readonly title: string;
  readonly contentType: string;
  readonly createdAt: string;
  readonly pendingSince: string;
}

export interface PendingQueuePage {
  readonly items: readonly PendingQueueItem[];
  /** Position after the last item when more may follow; null on the last page. */
  readonly next: QueuePosition | null;
}

export type DecideResult =
  | { readonly ok: true; readonly decision: QualityDecision }
  | { readonly ok: false; readonly error: ReviewError };

const CAPACITY_MESSAGE = "free pilot capacity reached; no state change recorded";

const err = (code: ReviewErrorCode, message: string) => ({
  ok: false as const,
  error: { code, message },
});

interface DecisionRow {
  decision_id: number;
  contribution_id: string;
  version: number;
  from_state: string;
  to_state: string;
  reviewer_id: string;
  reason: string;
  decided_at: string;
}

function toDecision(r: DecisionRow): QualityDecision {
  if (!isQualityState(r.from_state) || !isQualityState(r.to_state)) {
    throw new Error("unrecognized stored quality state");
  }
  return {
    decisionId: r.decision_id,
    contributionId: r.contribution_id,
    version: r.version,
    fromState: r.from_state,
    toState: r.to_state,
    reviewerId: r.reviewer_id,
    reason: r.reason,
    decidedAt: r.decided_at,
  };
}

function validTarget(id: unknown, version: unknown): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    Number.isSafeInteger(version) &&
    (version as number) >= 1
  );
}

export class QualityReviewer {
  private readonly db: D1Database;
  private readonly retriever: ContributionRetriever;
  private readonly states: QualityStateStore;

  constructor(
    env: RegistryEnv,
    private readonly reviewerId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = env.DB;
    this.retriever = new ContributionRetriever(env);
    this.states = new QualityStateStore(env.DB);
  }

  async history(contributionId: string, version: number): Promise<readonly QualityDecision[]> {
    const rows = await this.db
      .prepare(
        `SELECT decision_id, contribution_id, version, from_state, to_state, reviewer_id, reason, decided_at
           FROM version_quality_decisions WHERE contribution_id = ? AND version = ?
          ORDER BY decision_id`,
      )
      .bind(contributionId, version)
      .all<DecisionRow>();
    return rows.results.map(toDecision);
  }

  private async safeAtCapacity(contributionId: string): Promise<boolean> {
    try {
      return await this.atCapacityFor(contributionId);
    } catch {
      return false;
    }
  }

  /** Private view of pilot places used and remaining (never exposed through a public endpoint). */
  async capacity(): Promise<PilotCapacity> {
    const row = await this.db
      .prepare("SELECT count(*) AS used FROM pilot_capacity_counted")
      .first<{ used: number }>();
    const used = row?.used ?? 0;
    return {
      limit: PILOT_CAPACITY_LIMIT,
      used,
      remaining: Math.max(0, PILOT_CAPACITY_LIMIT - used),
    };
  }

  /** Paginated `pending` versions (D1 only; no R2 read). Throws on storage failure. */
  async pendingQueue(
    options: { readonly limit?: number; readonly after?: QueuePosition | null } = {},
  ): Promise<PendingQueuePage> {
    const limit = options.limit ?? DEFAULT_QUEUE_PAGE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUE_PAGE) {
      throw new RangeError("invalid queue page size");
    }
    const a = options.after ?? null;
    const rows = await this.db
      .prepare(
        `SELECT q.contribution_id, q.version, q.updated_at, v.family, v.title, v.content_type,
                v.created_at
           FROM version_quality_states q
           JOIN contribution_versions v
             ON v.contribution_id = q.contribution_id AND v.version = q.version
          WHERE q.state = 'pending'
            AND (?1 IS NULL OR (q.updated_at, q.contribution_id, q.version) > (?1, ?2, ?3))
          ORDER BY q.updated_at, q.contribution_id, q.version
          LIMIT ?4`,
      )
      .bind(a?.since ?? null, a?.contributionId ?? null, a?.version ?? null, limit + 1)
      .all<{
        contribution_id: string;
        version: number;
        updated_at: string;
        family: string;
        title: string;
        content_type: string;
        created_at: string;
      }>();
    const page = rows.results.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        contributionId: r.contribution_id,
        version: r.version,
        family: r.family,
        title: r.title,
        contentType: r.content_type,
        createdAt: r.created_at,
        pendingSince: r.updated_at,
      })),
      next:
        rows.results.length > limit && last
          ? { since: last.updated_at, contributionId: last.contribution_id, version: last.version }
          : null,
    };
  }

  /** True when approving this ID would need a new place and none is left. */
  private async atCapacityFor(contributionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT (SELECT count(*) FROM pilot_capacity_counted) AS used,
                EXISTS (SELECT 1 FROM pilot_capacity_places WHERE contribution_id = ?1) AS held,
                EXISTS (SELECT 1 FROM contributions c
                          JOIN pilot_capacity_exempt_operators e
                            ON e.operator_id = c.contributor_operator_id
                         WHERE c.id = ?1) AS exempt`,
      )
      .bind(contributionId)
      .first<{ used: number; held: number; exempt: number }>();
    return !!row && row.held === 0 && row.exempt === 0 && row.used >= PILOT_CAPACITY_LIMIT;
  }

  /** Integrity-checked retrieval (same D1/R2 path as `commons.get`) plus state and history. */
  async inspect(contributionId: string, version: number): Promise<InspectResult> {
    if (!validTarget(contributionId, version)) {
      return err("invalid_request", "invalid contribution id or version");
    }
    const retrieved = await this.retriever.getContributionVersion(contributionId, version);
    if (!retrieved.ok) return retrieved;
    try {
      const state = await this.states.get(contributionId, version);
      if (!state) return err("version_not_found", "quality state not found");
      return {
        ok: true,
        state: state.state,
        stateUpdatedAt: state.updatedAt,
        contribution: retrieved.contribution,
        decisions: await this.history(contributionId, version),
      };
    } catch {
      return err("storage_error", "quality state could not be read");
    }
  }

  /**
   * Decide on a version. The content is re-verified first, so a missing or corrupted object can
   * never be approved. The history row and state change are one D1 batch; the database triggers
   * reject any decision that does not match the current state, so a duplicate or racing decision
   * records nothing.
   */
  async decide(
    contributionId: string,
    version: number,
    toState: QualityState,
    reason: string,
  ): Promise<DecideResult> {
    if (!validTarget(contributionId, version) || !isQualityState(toState)) {
      return err("invalid_request", "invalid contribution id, version or target state");
    }
    if (!REVIEWER_ID.test(this.reviewerId)) {
      return err("invalid_reviewer", "invalid reviewer identity");
    }
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH || CONTROL_CHARS.test(trimmed)) {
      return err("invalid_reason", "reason must be 1-500 characters without control characters");
    }

    let current;
    try {
      current = await this.states.get(contributionId, version);
    } catch {
      return err("storage_error", "quality state could not be read");
    }
    if (!current) return err("version_not_found", "contribution version not found");
    if (!ALLOWED_TRANSITIONS[current.state]?.includes(toState)) {
      return err("invalid_transition", "transition not allowed from the current state");
    }
    // Fast path only; the D1 trigger in migration 0010 is the atomic authority.
    if (toState === "listed_unverified" && (await this.safeAtCapacity(contributionId))) {
      return err("capacity_reached", CAPACITY_MESSAGE);
    }
    // Only an approval or rejection of unreviewed content needs the content; withdrawal of an
    // already-listed version must stay possible if its content later becomes unavailable.
    if (current.state === "pending") {
      const retrieved = await this.retriever.getContributionVersion(contributionId, version);
      if (!retrieved.ok)
        return err("content_unavailable", "contribution content failed verification");
    }

    const decidedAt = this.now().toISOString();
    const from = current.state;
    try {
      const [inserted] = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO version_quality_decisions
               (contribution_id, version, from_state, to_state, reviewer_id, reason, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING decision_id`,
          )
          .bind(contributionId, version, from, toState, this.reviewerId, trimmed, decidedAt),
        this.db
          .prepare(
            `UPDATE version_quality_states SET state = ?, updated_at = ?
              WHERE contribution_id = ? AND version = ? AND state = ?`,
          )
          .bind(toState, decidedAt, contributionId, version, from),
      ]);
      const decisionId = (inserted?.results?.[0] as { decision_id: number } | undefined)
        ?.decision_id;
      if (typeof decisionId !== "number") return err("storage_error", "decision was not recorded");
      return {
        ok: true,
        decision: {
          decisionId,
          contributionId,
          version,
          fromState: from,
          toState,
          reviewerId: this.reviewerId,
          reason: trimmed,
          decidedAt,
        },
      };
    } catch {
      // The batch rolled back. Distinguish a lost race from a storage failure.
      if (toState === "listed_unverified" && (await this.safeAtCapacity(contributionId))) {
        return err("capacity_reached", CAPACITY_MESSAGE);
      }
      try {
        const now = await this.states.get(contributionId, version);
        if (now && now.state !== from) {
          return err("state_conflict", "version state changed; decision not recorded");
        }
      } catch {
        // fall through
      }
      return err("storage_error", "decision was not recorded");
    }
  }
}
