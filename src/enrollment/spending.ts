/**
 * Wallet-signed operator spending controls (Phase 6, no live money).
 *
 * An enrolled wallet controls its own operator's spending: it sets the USDC spending policy, or
 * suspends or resumes spending for one agent or every agent. Two steps, like enrollment:
 *
 * 1. `POST /v1/enroll/spending-challenge` `{address, purpose, request}` validates the request and
 *    returns a server-built ERC-4361 message whose statement summarizes the request and whose
 *    resources name the SHA-256 of the request's canonical JSON.
 * 2. `POST /v1/enroll/spending-policy` or `/v1/enroll/spending-suspension`
 *    `{message, signature, request}` checks the signature, the request digest and the message
 *    digest, consumes the one-time nonce and records the change.
 *
 * The operator is always the one bound to the signing wallet; requests carry no operator ID. Only
 * public data is stored. Enforcement stays in D1 (migration 0014).
 */
import { PayoutService } from "../payments/payouts";
import { PAYMENT_CURRENCY } from "../payments/pricing";
import {
  invalidPolicyField,
  SpendingControls,
  type SpendingPolicyInput,
} from "../payments/spending-controls";
import {
  fail,
  findAccount,
  limitClient,
  limited,
  readBody,
  reply,
  sha256Hex,
  type Ctx,
} from "./routes";
import {
  ACTION_PURPOSES,
  MAX_MESSAGE_BYTES,
  buildActionMessage,
  normalizeAddress,
  parseActionMessage,
  recoverPersonalSignAddress,
  type ActionPurpose,
} from "./siwe";

const PURGE_AFTER_MS = 60 * 60 * 1000;

const POLICY_FIELDS = [
  "currency",
  "perTransactionLimitMinor",
  "dailyLimitMinor",
  "monthlyLimitMinor",
  "minimumReserveMinor",
  "maxAutonomousBalanceMinor",
  "permittedCategories",
  "withdrawalsNeedApproval",
] as const;
const SUSPENSION_FIELDS = ["action", "agentId", "reason"] as const;
const PAYOUT_FIELDS = ["requestId", "decision"] as const;

export interface PayoutApprovalRequest {
  readonly requestId: number;
  readonly decision: "approve" | "reject";
}

export type PolicyRequest = Omit<SpendingPolicyInput, "operatorId" | "setBy">;

export interface SuspensionRequest {
  readonly action: "suspend" | "resume";
  /** null applies to every agent of the operator. */
  readonly agentId: string | null;
  readonly reason: string;
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly field: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with object keys sorted at every level, so key order never changes the digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): string | null {
  const extra = Object.keys(value).find((k) => !keys.includes(k));
  if (extra !== undefined) return extra;
  const missing = keys.find((k) => !Object.hasOwn(value, k));
  return missing ?? null;
}

export function checkPolicyRequest(value: unknown): Checked<PolicyRequest> {
  if (!isObject(value)) return { field: "request" };
  const key = exactKeys(value, POLICY_FIELDS);
  if (key) return { field: key };
  const request = value as unknown as PolicyRequest;
  if (request.currency !== PAYMENT_CURRENCY) return { field: "currency" };
  const field = invalidPolicyField({ ...request, operatorId: "operator", setBy: "wallet" });
  return field ? { field } : { ok: true, value: request };
}

export function checkSuspensionRequest(value: unknown): Checked<SuspensionRequest> {
  if (!isObject(value)) return { field: "request" };
  const key = exactKeys(value, SUSPENSION_FIELDS);
  if (key) return { field: key };
  if (value.action !== "suspend" && value.action !== "resume") return { field: "action" };
  if (
    value.agentId !== null &&
    (typeof value.agentId !== "string" || value.agentId.length < 1 || value.agentId.length > 64)
  ) {
    return { field: "agentId" };
  }
  if (
    typeof value.reason !== "string" ||
    value.reason.trim().length === 0 ||
    value.reason.length > 500
  ) {
    return { field: "reason" };
  }
  return { ok: true, value: value as unknown as SuspensionRequest };
}

