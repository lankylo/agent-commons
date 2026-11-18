/**
 * Open wallet-based enrollment for the unpaid pilot (headless REST, ERC-4361 / EOA only).
 *
 * Off unless `ENROLLMENT` is exactly "on"; when on, `ENROLLMENT_DOMAIN`, `ENROLLMENT_URI` and
 * `ENROLLMENT_CHAIN_ID` must be valid or every enrollment route fails closed (503).
 *
 * Flow: `POST /v1/enroll/challenge` returns a short-lived server-generated SIWE message with a
 * one-time nonce; the caller signs it with personal_sign and submits `{message, signature}` to
 * `/v1/enroll/complete` (first enrollment) or `/v1/enroll/rotate` (credential replacement).
 * The exact message (by digest), domain, URI, chain ID, purpose, timestamps and nonce are
 * checked and the nonce is consumed by one conditional UPDATE. Operator and agent IDs are
 * always platform-assigned; request bodies accept no identity fields. Issued credentials are
 * returned once with `Cache-Control: no-store` and never logged or placed in URLs.
 * Only public wallet addresses are stored: no private keys, seed phrases, signatures, GitHub
 * identity, payment credentials or KYC data. Smart-contract wallets (ERC-1271) are unsupported.
 * An enrolled wallet also signs its operator's spending controls (see `./spending.ts`).
 */
import { CredentialService } from "../identity/credentials";
import type { AgentId, OperatorId } from "../identity/types";
import { RateLimitService } from "../rate-limit";
import {
  CHALLENGE_PURPOSES,
  MAX_MESSAGE_BYTES,
  buildSiweMessage,
  normalizeAddress,
  parseSiweMessage,
  recoverPersonalSignAddress,
  type ChallengePurpose,
} from "./siwe";
import {
  handleSpendingChallenge,
  handleSpendingPolicy,
  handleSpendingSuspension,
} from "./spending";

export const ENROLL_PATH_PREFIX = "/v1/enroll/";

export const ENROLLMENT_DEFAULTS = {
  challengeTtlSeconds: 300,
  ipLimit: 20,
  addressLimit: 10,
  globalLimit: 600,
  windowSeconds: 60,
} as const;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 900;
const MAX_LIMIT = 100_000;
const MAX_BODY_BYTES = 4 * 1024;
const PURGE_AFTER_MS = 60 * 60 * 1000;

export interface EnrollmentEnv {
  readonly DB?: D1Database;
  readonly NOW?: () => Date;
  readonly ENROLLMENT?: string;
  readonly ENROLLMENT_DOMAIN?: string;
  readonly ENROLLMENT_URI?: string;
  readonly ENROLLMENT_CHAIN_ID?: number | string;
  readonly ENROLLMENT_CHALLENGE_TTL_SECONDS?: number | string;
  readonly ENROLLMENT_IP_LIMIT?: number | string;
  readonly ENROLLMENT_ADDRESS_LIMIT?: number | string;
  readonly ENROLLMENT_GLOBAL_LIMIT?: number | string;
}

export interface EnrollmentConfig {
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly ttlSeconds: number;
  readonly ipLimit: number;
  readonly addressLimit: number;
  readonly globalLimit: number;
}

