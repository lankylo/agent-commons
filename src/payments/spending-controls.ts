/**
 * Operator spending controls (Phase 6, no live money). Policies and suspensions are append-only:
 * the latest row applies, and the history stays. Enforcement is in D1 (migration 0014): a purchase
 * reservation is refused when the agent or operator is suspended, the operator has no policy for
 * the currency, the content category is not permitted, a per-transaction, daily or monthly limit
 * would be exceeded, or the agent's available balance would fall below the minimum reserve.
 * Period limits are operator-wide, so spreading purchases across agents does not bypass them.
 *
 * Categories are a content family (`knowledge`, `execution`) or a family and content type
 * (`knowledge:api-reference`). An empty list permits nothing.
 */
const CURRENCY = /^[A-Z]{3,8}$/;
const CATEGORY = /^(knowledge|execution)(:[a-z0-9][a-z0-9-]{0,62})?$/;
const MAX_AMOUNT = 1_000_000_000_000;

export interface SpendingPolicyInput {
  readonly operatorId: string;
  readonly currency: string;
  readonly perTransactionLimitMinor: number;
  readonly dailyLimitMinor: number;
  readonly monthlyLimitMinor: number;
  readonly minimumReserveMinor: number;
  /** Earnings above this need operator action (sweep or approval); applied with withdrawals. */
  readonly maxAutonomousBalanceMinor: number;
  readonly permittedCategories: readonly string[];
  readonly withdrawalsNeedApproval: boolean;
  readonly setBy: string;
}

export interface SpendingPolicy extends SpendingPolicyInput {
  readonly policyId: number;
  readonly effectiveAt: string;
}

export type ControlsResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: "invalid_input"; readonly field: string };
    };

interface PolicyRow {
  policy_id: number;
  operator_id: string;
  currency: string;
  per_transaction_limit_minor: number;
  daily_limit_minor: number;
  monthly_limit_minor: number;
  minimum_reserve_minor: number;
  max_autonomous_balance_minor: number;
  permitted_categories_json: string;
  withdrawals_need_approval: number;
  set_by: string;
  effective_at: string;
}

const amountOk = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_AMOUNT;
const textOk = (s: unknown, max: number) =>
  typeof s === "string" && s.trim().length > 0 && s.length <= max;

/** The first invalid field of a policy, or null when it is valid. */
export function invalidPolicyField(p: SpendingPolicyInput): string | null {
  if (!textOk(p.operatorId, 64)) return "operatorId";
  if (typeof p.currency !== "string" || !CURRENCY.test(p.currency)) return "currency";
  for (const field of [
    "perTransactionLimitMinor",
    "dailyLimitMinor",
    "monthlyLimitMinor",
    "minimumReserveMinor",
    "maxAutonomousBalanceMinor",
  ] as const) {
    if (!amountOk(p[field])) return field;
  }
  if (p.perTransactionLimitMinor > p.dailyLimitMinor) return "perTransactionLimitMinor";
  if (p.dailyLimitMinor > p.monthlyLimitMinor) return "dailyLimitMinor";
  if (
    !Array.isArray(p.permittedCategories) ||
    p.permittedCategories.length > 50 ||
    !p.permittedCategories.every((c) => typeof c === "string" && CATEGORY.test(c))
  ) {
    return "permittedCategories";
  }
  if (typeof p.withdrawalsNeedApproval !== "boolean") return "withdrawalsNeedApproval";
  if (!textOk(p.setBy, 200)) return "setBy";
  return null;
}

function toPolicy(row: PolicyRow): SpendingPolicy {
  return {
    policyId: row.policy_id,
    operatorId: row.operator_id,
    currency: row.currency,
    perTransactionLimitMinor: row.per_transaction_limit_minor,
    dailyLimitMinor: row.daily_limit_minor,
    monthlyLimitMinor: row.monthly_limit_minor,
    minimumReserveMinor: row.minimum_reserve_minor,
    maxAutonomousBalanceMinor: row.max_autonomous_balance_minor,
    permittedCategories: JSON.parse(row.permitted_categories_json) as string[],
    withdrawalsNeedApproval: row.withdrawals_need_approval === 1,
    setBy: row.set_by,
    effectiveAt: row.effective_at,
  };
}

