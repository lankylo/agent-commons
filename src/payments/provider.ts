/**
 * Payment provider adapter (Phase 6). Only the sandbox provider exists: it confirms every charge
 * and moves no real money, so it is used only in sandbox mode. Live mode charges no provider:
 * purchases are paid from the agent's USDC balance.
 *
 * A provider must treat `purchaseRef` as its idempotency key: charging the same reference twice
 * charges once. Purchases are recorded only after a confirmed charge, and a charge whose purchase
 * cannot be recorded is refunded.
 */
export interface ChargeRequest {
  readonly purchaseRef: string;
  readonly operatorId: string;
  readonly agentId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export type ChargeResult =
  | { readonly ok: true; readonly providerRef: string }
  | { readonly ok: false; readonly code: "payment_declined" | "provider_unavailable" };

export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(providerRef: string, request: ChargeRequest): Promise<{ readonly ok: boolean }>;
}

export const SANDBOX_PROVIDER: PaymentProvider = Object.freeze({
  name: "sandbox",
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    return { ok: true, providerRef: `sandbox:${request.purchaseRef}` };
  },
  async refund(): Promise<{ readonly ok: boolean }> {
    return { ok: true };
  },
});

/**
 * - "off": every price is zero.
 * - "sandbox": prices apply; the sandbox provider confirms charges without money, so test only.
 * - "live": prices apply and purchases are paid only from the agent's USDC balance, which comes
 *   from verified on-chain deposits. No provider is ever charged.
 */
export type PaymentsMode = "off" | "sandbox" | "live";

/** Off unless exactly "sandbox" or "live"; any other value is invalid and fails closed. */
export function resolvePaymentsMode(value: unknown): PaymentsMode | undefined {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "sandbox" || value === "live") return value;
  return undefined;
}

/** Prices, earnings and rewards apply in both paid modes. */
export const paymentsOn = (value: unknown): boolean => {
  const mode = resolvePaymentsMode(value);
  return mode === "sandbox" || mode === "live";
};

/** Used in live mode in place of any provider: it never confirms a charge. */
export const REFUSING_PROVIDER: PaymentProvider = Object.freeze({
  name: "none",
  async charge(): Promise<ChargeResult> {
    return { ok: false, code: "provider_unavailable" };
  },
  async refund(): Promise<{ readonly ok: boolean }> {
    return { ok: false };
  },
});
