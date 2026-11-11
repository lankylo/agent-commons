/**
 * D1-backed identity repository: operator and agent persistence and lifecycle.
 *
 * Platform code assigns ids, timestamps, status and the allow-list flag; callers supply
 * only `kind` and `displayName`. An agent is bound to exactly one operator at
 * registration and can never be re-parented. Every statement is parameterized.
 * No credentials, authentication or contribution creation live here.
 * Operators are never deleted and agents are only revoked (schema triggers enforce it).
 */
import type {
  ActorRef,
  Agent,
  AgentId,
  AgentStatus,
  Operator,
  OperatorId,
  OperatorKind,
  OperatorStatus,
} from "./types";

export type IdentityErrorCode =
  | "invalid_input"
  | "immutable_field"
  | "duplicate_identity"
  | "not_found"
  | "invalid_state_transition"
  | "operator_suspended"
  | "agent_revoked";

export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
    readonly details: { readonly operatorId?: string; readonly agentId?: string } = {},
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface IdentityEnv {
  DB: D1Database;
}

/** Platform-supplied sources, injectable for tests only. */
export interface IdentityPlatform {
  readonly now: () => Date;
  readonly newId: (prefix: "op" | "ag") => string;
}

const defaultPlatform: IdentityPlatform = {
  now: () => new Date(),
  newId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
};

export interface NewOperator {
  readonly kind: OperatorKind;
  readonly displayName: string;
}
export interface NewAgent {
  readonly displayName: string;
}
/** The only caller-mutable profile field today. */
export interface ProfileUpdate {
  readonly displayName: string;
}

/** An agent together with the single operator it resolves to. */
export interface ResolvedAgent {
  readonly agent: Agent;
  readonly operator: Operator;
}

const KINDS: readonly string[] = ["individual", "organization"];
const MUTABLE_PROFILE_FIELDS = new Set(["displayName"]);

interface OperatorRow {
  id: string;
  kind: string;
  display_name: string;
  status: string;
  contribution_allow_listed: number;
  created_at: string;
}
interface AgentRow {
  id: string;
  operator_id: string;
  display_name: string;
  status: string;
  created_at: string;
}

const OPERATOR_COLS = "id, kind, display_name, status, contribution_allow_listed, created_at";
const AGENT_COLS = "id, operator_id, display_name, status, created_at";

const toOperator = (r: OperatorRow): Operator => ({
  id: r.id as OperatorId,
  kind: r.kind as OperatorKind,
  displayName: r.display_name,
  status: r.status as OperatorStatus,
  contributionAllowListed: r.contribution_allow_listed === 1,
  createdAt: r.created_at,
});
const toAgent = (r: AgentRow): Agent => ({
  id: r.id as AgentId,
  operatorId: r.operator_id as OperatorId,
  displayName: r.display_name,
  status: r.status as AgentStatus,
  createdAt: r.created_at,
});

function checkDisplayName(value: unknown): string {
  if (typeof value !== "string")
    throw new IdentityError("invalid_input", "displayName must be a string");
  const name = value.trim();
  if (name.length < 1 || name.length > 200) {
    throw new IdentityError("invalid_input", "displayName must be 1-200 characters");
  }
  return name;
}

function checkProfile(update: unknown): string {
  if (typeof update !== "object" || update === null || Array.isArray(update)) {
    throw new IdentityError("invalid_input", "profile update must be an object");
  }
  for (const key of Object.keys(update)) {
    if (!MUTABLE_PROFILE_FIELDS.has(key)) {
      throw new IdentityError("immutable_field", `field is not mutable: ${key}`);
    }
  }
  return checkDisplayName((update as { displayName?: unknown }).displayName);
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message);

export class IdentityRepository {
  private readonly db: D1Database;
  private readonly platform: IdentityPlatform;

  constructor(db: D1Database, platform: Partial<IdentityPlatform> = {}) {
    this.db = db;
    this.platform = { ...defaultPlatform, ...platform };
  }

