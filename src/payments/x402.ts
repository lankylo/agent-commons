/**
 * x402: a second way to pay (owner decision 2026-11-28; design in `docs/x402.md`).
 *
 * An agent with an x402 wallet buys one exact priced version per request, without enrolling or
 * depositing first. It signs a USDC `transferWithAuthorization` (EIP-3009, the x402 v2 `exact`
 * scheme) and a facilitator (Coinbase CDP) verifies and settles it on Base. The Worker never signs
 * a transaction: it signs only short-lived API JWTs for the facilitator.
 *
 * - {@link x402ConfigOf}: on only with `X402=on`, `PAYMENTS=live`, valid deposits (the same
 *   network and platform wallet) and a facilitator.
 * - {@link requirementsFor}, {@link paymentRequiredBody}: what a `402` offers.
 * - {@link decodePaymentSignature}, {@link matchPayment}: the client's payment must equal the offer.
 * - {@link cdpFacilitator}: the facilitator client; tests inject a fake through `X402_FACILITATOR`.
 * - {@link payerAccount}: the paying wallet's operator and agent, created on first payment.
 * - {@link X402Provider}: a {@link PaymentProvider} whose charge is the facilitator settlement, so
 *   the purchase is recorded by the existing provider path in `purchase.ts`.
 *
 * Every payment authorization is stored once, by nonce, before settlement
 * (`x402_payments`, migration 0027), and what happened next is appended to `x402_payment_events`.
 */
import { depositConfigOf, type ChainEnv } from "./config";
import type { ChargeRequest, ChargeResult, PaymentProvider } from "./provider";
import { resolvePaymentsMode } from "./provider";

export const X402_VERSION = 2;

/** The paid retrieval route. */
export const X402_GET_PATH = "/v1/x402/get";

/** CAIP-2 network and the USDC EIP-712 domain for each deposit network. */
const NETWORK_INFO: Readonly<
  Record<string, { readonly caip2: string; readonly name: string; readonly version: string }>
> = Object.freeze({
  base: { caip2: "eip155:8453", name: "USD Coin", version: "2" },
  "base-sepolia": { caip2: "eip155:84532", name: "USDC", version: "2" },
});

/** Seconds the payer's signed authorization may take to settle. */
export const X402_MAX_TIMEOUT_SECONDS = 60;

export interface PaymentRequirements {
  readonly scheme: "exact";
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: {
    readonly assetTransferMethod: "eip3009";
    readonly name: string;
    readonly version: string;
  };
}

export interface Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

/** A decoded `PAYMENT-SIGNATURE`. Kept as received, so the facilitator sees the original. */
export interface PaymentPayload {
  readonly x402Version: number;
  readonly accepted: Record<string, unknown>;
  readonly payload: { readonly signature: string; readonly authorization: Authorization };
  readonly [key: string]: unknown;
}

export interface VerifyResult {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

export interface SettleResult {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
}

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
}

export interface X402Env extends ChainEnv {
  /** "on" or "off" (default). */
  readonly X402?: string;
  /** Coinbase CDP API key (Worker secrets, set by the owner). */
  readonly CDP_API_KEY_ID?: string;
  readonly CDP_API_KEY_SECRET?: string;
  /** Test injection; never set from configuration. */
  readonly X402_FACILITATOR?: Facilitator;
}

export type X402Config =
  | { readonly mode: "off" }
  | { readonly mode: "invalid" }
  | {
      readonly mode: "on";
      readonly network: string;
      readonly asset: string;
      readonly payTo: string;
      readonly name: string;
      readonly version: string;
      readonly facilitator: Facilitator;
    };

export function x402ConfigOf(env: X402Env): X402Config {
  const value = env.X402;
  if (value === undefined || value === "" || value === "off") return { mode: "off" };
  if (value !== "on" || resolvePaymentsMode(env.PAYMENTS) !== "live") return { mode: "invalid" };
  const deposits = depositConfigOf(env);
  if (deposits.mode !== "on") return { mode: "invalid" };
  const info = NETWORK_INFO[deposits.network.network];
  if (!info) return { mode: "invalid" };
  const facilitator =
    env.X402_FACILITATOR ??
    (typeof env.CDP_API_KEY_ID === "string" &&
    env.CDP_API_KEY_ID.length > 0 &&
    typeof env.CDP_API_KEY_SECRET === "string" &&
    env.CDP_API_KEY_SECRET.length > 0
      ? cdpFacilitator(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
      : null);
  if (!facilitator) return { mode: "invalid" };
  return {
    mode: "on",
    network: info.caip2,
    asset: deposits.network.usdc,
    payTo: deposits.address,
    name: info.name,
    version: info.version,
    facilitator,
  };
}

export function requirementsFor(
  config: Extract<X402Config, { mode: "on" }>,
  amountMinor: number,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    amount: String(amountMinor),
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: { assetTransferMethod: "eip3009", name: config.name, version: config.version },
  };
}

