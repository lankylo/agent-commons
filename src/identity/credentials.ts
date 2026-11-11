/**
 * D1-backed agent credentials: issuance, verification and revocation.
 *
 * Token: `ac1_<24 hex public id>_<64 hex secret>` (secret = 32 random bytes). The secret is
 * high-entropy, so a domain-separated SHA-256 digest suffices; only the digest is stored and
 * the full token is returned once, at issuance. Secrets are never logged or put in errors.
 * No HTTP authentication, rate limiting or spending limits live here.
 */
import type { AgentId, OperatorId } from "./types";

export type CredentialErrorCode =
  "invalid_input" | "not_found" | "agent_revoked" | "operator_suspended";

export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface CredentialEnv {
  DB: D1Database;
}

export interface CredentialPlatform {
  readonly now: () => Date;
}
const defaultPlatform: CredentialPlatform = { now: () => new Date() };

export type CredentialId = string & { readonly __brand: "CredentialId" };

/** Non-secret credential metadata. */
export interface CredentialRecord {
  readonly id: CredentialId;
  readonly agentId: AgentId;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface IssuedCredential {
  /** The complete token. Shown only once; it cannot be recovered later. */
  readonly token: string;
  readonly credential: CredentialRecord;
}

export interface NewCredential {
  readonly label: string;
  /** Optional expiry; must be in the future. */
  readonly expiresAt?: Date;
}

export type VerificationFailure =
  "malformed" | "unknown" | "expired" | "revoked" | "agent_revoked" | "operator_suspended";

export type VerificationResult =
  | {
      readonly ok: true;
      readonly agentId: AgentId;
      readonly operatorId: OperatorId;
      readonly credentialId: CredentialId;
    }
  | { readonly ok: false; readonly reason: VerificationFailure };

const TOKEN_RE = /^ac1_([0-9a-f]{24})_([0-9a-f]{64})$/;
const DIGEST_DOMAIN = "agent-commons/credential/v1:";
const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function digestSecret(secretHex: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(DIGEST_DOMAIN + secretHex)),
  );
}

