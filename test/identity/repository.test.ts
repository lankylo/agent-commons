import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IdentityError,
  IdentityRepository,
  type IdentityEnv,
  type IdentityErrorCode,
} from "../../src/identity/repository";
import type { AgentId, OperatorId } from "../../src/identity/types";

// Local D1 emulation (Miniflare) with the real migration and throwaway persistence.
let proxy: PlatformProxy<IdentityEnv>;
let dir: string;
let db: D1Database;
let repo: IdentityRepository;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "d1-identity-"));
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.d1-local.jsonc",
      "--persist-to",
      dir,
    ],
    { stdio: "pipe" },
  );
  proxy = await getPlatformProxy<IdentityEnv>({
    configPath: "wrangler.d1-local.jsonc",
    persist: { path: join(dir, "v3") },
  });
  db = proxy.env.DB;
  repo = new IdentityRepository(db);
}, 120_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function code(p: Promise<unknown>): Promise<IdentityErrorCode | "no error"> {
  try {
    await p;
    return "no error";
  } catch (e) {
    if (e instanceof IdentityError) return e.code;
    throw e;
  }
}

const newOp = () => repo.createOperator({ kind: "organization", displayName: "Acme" });

describe("creation and resolution", () => {
  it("creates an operator with platform-assigned fields", async () => {
    const op = await repo.createOperator({ kind: "individual", displayName: "  Ada  " });
    expect(op.id).toMatch(/^op_[0-9a-f]{32}$/);
    expect(op).toMatchObject({
      kind: "individual",
      displayName: "Ada",
      status: "active",
      contributionAllowListed: false,
    });
    expect(op.createdAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(await repo.getOperator(op.id)).toEqual(op);
    expect(await repo.getOperator("op_missing000" as OperatorId)).toBeUndefined();
  });

  it("registers an agent under one operator and resolves it back", async () => {
    const op = await newOp();
    const agent = await repo.registerAgent(op.id, { displayName: "Bot" });
    expect(agent.id).toMatch(/^ag_[0-9a-f]{32}$/);
    expect(agent).toMatchObject({ operatorId: op.id, status: "active", displayName: "Bot" });
    expect(await repo.getAgent(agent.id)).toEqual(agent);
    expect(await repo.resolveAgent(agent.id)).toEqual({ agent, operator: op });
    expect(await repo.resolveActiveActor(agent.id)).toEqual({
      agentId: agent.id,
      operatorId: op.id,
    });
  });

  it("uses platform timestamps and ids, ignoring caller-supplied identity fields", async () => {
    const fixed = new IdentityRepository(db, {
      now: () => new Date("2026-01-02T03:04:05.678Z"),
      newId: (p) => `${p}_fixedid0001`,
    });
    const op = await fixed.createOperator({
      kind: "organization",
      displayName: "Fixed",
      id: "op_attacker1",
      status: "suspended",
      contributionAllowListed: true,
      createdAt: "1999-01-01T00:00:00Z",
    } as never);
    expect(op).toMatchObject({
      id: "op_fixedid0001",
      status: "active",
      contributionAllowListed: false,
      createdAt: "2026-01-02T03:04:05.678Z",
    });
  });

  it("rejects invalid input", async () => {
    expect(await code(repo.createOperator({ kind: "bot" as never, displayName: "x" }))).toBe(
      "invalid_input",
    );
    expect(await code(repo.createOperator({ kind: "individual", displayName: "   " }))).toBe(
      "invalid_input",
    );
    expect(
      await code(repo.createOperator({ kind: "individual", displayName: "x".repeat(201) })),
    ).toBe("invalid_input");
    const op = await newOp();
    expect(await code(repo.registerAgent(op.id, { displayName: 5 as never }))).toBe(
      "invalid_input",
    );
  });

  it("treats SQL metacharacters as data", async () => {
    const op = await repo.createOperator({
      kind: "individual",
      displayName: "x'); DROP TABLE operators;--",
    });
    expect((await repo.getOperator(op.id))?.displayName).toBe("x'); DROP TABLE operators;--");
    expect(await repo.getOperator("' OR 1=1 --" as OperatorId)).toBeUndefined();
  });
});

describe("duplicates and missing records", () => {
  it("rejects a duplicate operator id and a duplicate agent id", async () => {
    const dup = new IdentityRepository(db, { newId: (p) => `${p}_duplicate01` });
    const op = await dup.createOperator({ kind: "individual", displayName: "Dup" });
    expect(await code(dup.createOperator({ kind: "individual", displayName: "Dup2" }))).toBe(
      "duplicate_identity",
    );
    await dup.registerAgent(op.id, { displayName: "A" });
    expect(await code(dup.registerAgent(op.id, { displayName: "B" }))).toBe("duplicate_identity");
    expect((await dup.getOperator(op.id))?.displayName).toBe("Dup");
  });

  it("reports missing operators and agents", async () => {
    const ghostOp = "op_ghost00001" as OperatorId;
    const ghostAgent = "ag_ghost00001" as AgentId;
    expect(await code(repo.registerAgent(ghostOp, { displayName: "A" }))).toBe("not_found");
    expect(await code(repo.resolveAgent(ghostAgent))).toBe("not_found");
    expect(await code(repo.resolveActiveActor(ghostAgent))).toBe("not_found");
    expect(await code(repo.updateOperatorProfile(ghostOp, { displayName: "n" }))).toBe("not_found");
    expect(await code(repo.updateAgentProfile(ghostAgent, { displayName: "n" }))).toBe("not_found");
    expect(await code(repo.suspendOperator(ghostOp))).toBe("not_found");
    expect(await code(repo.revokeAgent(ghostAgent))).toBe("not_found");
  });
});

describe("exactly one operator and immutable bindings", () => {
  it("does not store an agent without a valid operator", async () => {
    const sql =
      "INSERT INTO agents (id, operator_id, display_name, created_at) VALUES (?, ?, 'x', ?)";
    const ts = "2026-11-11T00:00:00Z";
    await expect(
      db.prepare(sql).bind("ag_orphan0001", "op_nonexist01", ts).run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO agents (id, display_name, created_at) VALUES ('ag_orphan0002', 'x', ?)",
        )
        .bind(ts)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects re-parenting and immutable-field changes at the service and schema layers", async () => {
    const a = await newOp();
    const b = await newOp();
    const agent = await repo.registerAgent(a.id, { displayName: "Bot" });
    for (const field of ["operatorId", "id", "createdAt", "status", "contributionAllowListed"]) {
      expect(await code(repo.updateAgentProfile(agent.id, { [field]: "x" } as never))).toBe(
        "immutable_field",
      );
      expect(await code(repo.updateOperatorProfile(a.id, { [field]: "x" } as never))).toBe(
        "immutable_field",
      );
    }
    // Direct SQL cannot re-parent or alter identity keys either (migration triggers).
    await expect(
      db.prepare("UPDATE agents SET operator_id = ? WHERE id = ?").bind(b.id, agent.id).run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.prepare("UPDATE agents SET id = 'ag_renamed001' WHERE id = ?").bind(agent.id).run(),
    ).rejects.toThrow(/immutable/);
    expect((await repo.resolveAgent(agent.id)).operator.id).toBe(a.id);
    expect(await repo.getAgent(agent.id)).toEqual(agent);
  });

  it("updates only the permitted profile fields", async () => {
    const op = await newOp();
    const agent = await repo.registerAgent(op.id, { displayName: "Bot" });
    const op2 = await repo.updateOperatorProfile(op.id, { displayName: "Acme 2" });
    const ag2 = await repo.updateAgentProfile(agent.id, { displayName: "Bot 2" });
    expect(op2).toEqual({ ...op, displayName: "Acme 2" });
    expect(ag2).toEqual({ ...agent, displayName: "Bot 2" });
    expect(await code(repo.updateAgentProfile(agent.id, { displayName: "" }))).toBe(
      "invalid_input",
    );
  });

  it("preserves the contribution allow-list flag across lifecycle changes", async () => {
    const op = await newOp();
    await db
      .prepare("UPDATE operators SET contribution_allow_listed = 1 WHERE id = ?")
      .bind(op.id)
      .run();
    await repo.updateOperatorProfile(op.id, { displayName: "Listed" });
    expect((await repo.getOperator(op.id))?.contributionAllowListed).toBe(true);
    const suspended = await repo.suspendOperator(op.id);
    expect(suspended).toMatchObject({ status: "suspended", contributionAllowListed: true });
  });
});

describe("suspension, revocation and inactive actors", () => {
  it("suspends an operator once and rejects further transitions", async () => {
    const op = await newOp();
    const suspended = await repo.suspendOperator(op.id);
    expect(suspended).toEqual({ ...op, status: "suspended" });
    expect(await code(repo.suspendOperator(op.id))).toBe("invalid_state_transition");
  });

  it("rejects work for suspended operators", async () => {
    const op = await newOp();
    const agent = await repo.registerAgent(op.id, { displayName: "Bot" });
    await repo.suspendOperator(op.id);
    expect(await code(repo.registerAgent(op.id, { displayName: "More" }))).toBe(
      "operator_suspended",
    );
    expect(await code(repo.updateOperatorProfile(op.id, { displayName: "n" }))).toBe(
      "operator_suspended",
    );
    expect(await code(repo.updateAgentProfile(agent.id, { displayName: "n" }))).toBe(
      "operator_suspended",
    );
    expect(await code(repo.resolveActiveActor(agent.id))).toBe("operator_suspended");
    // Plain resolution still works so provenance stays readable.
    expect((await repo.resolveAgent(agent.id)).agent.id).toBe(agent.id);
    const rows = await db
      .prepare("SELECT COUNT(*) AS c FROM agents WHERE operator_id = ?")
      .bind(op.id)
      .first<{ c: number }>();
    expect(rows?.c).toBe(1);
  });

  it("revokes an agent once, keeps the row and rejects it as an actor", async () => {
    const op = await newOp();
    const agent = await repo.registerAgent(op.id, { displayName: "Bot" });
    const other = await repo.registerAgent(op.id, { displayName: "Other" });
    const revoked = await repo.revokeAgent(agent.id);
    expect(revoked).toEqual({ ...agent, status: "revoked" });
    expect(await code(repo.revokeAgent(agent.id))).toBe("invalid_state_transition");
    expect(await code(repo.resolveActiveActor(agent.id))).toBe("agent_revoked");
    expect(await code(repo.updateAgentProfile(agent.id, { displayName: "n" }))).toBe(
      "agent_revoked",
    );
    expect((await repo.getAgent(agent.id))?.operatorId).toBe(op.id);
    // Sibling agents and the operator are unaffected.
    expect(await code(repo.resolveActiveActor(other.id))).toBe("no error");
    expect((await repo.getOperator(op.id))?.status).toBe("active");
  });

  it("allows revoking an agent whose operator is suspended", async () => {
    const op = await newOp();
    const agent = await repo.registerAgent(op.id, { displayName: "Bot" });
    await repo.suspendOperator(op.id);
    expect((await repo.revokeAgent(agent.id)).status).toBe("revoked");
    expect(await code(repo.resolveActiveActor(agent.id))).toBe("operator_suspended");
  });
});