const BAZAAR_DESCRIPTION =
  "Agent Commons: one operator-reviewed record about an API or an error it throws " +
  "(Knowledge, with pinned hashed sources) or a declarative HTTP recipe (Execution), " +
  "returned as JSON data.";

/** The v2 `PaymentRequired` object, with a Bazaar discovery declaration. */
export function paymentRequiredBody(
  resourceUrl: string,
  requirements: PaymentRequirements,
  error: string,
): Record<string, unknown> {
  return {
    x402Version: X402_VERSION,
    error,
    resource: {
      url: resourceUrl,
      description: "One exact version of an Agent Commons record.",
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: { contributionId: "<contributionId from search>", version: 1, maxUtf8Bytes: 20000 },
          },
          output: { type: "json", example: { data: { schemaVersion: "retrieval-response/v1" } } },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          description: BAZAAR_DESCRIPTION,
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST"] },
                bodyType: { type: "string", enum: ["json"] },
                body: {
                  type: "object",
                  properties: {
                    contributionId: { type: "string" },
                    version: { type: "integer", minimum: 1 },
                    maxUtf8Bytes: { type: "integer", minimum: 1 },
                  },
                  required: ["contributionId", "version", "maxUtf8Bytes"],
                  additionalProperties: false,
                },
              },
              required: ["type", "method", "bodyType", "body"],
              additionalProperties: false,
            },
            output: { type: "object" },
          },
          required: ["input"],
        },
      },
    },
  };
}

/** Standard base64 of the UTF-8 JSON, as the x402 HTTP transport carries it in headers. */
export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64Json(value: string): unknown {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length > 16384) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130,}$/;
const UINT = /^[0-9]{1,78}$/;

/** Parses `PAYMENT-SIGNATURE`; null when it is not a well-formed v2 `exact` EVM payload. */
export function decodePaymentSignature(header: string | null): PaymentPayload | null {
  if (header === null) return null;
  const value = decodeBase64Json(header);
  if (!isRecord(value) || !isRecord(value.accepted) || !isRecord(value.payload)) return null;
  const inner = value.payload;
  const auth = inner.authorization;
  if (typeof inner.signature !== "string" || !SIGNATURE.test(inner.signature)) return null;
  if (!isRecord(auth)) return null;
  const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const;
  if (!fields.every((f) => typeof auth[f] === "string")) return null;
  return value as unknown as PaymentPayload;
}

export type PaymentMatch =
  | { readonly ok: true; readonly payer: string; readonly nonce: string }
  | { readonly ok: false; readonly reason: string };

const sameAddress = (a: unknown, b: string) =>
  typeof a === "string" && ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();

/** The payment must accept exactly what we offer, to our wallet, valid now. */
export function matchPayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  now: Date,
): PaymentMatch {
  if (payment.x402Version !== X402_VERSION) return { ok: false, reason: "unsupported_version" };
  const a = payment.accepted;
  if (
    a.scheme !== requirements.scheme ||
    a.network !== requirements.network ||
    a.amount !== requirements.amount ||
    !sameAddress(a.asset, requirements.asset) ||
    !sameAddress(a.payTo, requirements.payTo)
  ) {
    return { ok: false, reason: "requirements_mismatch" };
  }
  const auth = payment.payload.authorization;
  if (!ADDRESS.test(auth.from) || !NONCE.test(auth.nonce)) {
    return { ok: false, reason: "invalid_authorization" };
  }
  if (!sameAddress(auth.to, requirements.payTo) || auth.value !== requirements.amount) {
    return { ok: false, reason: "requirements_mismatch" };
  }
  if (!UINT.test(auth.validAfter) || !UINT.test(auth.validBefore)) {
    return { ok: false, reason: "invalid_authorization" };
  }
  const seconds = Math.floor(now.getTime() / 1000);
  if (Number(auth.validAfter) > seconds || Number(auth.validBefore) <= seconds + 5) {
    return { ok: false, reason: "authorization_expired" };
  }
  return { ok: true, payer: auth.from.toLowerCase(), nonce: auth.nonce.toLowerCase() };
}

