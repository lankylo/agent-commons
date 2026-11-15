import type { AgentId, OperatorId } from "./identity/types";

export const DEFAULT_RATE_LIMITS = {
  agentLimit: 60,
  operatorLimit: 300,
  windowSeconds: 60,
} as const;

export interface RateLimitConfig {
  readonly now?: () => Date;
  readonly agentLimit?: number;
  readonly operatorLimit?: number;
  readonly windowSeconds?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
  readonly scope?: "agent" | "operator";
  readonly limit?: number;
  readonly unavailable?: boolean;
}

function safePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export class RateLimitService {
  private readonly now: () => Date;
  private readonly agentLimit: number;
  private readonly operatorLimit: number;
  private readonly windowMs: number;

  constructor(
    private readonly db: D1Database,
    config: RateLimitConfig = {},
  ) {
    this.now = config.now ?? (() => new Date());
    this.agentLimit = safePositiveInt(config.agentLimit, DEFAULT_RATE_LIMITS.agentLimit);
    this.operatorLimit = safePositiveInt(config.operatorLimit, DEFAULT_RATE_LIMITS.operatorLimit);
    this.windowMs = safePositiveInt(config.windowSeconds, DEFAULT_RATE_LIMITS.windowSeconds) * 1000;
  }

  async check(agentId: AgentId, operatorId: OperatorId): Promise<RateLimitDecision> {
    const agent = await this.checkScope("agent", agentId, this.agentLimit);
    if (!agent.allowed) {
      if (agent.unavailable) {
        return { allowed: false, unavailable: true, scope: "agent", limit: agent.limit };
      }
      return {
        allowed: false,
        retryAfterMs: agent.retryAfterMs,
        scope: "agent",
        limit: agent.limit,
      };
    }
    const operator = await this.checkScope("operator", operatorId, this.operatorLimit);
    if (!operator.allowed) {
      if (operator.unavailable) {
        return { allowed: false, unavailable: true, scope: "operator", limit: operator.limit };
      }
      return {
        allowed: false,
        retryAfterMs: operator.retryAfterMs,
        scope: "operator",
        limit: operator.limit,
      };
    }
    return { allowed: true };
  }

  /**
   * Count one request against an arbitrary platform-chosen key (for unauthenticated routes such
   * as wallet enrollment). Keys must not contain secrets; the scope label is not reported.
   */
  async checkKey(key: string, limit: number): Promise<RateLimitDecision> {
    const d = await this.count(key, safePositiveInt(limit, 1));
    return { allowed: d.allowed, retryAfterMs: d.retryAfterMs, unavailable: d.unavailable };
  }

  private async checkScope(
    scope: "agent" | "operator",
    id: string,
    limit: number,
  ): Promise<RateLimitDecision> {
    return { ...(await this.count(`${scope}:${id}`, limit)), scope };
  }

  private async count(key: string, limit: number): Promise<RateLimitDecision> {
    const nowMs = this.now().getTime();
    const bucketMs = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const windowStart = new Date(bucketMs).toISOString();
    const staleBefore = new Date(Math.max(0, bucketMs - this.windowMs * 2)).toISOString();
    try {
      await this.db
        .prepare("DELETE FROM rate_limit_windows WHERE window_start < ?")
        .bind(staleBefore)
        .run();
      const row = await this.db
        .prepare(
          `INSERT INTO rate_limit_windows (scope, window_start, count)
           VALUES (?, ?, 1)
           ON CONFLICT(scope, window_start) DO UPDATE SET count = rate_limit_windows.count + 1
           WHERE rate_limit_windows.count < ?
           RETURNING count`,
        )
        .bind(key, windowStart, limit)
        .first<{ count: number } | null>();
      if (row === null || row === undefined) {
        const retryAfterMs = Math.max(0, bucketMs + this.windowMs - nowMs);
        return { allowed: false, retryAfterMs, limit };
      }
      return { allowed: true, limit };
    } catch {
      return { allowed: false, unavailable: true, limit };
    }
  }
}
