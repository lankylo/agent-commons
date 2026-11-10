/**
 * Identity model (design-only; no storage, credentials or APIs).
 *
 * An Operator is the accountable human or organization. An Agent identity is
 * bound to exactly one Operator for its whole life. Agents never hold money or
 * accountability; spending limits and (later) credits belong to the Operator.
 */

export type OperatorId = string & { readonly __brand: "OperatorId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export type OperatorKind = "individual" | "organization";
export type OperatorStatus = "active" | "suspended";
export type AgentStatus = "active" | "revoked";

export interface Operator {
  readonly id: OperatorId;
  readonly kind: OperatorKind;
  readonly displayName: string;
  readonly status: OperatorStatus;
  /** Contribution is allow-listed until Phase 5 is accepted. */
  readonly contributionAllowListed: boolean;
  readonly createdAt: string; // ISO 8601 UTC
}

export interface Agent {
  readonly id: AgentId;
  /** Required and immutable: every agent resolves to exactly one operator. */
  readonly operatorId: OperatorId;
  readonly displayName: string;
  readonly status: AgentStatus;
  readonly createdAt: string; // ISO 8601 UTC
}

/** Who is acting; carried on every contribution and (later) feedback/purchase. */
export interface ActorRef {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
}

/**
 * Resolve an agent to its single operator. Returns undefined if the agent or
 * its operator is unknown, so callers cannot act for an unbound agent.
 */
export function resolveActor(
  agentId: AgentId,
  agents: ReadonlyMap<AgentId, Agent>,
  operators: ReadonlyMap<OperatorId, Operator>,
): ActorRef | undefined {
  const agent = agents.get(agentId);
  if (!agent || !operators.has(agent.operatorId)) return undefined;
  return { agentId: agent.id, operatorId: agent.operatorId };
}

/** True when two actors share an operator (self-rating / Sybil checks). */
export function sameOperator(a: ActorRef, b: ActorRef): boolean {
  return a.operatorId === b.operatorId;
}