// --- Coinbase CDP facilitator -------------------------------------------------------------

export const CDP_HOST = "api.cdp.coinbase.com";
export const CDP_X402_PATH = "/platform/v2/x402";

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const jsonPart = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A CDP API JWT (EdDSA) for one request, valid two minutes. The key secret is the base64 64-byte
 * Ed25519 key (32-byte seed then 32-byte public key), as CDP issues it.
 */
export async function cdpJwt(
  keyId: string,
  keySecret: string,
  method: string,
  host: string,
  path: string,
  now: Date,
): Promise<string> {
  const raw = Uint8Array.from(atob(keySecret.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 64) throw new Error("invalid CDP key secret");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: base64Url(raw.slice(0, 32)), x: base64Url(raw.slice(32)) },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const nbf = Math.floor(now.getTime() / 1000);
  const header = {
    alg: "EdDSA",
    kid: keyId,
    typ: "JWT",
    nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
  };
  const claims = {
    sub: keyId,
    iss: "cdp",
    nbf,
    exp: nbf + 120,
    uris: [`${method} ${host}${path}`],
  };
  const signingInput = `${jsonPart(header)}.${jsonPart(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export function cdpFacilitator(
  keyId: string,
  keySecret: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now: () => Date = () => new Date(),
): Facilitator {
  const call = async (operation: "verify" | "settle", body: unknown): Promise<unknown> => {
    const path = `${CDP_X402_PATH}/${operation}`;
    const jwt = await cdpJwt(keyId, keySecret, "POST", CDP_HOST, path, now());
    const response = await fetcher(`https://${CDP_HOST}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json().catch(() => null);
    // A refused payment is a normal answer with a JSON body; anything else is an outage.
    if (!isRecord(parsed)) throw new Error(`facilitator ${operation} failed: ${response.status}`);
    return parsed;
  };
  const request = (payload: PaymentPayload, requirements: PaymentRequirements) => ({
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
  return {
    async verify(payload, requirements) {
      const r = (await call("verify", request(payload, requirements))) as Record<string, unknown>;
      if (typeof r.isValid !== "boolean") throw new Error("facilitator verify: malformed answer");
      return {
        isValid: r.isValid,
        ...(typeof r.invalidReason === "string" ? { invalidReason: r.invalidReason } : {}),
        ...(typeof r.payer === "string" ? { payer: r.payer } : {}),
      };
    },
    async settle(payload, requirements) {
      const r = (await call("settle", request(payload, requirements))) as Record<string, unknown>;
      if (typeof r.success !== "boolean") throw new Error("facilitator settle: malformed answer");
      return {
        success: r.success,
        ...(typeof r.errorReason === "string" ? { errorReason: r.errorReason } : {}),
        ...(typeof r.payer === "string" ? { payer: r.payer } : {}),
        transaction: typeof r.transaction === "string" ? r.transaction : "",
        network: typeof r.network === "string" ? r.network : requirements.network,
      };
    },
  };
}

// --- Payer accounts and payment records ---------------------------------------------------

/** Limits of the platform-set policy for wallets created by an x402 payment (USDC base units). */
export const X402_PAYER_POLICY = Object.freeze({
  perTransactionMinor: 50_000,
  dailyMinor: 1_000_000,
  monthlyMinor: 10_000_000,
  categories: ["knowledge", "execution"],
});

export interface PayerAccount {
  readonly operatorId: string;
  readonly agentId: string;
}

const ACCOUNT_SQL = "SELECT operator_id, agent_id FROM wallet_accounts WHERE address = ?";

const newId = (prefix: string) =>
  `${prefix}_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;

/**
 * The operator and agent of a paying wallet. A wallet that enrolled already is the same operator.
 * A new wallet gets an operator that cannot contribute, one agent and a platform-set policy;
 * enrolling later with the same wallet (credential rotation) gives it a credential.
 */
export async function payerAccount(
  db: D1Database,
  address: string,
  now: Date,
): Promise<PayerAccount> {
  const found = async () => {
    const row = await db
      .prepare(ACCOUNT_SQL)
      .bind(address)
      .first<{ operator_id: string; agent_id: string }>();
    return row ? { operatorId: row.operator_id, agentId: row.agent_id } : null;
  };
  const existing = await found();
  if (existing) return existing;
  const at = now.toISOString();
  const operatorId = newId("op");
  const agentId = newId("ag");
  const p = X402_PAYER_POLICY;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO operators (id, kind, display_name, status, contribution_allow_listed, created_at)
           VALUES (?, 'individual', 'x402 payer operator', 'active', 0, ?)`,
        )
        .bind(operatorId, at),
      db
        .prepare(
          `INSERT INTO agents (id, operator_id, display_name, status, created_at)
           VALUES (?, ?, 'x402 payer agent', 'active', ?)`,
        )
        .bind(agentId, operatorId, at),
      db
        .prepare(
          "INSERT INTO wallet_accounts (address, operator_id, agent_id, enrolled_at) VALUES (?, ?, ?, ?)",
        )
        .bind(address, operatorId, agentId, at),
      db
        .prepare(
          `INSERT INTO operator_spending_policies (operator_id, currency, per_transaction_limit_minor,
             daily_limit_minor, monthly_limit_minor, minimum_reserve_minor,
             max_autonomous_balance_minor, permitted_categories_json, withdrawals_need_approval,
             set_by, effective_at)
           VALUES (?, 'USDC', ?, ?, ?, 0, 0, ?, 1, 'x402', ?)`,
        )
        .bind(
          operatorId,
          p.perTransactionMinor,
          p.dailyMinor,
          p.monthlyMinor,
          JSON.stringify(p.categories),
          at,
        ),
    ]);
  } catch (error) {
    // A concurrent first payment from the same wallet won the primary key: use its account.
    const winner = await found();
    if (winner) return winner;
    throw error;
  }
  return { operatorId, agentId };
}