const NO_STORE = { "Cache-Control": "no-store" };
export function reply(status: number, body: unknown, extra?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}
export function fail(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, string>,
) {
  return reply(status, { error: { code, message } }, extra);
}

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::[1-9][0-9]{0,4})?$`);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function boundedInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "string" && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Resolve configuration: `false` when disabled, the config when complete and valid, `null`
 * when enabled-but-invalid or an unknown switch value (fail closed).
 */
export function resolveEnrollmentConfig(env: EnrollmentEnv): EnrollmentConfig | false | null {
  const flag = env.ENROLLMENT;
  if (flag === undefined || flag === "" || flag === "off") return false;
  if (flag !== "on") return null;

  const domain = env.ENROLLMENT_DOMAIN;
  if (typeof domain !== "string" || domain.length > 253 || !DOMAIN_RE.test(domain)) return null;

  const uri = env.ENROLLMENT_URI;
  if (typeof uri !== "string" || uri.length > 512 || /\s/.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!secure || url.href !== uri || url.host !== domain) return null;
  if (url.username || url.password || url.hash || url.search) return null;

  const chainId = boundedInt(env.ENROLLMENT_CHAIN_ID, -1, 1, Number.MAX_SAFE_INTEGER);
  const ttlSeconds = boundedInt(
    env.ENROLLMENT_CHALLENGE_TTL_SECONDS,
    ENROLLMENT_DEFAULTS.challengeTtlSeconds,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
  );
  const ipLimit = boundedInt(env.ENROLLMENT_IP_LIMIT, ENROLLMENT_DEFAULTS.ipLimit, 1, MAX_LIMIT);
  const addressLimit = boundedInt(
    env.ENROLLMENT_ADDRESS_LIMIT,
    ENROLLMENT_DEFAULTS.addressLimit,
    1,
    MAX_LIMIT,
  );
  const globalLimit = boundedInt(
    env.ENROLLMENT_GLOBAL_LIMIT,
    ENROLLMENT_DEFAULTS.globalLimit,
    1,
    MAX_LIMIT,
  );
  if (
    chainId === null ||
    chainId < 1 ||
    ttlSeconds === null ||
    ipLimit === null ||
    addressLimit === null ||
    globalLimit === null
  ) {
    return null;
  }
  return { domain, uri, chainId, ttlSeconds, ipLimit, addressLimit, globalLimit };
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

export async function readBody(
  request: Request,
  fields: readonly string[],
): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES)
    return fail(413, "payload_too_large", "Request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "Request body is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(400, "invalid_request", "Request body must be a JSON object.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(400, "invalid_request", "Request body must be a JSON object.");
  }
  const unknown = Object.keys(value).filter((k) => !fields.includes(k));
  if (unknown.length > 0) {
    // Identity is always platform-assigned; operator/agent IDs are never accepted.
    return fail(400, "invalid_request", `Only these fields are accepted: ${fields.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}

export interface Ctx {
  readonly db: D1Database;
  readonly now: () => Date;
  readonly config: EnrollmentConfig;
  readonly limiter: RateLimitService;
}

export async function limited(ctx: Ctx, key: string, limit: number): Promise<Response | null> {
  const d = await ctx.limiter.checkKey(key, limit);
  if (d.allowed) return null;
  if (d.unavailable) {
    return fail(503, "rate_limiter_unavailable", "The shared rate limiter is unavailable.");
  }
  const seconds = String(Math.max(1, Math.ceil((d.retryAfterMs ?? 1000) / 1000)));
  return fail(429, "rate_limited", "Too many enrollment requests; try again later.", {
    "Retry-After": seconds,
  });
}

/** Per-client and global bounds applied before any body parsing or signature work. */
export async function limitClient(ctx: Ctx, request: Request): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Store only a digest of the client address in the counter key.
  const ipKey = `enroll:ip:${(await sha256Hex(`agent-commons/enroll-ip:${ip}`)).slice(0, 32)}`;
  return (
    (await limited(ctx, "enroll:global", ctx.config.globalLimit)) ??
    (await limited(ctx, ipKey, ctx.config.ipLimit))
  );
}