/** Integer USDC base units as a decimal string, e.g. 10000 -> "0.01". */
export function formatUsdc(units: number): string {
  const whole = Math.floor(units / 1_000_000);
  const fraction = String(units % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

const NOT_A_TRANSACTION = "This signature is not a transaction and costs nothing.";

/** The one-line statement the wallet shows: a readable summary of the request. */
export function statementFor(
  purpose: ActionPurpose,
  request: unknown,
  payout?: { readonly amountMinor: number; readonly destination: string },
): string {
  if (purpose === "payout-approval") {
    const p = request as PayoutApprovalRequest;
    const verb = p.decision === "approve" ? "Approve" : "Reject";
    const amount = payout ? ` of ${formatUsdc(payout.amountMinor)} USDC` : "";
    const to = payout ? ` to your wallet ${payout.destination}` : "";
    return `${verb} Agent Commons payout request ${p.requestId}${amount}${to}. ${NOT_A_TRANSACTION}`;
  }
  if (purpose === "spending-policy") {
    const p = request as PolicyRequest;
    const summary = (categories: string) =>
      `Set the Agent Commons spending policy for your agents (USDC): per purchase ` +
      `${formatUsdc(p.perTransactionLimitMinor)}, per day ${formatUsdc(p.dailyLimitMinor)}, ` +
      `per month ${formatUsdc(p.monthlyLimitMinor)}, reserve ${formatUsdc(p.minimumReserveMinor)}; ` +
      `categories: ${categories}. ${NOT_A_TRANSACTION}`;
    const full = summary(p.permittedCategories.length ? p.permittedCategories.join(", ") : "none");
    return full.length <= 300 ? full : summary(`${p.permittedCategories.length} listed`);
  }
  const s = request as SuspensionRequest;
  const verb = s.action === "suspend" ? "Suspend" : "Resume";
  const target = s.agentId === null ? "all your agents" : `agent ${s.agentId}`;
  const head = `${verb} Agent Commons spending for ${target}. ${NOT_A_TRANSACTION} Reason: `;
  const reason = s.reason.replace(/\s+/g, " ").trim();
  const room = 300 - head.length;
  return head + (reason.length <= room ? reason : `${reason.slice(0, room - 3)}...`);
}

export function checkPayoutApproval(value: unknown): Checked<PayoutApprovalRequest> {
  if (!isObject(value)) return { field: "request" };
  const key = exactKeys(value, PAYOUT_FIELDS);
  if (key) return { field: key };
  if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) {
    return { field: "requestId" };
  }
  if (value.decision !== "approve" && value.decision !== "reject") return { field: "decision" };
  return { ok: true, value: value as unknown as PayoutApprovalRequest };
}

function checkRequest(purpose: ActionPurpose, value: unknown): Checked<unknown> {
  if (purpose === "payout-approval") return checkPayoutApproval(value);
  return purpose === "spending-policy" ? checkPolicyRequest(value) : checkSuspensionRequest(value);
}

const invalidRequest = (field: string) =>
  fail(400, "invalid_request", `The request is invalid: ${field}.`);

const agentOfOperator = async (ctx: Ctx, operatorId: string, agentId: string) =>
  (await ctx.db
    .prepare("SELECT 1 AS found FROM agents WHERE id = ? AND operator_id = ?")
    .bind(agentId, operatorId)
    .first()) !== null;

export async function handleSpendingChallenge(ctx: Ctx, request: Request): Promise<Response> {
  const tooMany = await limitClient(ctx, request);
  if (tooMany) return tooMany;
  const body = await readBody(request, ["address", "purpose", "request"]);
  if (body instanceof Response) return body;

  const address = normalizeAddress(body.address);
  if (address === null) {
    return fail(400, "invalid_address", "address must be a 20-byte hex EVM address (EIP-55).");
  }
  const purpose = body.purpose as ActionPurpose;
  if (!ACTION_PURPOSES.includes(purpose)) {
    return fail(400, "invalid_request", "purpose must be spending-policy or spending-suspension.");
  }
  const checked = checkRequest(purpose, body.request);
  if (!("ok" in checked)) return invalidRequest(checked.field);
  const addressLimited = await limited(ctx, `enroll:addr:${address}`, ctx.config.addressLimit);
  if (addressLimited) return addressLimited;

  const account = await findAccount(ctx.db, address);
  if (!account) return fail(404, "not_enrolled", "This wallet is not enrolled.");
  const agentId = (checked.value as Partial<SuspensionRequest>).agentId;
  if (typeof agentId === "string" && !(await agentOfOperator(ctx, account.operator_id, agentId))) {
    return fail(404, "agent_not_found", "No agent with that ID belongs to this wallet's operator.");
  }
  let payout: { readonly amountMinor: number; readonly destination: string } | undefined;
  if (purpose === "payout-approval") {
    const found = await new PayoutService(ctx.db, ctx.now).get(
      (checked.value as PayoutApprovalRequest).requestId,
    );
    if (!found || found.operatorId !== account.operator_id) {
      return fail(404, "payout_not_found", "No payout request with that ID for this operator.");
    }
    if (found.status !== "awaiting_approval") {
      return fail(409, "not_awaiting_approval", "That payout request is not awaiting approval.");
    }
    payout = found;
  }

  const now = ctx.now();
  const issuedAt = now.toISOString();
  const expirationTime = new Date(now.getTime() + ctx.config.ttlSeconds * 1000).toISOString();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const requestDigest = await sha256Hex(canonicalJson(checked.value));
  const message = buildActionMessage({
    domain: ctx.config.domain,
    address,
    statement: statementFor(purpose, checked.value, payout),
    uri: ctx.config.uri,
    chainId: ctx.config.chainId,
    nonce,
    issuedAt,
    expirationTime,
    purpose,
    requestDigest,
  });

  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM wallet_action_challenges WHERE expires_at < ?")
      .bind(new Date(now.getTime() - PURGE_AFTER_MS).toISOString()),
    ctx.db
      .prepare(
        `INSERT INTO wallet_action_challenges
           (nonce, address, purpose, request_digest, message_digest, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        nonce,
        address,
        purpose,
        requestDigest,
        await sha256Hex(message),
        issuedAt,
        expirationTime,
      ),
  ]);

  return reply(201, {
    schemaVersion: "wallet-action-challenge/v1",
    purpose,
    message,
    nonce,
    requestDigest,
    expiresAt: expirationTime,
    signing:
      "Sign the exact message with EIP-191 personal_sign, then submit it with the signature and the same request.",
  });
}

interface VerifiedAction {
  readonly address: string;
  readonly operatorId: string;
  readonly value: unknown;
}

/** Verify a signed action and consume its nonce. Returns the wallet's operator and the request. */
async function verifyAction(
  ctx: Ctx,
  request: Request,
  purpose: ActionPurpose,
): Promise<VerifiedAction | Response> {
  const tooMany = await limitClient(ctx, request);
  if (tooMany) return tooMany;
  const body = await readBody(request, ["message", "signature", "request"]);
  if (body instanceof Response) return body;
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    return fail(400, "invalid_request", "message and signature must be strings.");
  }
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    return fail(400, "invalid_request", "message is too long.");
  }
  const checked = checkRequest(purpose, body.request);
  if (!("ok" in checked)) return invalidRequest(checked.field);

  const invalid = () =>
    fail(401, "invalid_challenge", "The signed message is not a valid, unused challenge.");
  const f = parseActionMessage(message);
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
    return fail(401, "challenge_expired", "The challenge has expired.");
  }
  const requestDigest = await sha256Hex(canonicalJson(checked.value));
  if (requestDigest !== f.requestDigest) {
    return fail(401, "request_mismatch", "The request is not the one the message authorizes.");
  }

  const address = f.address.toLowerCase();
  const addressLimited = await limited(ctx, `enroll:addr:${address}`, ctx.config.addressLimit);
  if (addressLimited) return addressLimited;
  if (recoverPersonalSignAddress(message, signature) !== address) {
    return fail(401, "invalid_signature", "The signature does not match the message address.");
  }

  const at = new Date(nowMs).toISOString();
  const res = await ctx.db
    .prepare(
      `UPDATE wallet_action_challenges SET consumed_at = ?
       WHERE nonce = ? AND address = ? AND purpose = ? AND request_digest = ?
         AND message_digest = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(at, f.nonce, address, purpose, requestDigest, await sha256Hex(message), at)
    .run();
  if (res.meta.changes !== 1) return invalid();

  const account = await findAccount(ctx.db, address);
  if (!account) return fail(404, "not_enrolled", "This wallet is not enrolled.");
  return { address, operatorId: account.operator_id, value: checked.value };
}

export async function handleSpendingPolicy(ctx: Ctx, request: Request): Promise<Response> {
  const verified = await verifyAction(ctx, request, "spending-policy");
  if (verified instanceof Response) return verified;
  const result = await new SpendingControls(ctx.db, ctx.now).setPolicy({
    ...(verified.value as PolicyRequest),
    operatorId: verified.operatorId,
    setBy: `wallet:${verified.address}`,
  });
  if (!result.ok) return invalidRequest(result.error.field);
  return reply(201, { schemaVersion: "spending-policy/v1", policy: result.value });
}

export async function handleSpendingSuspension(ctx: Ctx, request: Request): Promise<Response> {
  const verified = await verifyAction(ctx, request, "spending-suspension");
  if (verified instanceof Response) return verified;
  const s = verified.value as SuspensionRequest;
  if (s.agentId !== null && !(await agentOfOperator(ctx, verified.operatorId, s.agentId))) {
    return fail(404, "agent_not_found", "No agent with that ID belongs to this wallet's operator.");
  }
  const controls = new SpendingControls(ctx.db, ctx.now);
  const target = { operatorId: verified.operatorId, agentId: s.agentId };
  const setBy = `wallet:${verified.address}`;
  const result =
    s.action === "suspend"
      ? await controls.suspend(target, s.reason, setBy)
      : await controls.resume(target, s.reason, setBy);
  if (!result.ok) return invalidRequest(result.error.field);
  return reply(201, {
    schemaVersion: "spending-suspension/v1",
    action: s.action,
    agentId: s.agentId,
    suspensionId: result.value.suspensionId,
  });
}

/** The operator's signed decision on a payout request that awaits approval. */
export async function handlePayoutApproval(ctx: Ctx, request: Request): Promise<Response> {
  const verified = await verifyAction(ctx, request, "payout-approval");
  if (verified instanceof Response) return verified;
  const decision = verified.value as PayoutApprovalRequest;
  const result = await new PayoutService(ctx.db, ctx.now).decide(
    verified.operatorId,
    decision.requestId,
    decision.decision === "approve",
    `wallet:${verified.address}`,
  );
  if (!result.ok) {
    return result.code === "not_found"
      ? fail(404, "payout_not_found", "No payout request with that ID for this operator.")
      : fail(409, result.code, "The payout decision was not recorded.");
  }
  return reply(201, { schemaVersion: "payout-decision/v1", payout: result.payout });
}