  async createOperator(input: NewOperator): Promise<Operator> {
    if (!KINDS.includes(input?.kind))
      throw new IdentityError("invalid_input", "invalid operator kind");
    const displayName = checkDisplayName(input.displayName);
    const id = this.platform.newId("op");
    const createdAt = this.platform.now().toISOString();
    try {
      await this.db
        .prepare(
          "INSERT INTO operators (id, kind, display_name, status, contribution_allow_listed, created_at) VALUES (?, ?, ?, 'active', 0, ?)",
        )
        .bind(id, input.kind, displayName, createdAt)
        .run();
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new IdentityError("duplicate_identity", "operator id already exists", {
          operatorId: id,
        });
      }
      throw e;
    }
    return this.requireOperator(id as OperatorId);
  }

  async getOperator(id: OperatorId): Promise<Operator | undefined> {
    const row = await this.db
      .prepare(`SELECT ${OPERATOR_COLS} FROM operators WHERE id = ?`)
      .bind(id)
      .first<OperatorRow>();
    return row ? toOperator(row) : undefined;
  }

  async getAgent(id: AgentId): Promise<Agent | undefined> {
    const row = await this.db
      .prepare(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`)
      .bind(id)
      .first<AgentRow>();
    return row ? toAgent(row) : undefined;
  }

  /** Register an agent under exactly one active operator; the binding is permanent. */
  async registerAgent(operatorId: OperatorId, input: NewAgent): Promise<Agent> {
    const displayName = checkDisplayName(input?.displayName);
    const id = this.platform.newId("ag");
    const createdAt = this.platform.now().toISOString();
    let changes: number;
    try {
      // Insert only if the operator exists and is active, atomically.
      const res = await this.db
        .prepare(
          "INSERT INTO agents (id, operator_id, display_name, status, created_at) SELECT ?, id, ?, 'active', ? FROM operators WHERE id = ? AND status = 'active'",
        )
        .bind(id, displayName, createdAt, operatorId)
        .run();
      changes = res.meta.changes;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new IdentityError("duplicate_identity", "agent id already exists", {
          agentId: id,
          operatorId,
        });
      }
      throw e;
    }
    if (changes === 0) {
      await this.requireActiveOperator(operatorId);
      throw new IdentityError("invalid_state_transition", "agent could not be registered", {
        operatorId,
      });
    }
    return this.requireAgent(id as AgentId);
  }

  /** Resolve an agent to its single operator, regardless of status. */
  async resolveAgent(agentId: AgentId): Promise<ResolvedAgent> {
    const agent = await this.requireAgent(agentId);
    const operator = await this.requireOperator(agent.operatorId);
    return { agent, operator };
  }

  /** Resolve an acting identity; rejects revoked agents and suspended operators. */
  async resolveActiveActor(agentId: AgentId): Promise<ActorRef> {
    const { agent, operator } = await this.resolveAgent(agentId);
    assertActive(agent, operator);
    return { agentId: agent.id, operatorId: operator.id };
  }

  async updateOperatorProfile(id: OperatorId, update: ProfileUpdate): Promise<Operator> {
    const displayName = checkProfile(update);
    const res = await this.db
      .prepare("UPDATE operators SET display_name = ? WHERE id = ? AND status = 'active'")
      .bind(displayName, id)
      .run();
    if (res.meta.changes === 0) await this.requireActiveOperator(id);
    return this.requireOperator(id);
  }

  async updateAgentProfile(id: AgentId, update: ProfileUpdate): Promise<Agent> {
    const displayName = checkProfile(update);
    const res = await this.db
      .prepare(
        "UPDATE agents SET display_name = ? WHERE id = ? AND status = 'active' AND operator_id IN (SELECT id FROM operators WHERE status = 'active')",
      )
      .bind(displayName, id)
      .run();
    if (res.meta.changes === 0) await this.resolveActiveActor(id);
    return this.requireAgent(id);
  }

  /** active -> suspended. One-way in this task; there is no reactivation. */
  async suspendOperator(id: OperatorId): Promise<Operator> {
    const res = await this.db
      .prepare("UPDATE operators SET status = 'suspended' WHERE id = ? AND status = 'active'")
      .bind(id)
      .run();
    if (res.meta.changes === 0) {
      const op = await this.requireOperator(id);
      throw new IdentityError("invalid_state_transition", `operator is already ${op.status}`, {
        operatorId: id,
      });
    }
    return this.requireOperator(id);
  }

  /** active -> revoked. One-way; the agent row is kept for provenance. */
  async revokeAgent(id: AgentId): Promise<Agent> {
    const res = await this.db
      .prepare("UPDATE agents SET status = 'revoked' WHERE id = ? AND status = 'active'")
      .bind(id)
      .run();
    if (res.meta.changes === 0) {
      const agent = await this.requireAgent(id);
      throw new IdentityError("invalid_state_transition", `agent is already ${agent.status}`, {
        agentId: id,
      });
    }
    return this.requireAgent(id);
  }

  private async requireOperator(id: OperatorId): Promise<Operator> {
    const op = await this.getOperator(id);
    if (!op) throw new IdentityError("not_found", "operator not found", { operatorId: id });
    return op;
  }

  private async requireAgent(id: AgentId): Promise<Agent> {
    const agent = await this.getAgent(id);
    if (!agent) throw new IdentityError("not_found", "agent not found", { agentId: id });
    return agent;
  }

  private async requireActiveOperator(id: OperatorId): Promise<Operator> {
    const op = await this.requireOperator(id);
    if (op.status !== "active") {
      throw new IdentityError("operator_suspended", "operator is suspended", { operatorId: id });
    }
    return op;
  }
}

function assertActive(agent: Agent, operator: Operator): void {
  if (operator.status !== "active") {
    throw new IdentityError("operator_suspended", "operator is suspended", {
      operatorId: operator.id,
      agentId: agent.id,
    });
  }
  if (agent.status !== "active") {
    throw new IdentityError("agent_revoked", "agent is revoked", {
      operatorId: operator.id,
      agentId: agent.id,
    });
  }
}