export class SpendingControls {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records a new policy for the operator and currency; it applies from now on. */
  async setPolicy(input: SpendingPolicyInput): Promise<ControlsResult<SpendingPolicy>> {
    const field = invalidPolicyField(input);
    if (field) return { ok: false, error: { code: "invalid_input", field } };
    const row = await this.db
      .prepare(
        `INSERT INTO operator_spending_policies (operator_id, currency, per_transaction_limit_minor,
           daily_limit_minor, monthly_limit_minor, minimum_reserve_minor,
           max_autonomous_balance_minor, permitted_categories_json, withdrawals_need_approval,
           set_by, effective_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .bind(
        input.operatorId,
        input.currency,
        input.perTransactionLimitMinor,
        input.dailyLimitMinor,
        input.monthlyLimitMinor,
        input.minimumReserveMinor,
        input.maxAutonomousBalanceMinor,
        JSON.stringify([...new Set(input.permittedCategories)]),
        input.withdrawalsNeedApproval ? 1 : 0,
        input.setBy,
        this.now().toISOString(),
      )
      .first<PolicyRow>();
    if (!row) throw new Error("spending policy was not recorded");
    return { ok: true, value: toPolicy(row) };
  }

  async currentPolicy(operatorId: string, currency: string): Promise<SpendingPolicy | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM operator_spending_policies WHERE operator_id = ? AND currency = ?
         ORDER BY policy_id DESC LIMIT 1`,
      )
      .bind(operatorId, currency)
      .first<PolicyRow>();
    return row ? toPolicy(row) : null;
  }

  /** Emergency suspension of one agent, or of every agent of the operator when agentId is null. */
  suspend(target: SuspensionTarget, reason: string, setBy: string) {
    return this.record(target, "suspend", reason, setBy);
  }

  resume(target: SuspensionTarget, reason: string, setBy: string) {
    return this.record(target, "resume", reason, setBy);
  }

  /** True when the agent may not reserve or withdraw: suspended here, or inactive identity. */
  async isSuspended(operatorId: string, agentId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM operators WHERE id = ?1 AND status <> 'active')
           OR EXISTS (SELECT 1 FROM agents WHERE id = ?2 AND status <> 'active')
           OR COALESCE((SELECT action FROM spending_suspensions
                        WHERE operator_id = ?1 AND agent_id IS NULL
                        ORDER BY suspension_id DESC LIMIT 1), '') = 'suspend'
           OR COALESCE((SELECT action FROM spending_suspensions
                        WHERE operator_id = ?1 AND agent_id = ?2
                        ORDER BY suspension_id DESC LIMIT 1), '') = 'suspend' AS suspended`,
      )
      .bind(operatorId, agentId)
      .first<{ suspended: number }>();
    return row?.suspended === 1;
  }

  private async record(
    target: SuspensionTarget,
    action: "suspend" | "resume",
    reason: string,
    setBy: string,
  ): Promise<ControlsResult<{ readonly suspensionId: number }>> {
    if (!textOk(target.operatorId, 64)) {
      return { ok: false, error: { code: "invalid_input", field: "operatorId" } };
    }
    if (target.agentId !== null && !textOk(target.agentId, 64)) {
      return { ok: false, error: { code: "invalid_input", field: "agentId" } };
    }
    if (!textOk(reason, 500))
      return { ok: false, error: { code: "invalid_input", field: "reason" } };
    if (!textOk(setBy, 200)) return { ok: false, error: { code: "invalid_input", field: "setBy" } };
    const row = await this.db
      .prepare(
        `INSERT INTO spending_suspensions (operator_id, agent_id, action, reason, set_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING suspension_id`,
      )
      .bind(target.operatorId, target.agentId, action, reason, setBy, this.now().toISOString())
      .first<{ suspension_id: number }>();
    if (!row) throw new Error("suspension was not recorded");
    return { ok: true, value: { suspensionId: row.suspension_id } };
  }
}

export interface SuspensionTarget {
  readonly operatorId: string;
  /** null suspends or resumes every agent of the operator. */
  readonly agentId: string | null;
}