/** Constant-time comparison of two equal-purpose digests (no early exit on content). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// Digest compared against when the credential id is unknown, so lookups cost the same.
const DUMMY_DIGEST = new Uint8Array(32);

interface CredentialRow {
  id: string;
  agent_id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}
const COLS = "id, agent_id, label, created_at, expires_at, revoked_at";
const toRecord = (r: CredentialRow): CredentialRecord => ({
  id: r.id as CredentialId,
  agentId: r.agent_id as AgentId,
  label: r.label,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

function checkLabel(value: unknown): string {
  if (typeof value !== "string")
    throw new CredentialError("invalid_input", "label must be a string");
  const label = value.trim();
  // eslint-disable-next-line no-control-regex
  if (label.length < 1 || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new CredentialError("invalid_input", "label must be 1-100 printable characters");
  }
  return label;
}

export class CredentialService {
  private readonly db: D1Database;
  private readonly platform: CredentialPlatform;

  constructor(db: D1Database, platform: Partial<CredentialPlatform> = {}) {
    this.db = db;
    this.platform = { ...defaultPlatform, ...platform };
  }

  /** Issue a credential for an active agent of an active operator. */
  async issueCredential(agentId: AgentId, input: NewCredential): Promise<IssuedCredential> {
    const label = checkLabel(input?.label);
    const now = this.platform.now();
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined) {
      if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
        throw new CredentialError("invalid_input", "expiresAt must be a valid Date");
      }
      if (input.expiresAt.getTime() <= now.getTime()) {
        throw new CredentialError("invalid_input", "expiresAt must be in the future");
      }
      expiresAt = input.expiresAt.toISOString();
    }

    const idBytes = crypto.getRandomValues(new Uint8Array(12));
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const id = toHex(idBytes);
    const secret = toHex(secretBytes);
    const digest = toHex(await digestSecret(secret));

    const res = await this.db
      .prepare(
        `INSERT INTO agent_credentials (id, agent_id, label, secret_digest, created_at, expires_at)
         SELECT ?, a.id, ?, ?, ?, ? FROM agents a JOIN operators o ON o.id = a.operator_id
         WHERE a.id = ? AND a.status = 'active' AND o.status = 'active'`,
      )
      .bind(id, label, digest, now.toISOString(), expiresAt, agentId)
      .run();
    if (res.meta.changes === 0) await this.explainIssueFailure(agentId);

    const credential = await this.requireCredential(id as CredentialId);
    return { token: `ac1_${id}_${secret}`, credential };
  }

  /** Verify a presented token. Never throws for bad credentials; returns a reason instead. */
  async verifyCredential(token: unknown): Promise<VerificationResult> {
    const match = typeof token === "string" ? TOKEN_RE.exec(token) : null;
    if (!match) return { ok: false, reason: "malformed" };
    const [, id, secret] = match as unknown as [string, string, string];

    const row = await this.db
      .prepare(
        `SELECT c.agent_id, c.secret_digest, c.expires_at, c.revoked_at,
                a.status AS agent_status, a.operator_id, o.status AS operator_status
         FROM agent_credentials c
         JOIN agents a ON a.id = c.agent_id
         JOIN operators o ON o.id = a.operator_id
         WHERE c.id = ?`,
      )
      .bind(id)
      .first<{
        agent_id: string;
        secret_digest: string;
        expires_at: string | null;
        revoked_at: string | null;
        agent_status: string;
        operator_id: string;
        operator_status: string;
      }>();

    const presented = await digestSecret(secret);
    const stored = row ? hexToBytes(row.secret_digest) : DUMMY_DIGEST;
    const matches = timingSafeEqual(presented, stored);
    // Unknown id and wrong secret are indistinguishable to the caller.
    if (!row || !matches) return { ok: false, reason: "unknown" };

    if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (row.expires_at !== null && Date.parse(row.expires_at) <= this.platform.now().getTime()) {
      return { ok: false, reason: "expired" };
    }
    if (row.agent_status !== "active") return { ok: false, reason: "agent_revoked" };
    if (row.operator_status !== "active") return { ok: false, reason: "operator_suspended" };
    return {
      ok: true,
      agentId: row.agent_id as AgentId,
      operatorId: row.operator_id as OperatorId,
      credentialId: id as CredentialId,
    };
  }

  /** Permanently revoke one credential. Idempotent: the first revocation time is kept. */
  async revokeCredential(id: CredentialId): Promise<CredentialRecord> {
    if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) {
      throw new CredentialError("invalid_input", "invalid credential id");
    }
    await this.db
      .prepare("UPDATE agent_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(this.platform.now().toISOString(), id)
      .run();
    return this.requireCredential(id);
  }

  async getCredential(id: CredentialId): Promise<CredentialRecord | undefined> {
    const row = await this.db
      .prepare(`SELECT ${COLS} FROM agent_credentials WHERE id = ?`)
      .bind(id)
      .first<CredentialRow>();
    return row ? toRecord(row) : undefined;
  }

  private async requireCredential(id: CredentialId): Promise<CredentialRecord> {
    const rec = await this.getCredential(id);
    if (!rec) throw new CredentialError("not_found", "credential not found");
    return rec;
  }

  private async explainIssueFailure(agentId: AgentId): Promise<never> {
    const row = await this.db
      .prepare(
        "SELECT a.status AS agent_status, o.status AS operator_status FROM agents a JOIN operators o ON o.id = a.operator_id WHERE a.id = ?",
      )
      .bind(agentId)
      .first<{ agent_status: string; operator_status: string }>();
    if (!row) throw new CredentialError("not_found", "agent not found");
    if (row.agent_status !== "active")
      throw new CredentialError("agent_revoked", "agent is revoked");
    throw new CredentialError("operator_suspended", "operator is suspended");
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
