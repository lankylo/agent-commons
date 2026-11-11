import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRepository } from "../../src/identity/repository";
import {
  CredentialError,
  CredentialService,
  type CredentialEnv,
  type CredentialId,
} from "../../src/identity/credentials";

let proxy: PlatformProxy<CredentialEnv>;
let dir: string;
let db: D1Database;
let repo: IdentityRepository;
let svc: CredentialService;
let clock = new Date("2026-06-01T00:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "d1-credentials-"));
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
  proxy = await getPlatformProxy<CredentialEnv>({
    configPath: "wrangler.d1-local.jsonc",
    persist: { path: join(dir, "v3") },
  });
  db = proxy.env.DB;
  repo = new IdentityRepository(db);
  svc = new CredentialService(db, { now: () => clock });
}, 120_000);
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function actor() {
  const op = await repo.createOperator({ kind: "organization", displayName: "Acme" });
  const agent = await repo.registerAgent(op.id, { displayName: "Bot" });
  return { op, agent };
}
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    if (e instanceof CredentialError) return e.code;
    throw e;
  }
}
const secretOf = (token: string) => token.split("_")[2]!;

describe("issuance", () => {
  it("returns an opaque token once with non-secret metadata", async () => {
    const { agent } = await actor();
    const { token, credential } = await svc.issueCredential(agent.id, { label: " ci key " });
    expect(token).toMatch(/^ac1_[0-9a-f]{24}_[0-9a-f]{64}$/);
    expect(token).toContain(credential.id);
    expect(credential).toMatchObject({
      agentId: agent.id,
      label: "ci key",
      expiresAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(credential)).not.toContain(secretOf(token));
    const other = await svc.issueCredential(agent.id, { label: "b" });
    expect(other.token).not.toBe(token);
    expect(secretOf(other.token)).not.toBe(secretOf(token));
  });

  it("rejects bad labels and expiries", async () => {
    const { agent } = await actor();
    expect(await code(svc.issueCredential(agent.id, { label: "" }))).toBe("invalid_input");
    expect(await code(svc.issueCredential(agent.id, { label: "x".repeat(101) }))).toBe(
      "invalid_input",
    );
    expect(await code(svc.issueCredential(agent.id, { label: "a\nb" }))).toBe("invalid_input");
    expect(await code(svc.issueCredential(agent.id, { label: 5 as never }))).toBe("invalid_input");
    expect(await code(svc.issueCredential(agent.id, { label: "a", expiresAt: clock }))).toBe(
      "invalid_input",
    );
    expect(
      await code(svc.issueCredential(agent.id, { label: "a", expiresAt: new Date("nope") })),
    ).toBe("invalid_input");
  });

  it("refuses unknown, revoked and suspended-operator agents", async () => {
    const a = await actor();
    expect(await code(svc.issueCredential("ag_missing0001" as never, { label: "a" }))).toBe(
      "not_found",
    );
    await repo.revokeAgent(a.agent.id);
    expect(await code(svc.issueCredential(a.agent.id, { label: "a" }))).toBe("agent_revoked");
    const b = await actor();
    await repo.suspendOperator(b.op.id);
    expect(await code(svc.issueCredential(b.agent.id, { label: "a" }))).toBe("operator_suspended");
  });
});

describe("storage", () => {
  it("stores only a digest, never the token or secret", async () => {
    const { agent } = await actor();
    const { token, credential } = await svc.issueCredential(agent.id, { label: "k" });
    const secret = secretOf(token);
    const row = await db
      .prepare("SELECT * FROM agent_credentials WHERE id = ?")
      .bind(credential.id)
      .first<Record<string, string>>();
    expect(row!.secret_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secret_digest).not.toBe(secret);
    const dump = await db.prepare("SELECT * FROM agent_credentials").all();
    const text = JSON.stringify(dump.results);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token);
  });

  it("makes fields immutable, revocation permanent and rows undeletable", async () => {
    const { agent } = await actor();
    const { credential } = await svc.issueCredential(agent.id, { label: "k" });
    await expect(
      db
        .prepare("UPDATE agent_credentials SET secret_digest = ? WHERE id = ?")
        .bind("0".repeat(64), credential.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .prepare("UPDATE agent_credentials SET expires_at = NULL WHERE id = ?")
        .bind(credential.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await svc.revokeCredential(credential.id);
    await expect(
      db
        .prepare("UPDATE agent_credentials SET revoked_at = NULL WHERE id = ?")
        .bind(credential.id)
        .run(),
    ).rejects.toThrow(/permanent/);
    await expect(
      db.prepare("DELETE FROM agent_credentials WHERE id = ?").bind(credential.id).run(),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

describe("verification", () => {
  it("accepts a valid token and resolves agent and operator", async () => {
    const { op, agent } = await actor();
    const { token, credential } = await svc.issueCredential(agent.id, { label: "k" });
    expect(await svc.verifyCredential(token)).toEqual({
      ok: true,
      agentId: agent.id,
      operatorId: op.id,
      credentialId: credential.id,
    });
  });

  it("rejects malformed tokens without touching the database", async () => {
    const { agent } = await actor();
    const { token } = await svc.issueCredential(agent.id, { label: "k" });
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      "garbage",
      token.toUpperCase(),
      token.slice(0, -1),
      `${token}0`,
      ` ${token}`,
      `${token}\n`,
      token.replace("ac1_", "ac2_"),
      token.replace(/_/g, "-"),
      `ac1_${"g".repeat(24)}_${"a".repeat(64)}`,
    ];
    for (const t of bad)
      expect(await svc.verifyCredential(t)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects unknown ids and wrong secrets identically", async () => {
    const { agent } = await actor();
    const { token, credential } = await svc.issueCredential(agent.id, { label: "k" });
    const wrongSecret = `ac1_${credential.id}_${"0".repeat(64)}`;
    const unknownId = `ac1_${"1".repeat(24)}_${secretOf(token)}`;
    expect(await svc.verifyCredential(wrongSecret)).toEqual({ ok: false, reason: "unknown" });
    expect(await svc.verifyCredential(unknownId)).toEqual({ ok: false, reason: "unknown" });
  });

  it("supports overlapping rotation and revoking only the old credential", async () => {
    const { agent } = await actor();
    const oldC = await svc.issueCredential(agent.id, { label: "old" });
    const newC = await svc.issueCredential(agent.id, { label: "new" });
    expect((await svc.verifyCredential(oldC.token)).ok).toBe(true);
    expect((await svc.verifyCredential(newC.token)).ok).toBe(true);
    await svc.revokeCredential(oldC.credential.id);
    expect(await svc.verifyCredential(oldC.token)).toEqual({ ok: false, reason: "revoked" });
    expect((await svc.verifyCredential(newC.token)).ok).toBe(true);
  });

  it("revocation is idempotent, keeps the first timestamp and validates ids", async () => {
    const { agent } = await actor();
    const { credential } = await svc.issueCredential(agent.id, { label: "k" });
    const first = await svc.revokeCredential(credential.id);
    clock = new Date("2026-06-02T00:00:00.000Z");
    const second = await svc.revokeCredential(credential.id);
    expect(second.revokedAt).toBe(first.revokedAt);
    expect(await code(svc.revokeCredential("1".repeat(24) as CredentialId))).toBe("not_found");
    expect(await code(svc.revokeCredential("nope" as CredentialId))).toBe("invalid_input");
    clock = new Date("2026-06-01T00:00:00.000Z");
  });

  it("rejects expired credentials at and after expiry", async () => {
    const { agent } = await actor();
    const expiresAt = new Date("2026-06-01T01:00:00.000Z");
    const { token } = await svc.issueCredential(agent.id, { label: "k", expiresAt });
    expect((await svc.verifyCredential(token)).ok).toBe(true);
    clock = new Date("2026-06-01T00:59:59.999Z");
    expect((await svc.verifyCredential(token)).ok).toBe(true);
    clock = expiresAt;
    expect(await svc.verifyCredential(token)).toEqual({ ok: false, reason: "expired" });
    clock = new Date("2026-06-01T00:00:00.000Z");
  });

  it("rejects credentials of revoked agents, keeping other agents working", async () => {
    const { op, agent } = await actor();
    const sibling = await repo.registerAgent(op.id, { displayName: "Other" });
    const a = await svc.issueCredential(agent.id, { label: "k" });
    const s = await svc.issueCredential(sibling.id, { label: "k" });
    await repo.revokeAgent(agent.id);
    expect(await svc.verifyCredential(a.token)).toEqual({ ok: false, reason: "agent_revoked" });
    expect((await svc.verifyCredential(s.token)).ok).toBe(true);
    // Revoking a credential of a revoked agent is still possible.
    expect((await svc.revokeCredential(a.credential.id)).revokedAt).not.toBeNull();
  });

  it("rejects credentials of suspended operators", async () => {
    const { op, agent } = await actor();
    const { token } = await svc.issueCredential(agent.id, { label: "k" });
    await repo.suspendOperator(op.id);
    expect(await svc.verifyCredential(token)).toEqual({ ok: false, reason: "operator_suspended" });
  });
});