async function handleChallenge(ctx: Ctx, request: Request): Promise<Response> {
  const tooMany = await limitClient(ctx, request);
  if (tooMany) return tooMany;
  const body = await readBody(request, ["address", "purpose"]);
  if (body instanceof Response) return body;

  const address = normalizeAddress(body.address);
  if (address === null) {
    return fail(400, "invalid_address", "address must be a 20-byte hex EVM address (EIP-55).");
  }
  const purpose = body.purpose ?? "enroll";
  if (!CHALLENGE_PURPOSES.includes(purpose as ChallengePurpose)) {
    return fail(400, "invalid_request", "purpose must be enroll or rotate.");
  }
  const addressLimited = await limited(ctx, `enroll:addr:${address}`, ctx.config.addressLimit);
  if (addressLimited) return addressLimited;

  const now = ctx.now();
  const issuedAt = now.toISOString();
  const expirationTime = new Date(now.getTime() + ctx.config.ttlSeconds * 1000).toISOString();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const message = buildSiweMessage({
    domain: ctx.config.domain,
    address,
    uri: ctx.config.uri,
    chainId: ctx.config.chainId,
    nonce,
    issuedAt,
    expirationTime,
    purpose: purpose as ChallengePurpose,
  });

  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM wallet_challenges WHERE expires_at < ?")
      .bind(new Date(now.getTime() - PURGE_AFTER_MS).toISOString()),
    ctx.db
      .prepare(
        `INSERT INTO wallet_challenges (nonce, address, purpose, message_digest, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(nonce, address, purpose, await sha256Hex(message), issuedAt, expirationTime),
  ]);

  return reply(201, {
    schemaVersion: "wallet-challenge/v1",
    purpose,
    message,
    nonce,
    expiresAt: expirationTime,
    signing: "Sign the exact message with EIP-191 personal_sign from an externally owned account.",
  });
}

type Verified = { readonly address: string } | Response;

/** Verify a submitted challenge and consume its nonce. Returns the lower-case address. */
async function verifyAndConsume(
  ctx: Ctx,
  request: Request,
  purpose: ChallengePurpose,
): Promise<Verified> {
  const tooMany = await limitClient(ctx, request);
  if (tooMany) return tooMany;
  const body = await readBody(request, ["message", "signature"]);
  if (body instanceof Response) return body;
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    return fail(400, "invalid_request", "message and signature must be strings.");
  }
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    return fail(400, "invalid_request", "message is too long.");
  }

  const invalid = () =>
    fail(401, "invalid_challenge", "The sign-in message is not a valid, unused challenge.");
  const f = parseSiweMessage(message);
  if (
    f === null ||
    f.domain !== ctx.config.domain ||
    f.uri !== ctx.config.uri ||
    f.chainId !== ctx.config.chainId ||
    f.purpose !== purpose
  ) {
    return invalid();
  }
  const nowMs = ctx.now().getTime();
  if (Date.parse(f.issuedAt) > nowMs) return invalid();
  if (Date.parse(f.expirationTime) <= nowMs) {
    return fail(401, "challenge_expired", "The sign-in challenge has expired.");
  }

  const address = f.address.toLowerCase();
  const addressLimited = await limited(ctx, `enroll:addr:${address}`, ctx.config.addressLimit);
  if (addressLimited) return addressLimited;

  if (recoverPersonalSignAddress(message, signature) !== address) {
    return fail(401, "invalid_signature", "The signature does not match the message address.");
  }

  // Atomic one-time consumption: exact message digest, address, purpose, unconsumed, unexpired.
  const res = await ctx.db
    .prepare(
      `UPDATE wallet_challenges SET consumed_at = ?
       WHERE nonce = ? AND address = ? AND purpose = ? AND message_digest = ?
         AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(
      new Date(nowMs).toISOString(),
      f.nonce,
      address,
      purpose,
      await sha256Hex(message),
      new Date(nowMs).toISOString(),
    )
    .run();
  if (res.meta.changes !== 1) return invalid();
  return { address };
}

export interface Account {
  readonly operator_id: string;
  readonly agent_id: string;
}

export const findAccount = (db: D1Database, address: string) =>
  db
    .prepare("SELECT operator_id, agent_id FROM wallet_accounts WHERE address = ?")
    .bind(address)
    .first<Account>();

const credentialView = (id: string, token: string, label: string, createdAt: string) => ({
  id,
  token,
  label,
  createdAt,
  notice: "Shown once. Store it as a secret; it cannot be retrieved again.",
});

const newId = (prefix: "op" | "ag") => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function handleEnroll(ctx: Ctx, request: Request): Promise<Response> {
  const verified = await verifyAndConsume(ctx, request, "enroll");
  if (verified instanceof Response) return verified;
  const { address } = verified;

  const already = (account: Account) =>
    reply(200, {
      schemaVersion: "wallet-enrollment/v1",
      status: "already_enrolled",
      operatorId: account.operator_id,
      agentId: account.agent_id,
      credentialIssued: false,
      message: "This wallet is already enrolled. Use purpose=rotate to replace the credential.",
    });

  const existing = await findAccount(ctx.db, address);
  if (existing) return already(existing);

  const now = ctx.now();
  const at = now.toISOString();
  const operatorId = newId("op") as OperatorId;
  const agentId = newId("ag") as AgentId;
  const label = "wallet-enrollment";
  const credential = await new CredentialService(ctx.db, { now: ctx.now }).prepareIssue(
    agentId,
    label,
    now,
  );
  try {
    // One D1 batch = one transaction. A concurrent first enrollment of the same address fails
    // on the wallet_accounts primary key and rolls back its operator, agent and credential.
    const results = await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO operators (id, kind, display_name, status, contribution_allow_listed, created_at)
           VALUES (?, 'individual', 'Pilot wallet operator', 'active', 1, ?)`,
        )
        .bind(operatorId, at),
      ctx.db
        .prepare(
          `INSERT INTO agents (id, operator_id, display_name, status, created_at)
           VALUES (?, ?, 'Pilot wallet agent', 'active', ?)`,
        )
        .bind(agentId, operatorId, at),
      ctx.db
        .prepare(
          "INSERT INTO wallet_accounts (address, operator_id, agent_id, enrolled_at) VALUES (?, ?, ?, ?)",
        )
        .bind(address, operatorId, agentId, at),
      credential.statement,
    ]);
    if (results[3]?.meta.changes !== 1) throw new Error("credential not issued");
  } catch (e) {
    const winner = await findAccount(ctx.db, address);
    if (winner) return already(winner);
    throw e;
  }

  return reply(201, {
    schemaVersion: "wallet-enrollment/v1",
    status: "enrolled",
    operatorId,
    agentId,
    credentialIssued: true,
    credential: credentialView(credential.id, credential.token, label, at),
  });
}

async function handleRotate(ctx: Ctx, request: Request): Promise<Response> {
  const verified = await verifyAndConsume(ctx, request, "rotate");
  if (verified instanceof Response) return verified;
  const account = await findAccount(ctx.db, verified.address);
  if (!account) return fail(404, "not_enrolled", "This wallet is not enrolled.");

  const now = ctx.now();
  const at = now.toISOString();
  const label = "wallet-rotation";
  const credential = await new CredentialService(ctx.db, { now: ctx.now }).prepareIssue(
    account.agent_id as AgentId,
    label,
    now,
  );
  const active = `EXISTS (SELECT 1 FROM agents a JOIN operators o ON o.id = a.operator_id
                  WHERE a.id = ? AND a.status = 'active' AND o.status = 'active')`;
  // Revoke every prior credential and issue the new one in one transaction; both are
  // conditional on the agent and operator still being active.
  const [revoked, issued] = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE agent_credentials SET revoked_at = ?
         WHERE agent_id = ? AND revoked_at IS NULL AND ${active}`,
      )
      .bind(at, account.agent_id, account.agent_id),
    credential.statement,
  ]);
  if (issued?.meta.changes !== 1) {
    return fail(403, "identity_inactive", "The enrolled agent or operator is not active.");
  }
  return reply(201, {
    schemaVersion: "wallet-credential-rotation/v1",
    operatorId: account.operator_id,
    agentId: account.agent_id,
    revokedCredentials: revoked?.meta.changes ?? 0,
    credential: credentialView(credential.id, credential.token, label, at),
  });
}

