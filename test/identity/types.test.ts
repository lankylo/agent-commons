import { describe, expect, it } from "vitest";
import {
  resolveActor,
  sameOperator,
  type Agent,
  type AgentId,
  type Operator,
  type OperatorId,
} from "../../src/identity/types";

const op = (id: string): Operator => ({
  id: id as OperatorId,
  kind: "organization",
  displayName: id,
  status: "active",
  contributionAllowListed: false,
  createdAt: "2026-11-10T00:00:00Z",
});
const ag = (id: string, operatorId: string): Agent => ({
  id: id as AgentId,
  operatorId: operatorId as OperatorId,
  displayName: id,
  status: "active",
  createdAt: "2026-11-10T00:00:00Z",
});

describe("identity", () => {
  const operators = new Map([[op("o1").id, op("o1")]]);
  const agents = new Map<AgentId, Agent>([
    [ag("a1", "o1").id, ag("a1", "o1")],
    [ag("a2", "o1").id, ag("a2", "o1")],
    [ag("orphan", "missing").id, ag("orphan", "missing")],
  ]);

  it("resolves an agent to exactly one operator", () => {
    expect(resolveActor("a1" as AgentId, agents, operators)).toEqual({
      agentId: "a1",
      operatorId: "o1",
    });
  });

  it("refuses unknown agents and agents with unknown operators", () => {
    expect(resolveActor("nope" as AgentId, agents, operators)).toBeUndefined();
    expect(resolveActor("orphan" as AgentId, agents, operators)).toBeUndefined();
  });

  it("detects agents sharing an operator", () => {
    const a = resolveActor("a1" as AgentId, agents, operators)!;
    const b = resolveActor("a2" as AgentId, agents, operators)!;
    expect(sameOperator(a, b)).toBe(true);
    expect(sameOperator(a, { ...b, operatorId: "o2" as OperatorId })).toBe(false);
  });
});
