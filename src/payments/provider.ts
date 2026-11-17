/**
 * Payment provider adapter (Phase 6). Only the sandbox provider exists: it confirms every charge
 * and moves no real money. A real provider plugs in behind the same interface once the legal
 * review and provider choice are done.
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

export type PaymentsMode = "off" | "sandbox";

/** Off unless exactly "sandbox"; any other value is invalid and fails closed. */
export function resolvePaymentsMode(value: unknown): PaymentsMode | undefined {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "sandbox") return "sandbox";
  return undefined;
}