export type X402Event = "settled" | "settle_failed" | "settle_unknown" | "recorded" | "record_failed";

export class X402Payments {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date,
  ) {}

  /** Stores the authorization once; false when its nonce was used before. */
  async begin(input: {
    readonly nonce: string;
    readonly network: string;
    readonly payer: string;
    readonly operatorId: string;
    readonly contributionId: string;
    readonly version: number;
    readonly amountMinor: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO x402_payments (nonce, network, payer, operator_id, contribution_id, version,
           amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (nonce) DO NOTHING`,
      )
      .bind(
        input.nonce,
        input.network,
        input.payer,
        input.operatorId,
        input.contributionId,
        input.version,
        input.amountMinor,
        this.now().toISOString(),
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  /** Best effort: a lost event leaves the payment for reconciliation, never double-records it. */
  async event(
    nonce: string,
    event: X402Event,
    extra: { txHash?: string; purchaseRef?: string; detail?: string } = {},
  ): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO x402_payment_events (nonce, event, tx_hash, purchase_ref, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (nonce, event) DO NOTHING`,
        )
        .bind(
          nonce,
          event,
          extra.txHash ?? null,
          extra.purchaseRef ?? null,
          extra.detail === undefined ? null : extra.detail.slice(0, 200),
          this.now().toISOString(),
        )
        .run();
    } catch {
      // Reconciliation reports payments without a final event.
    }
  }
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The x402 settlement as a {@link PaymentProvider}: `charge` settles the verified payment, and the
 * purchase flow then records funding, reservation, purchase, licence and earnings in one batch.
 * There is no automatic refund: a settled payment that could not be recorded is left for the
 * owner (`record_failed`, raised by reconciliation).
 */
export class X402Provider implements PaymentProvider {
  readonly name = "x402";
  settlement: SettleResult | null = null;

  constructor(
    private readonly facilitator: Facilitator,
    private readonly payment: PaymentPayload,
    private readonly requirements: PaymentRequirements,
    private readonly nonce: string,
    private readonly records: X402Payments,
  ) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    let result: SettleResult;
    try {
      result = await this.facilitator.settle(this.payment, this.requirements);
    } catch {
      await this.records.event(this.nonce, "settle_unknown", { purchaseRef: request.purchaseRef });
      return { ok: false, code: "provider_unavailable" };
    }
    this.settlement = result;
    if (!result.success || !TX_HASH.test(result.transaction)) {
      await this.records.event(this.nonce, "settle_failed", {
        purchaseRef: request.purchaseRef,
        detail: result.errorReason ?? (result.success ? "missing transaction" : "declined"),
      });
      return { ok: false, code: result.success ? "provider_unavailable" : "payment_declined" };
    }
    const txHash = result.transaction.toLowerCase();
    await this.records.event(this.nonce, "settled", { txHash, purchaseRef: request.purchaseRef });
    return { ok: true, providerRef: txHash };
  }

  async refund(_providerRef: string, request: ChargeRequest): Promise<{ readonly ok: boolean }> {
    await this.records.event(this.nonce, "record_failed", { purchaseRef: request.purchaseRef });
    return { ok: false };
  }
}