export async function handleEnrollment(request: Request, env: EnrollmentEnv): Promise<Response> {
  const config = resolveEnrollmentConfig(env);
  if (config === null) {
    return fail(503, "misconfigured", "Enrollment configuration is invalid.");
  }
  if (config === false) return fail(403, "enrollment_disabled", "Enrollment is not enabled.");
  if (!env.DB) return fail(503, "misconfigured", "Enrollment configuration is invalid.");
  if (request.method !== "POST") return fail(404, "not_found", "Not found.");

  const now = env.NOW ?? (() => new Date());
  const ctx: Ctx = {
    db: env.DB,
    now,
    config,
    limiter: new RateLimitService(env.DB, {
      now,
      windowSeconds: ENROLLMENT_DEFAULTS.windowSeconds,
    }),
  };
  const { pathname } = new URL(request.url);
  try {
    switch (pathname) {
      case `${ENROLL_PATH_PREFIX}challenge`:
        return await handleChallenge(ctx, request);
      case `${ENROLL_PATH_PREFIX}complete`:
        return await handleEnroll(ctx, request);
      case `${ENROLL_PATH_PREFIX}rotate`:
        return await handleRotate(ctx, request);
      case `${ENROLL_PATH_PREFIX}spending-challenge`:
        return await handleSpendingChallenge(ctx, request);
      case `${ENROLL_PATH_PREFIX}spending-policy`:
        return await handleSpendingPolicy(ctx, request);
      case `${ENROLL_PATH_PREFIX}spending-suspension`:
        return await handleSpendingSuspension(ctx, request);
      default:
        return fail(404, "not_found", "Not found.");
    }
  } catch {
    return fail(500, "internal_error", "Enrollment is unavailable.");
  }
}
