/**
 * Content pricing and the licence a purchase grants (Phase 6). Prices are platform-owned and never
 * contributor-supplied. During the free pilot every price is zero and no payment is required, so
 * search and get behave exactly as before; the price is shown so agents can discover it before
 * paid access exists.
 *
 * Amounts are integer minor units (for example cents) with an ISO 4217 currency code, so the
 * payment provider can be chosen later without changing stored amounts.
 */
export type ContentFamily = "knowledge" | "execution";

/**
 * One purchase grants every agent of the buying operator permanent access to that exact
 * contribution version. A new version is a new purchase.
 */
export const LICENCE_OPERATOR_VERSION_PERPETUAL = "operator-version-perpetual";

export interface PriceQuote {
  readonly amountMinor: number;
  readonly currency: string;
  readonly licence: typeof LICENCE_OPERATOR_VERSION_PERPETUAL;
  readonly paymentRequired: boolean;
}

export interface VersionPrice extends PriceQuote {
  readonly contributionId: string;
  readonly version: number;
}

/** Pilot price list: Knowledge and Execution are priced separately; both are free for now. */
export const PILOT_PRICES: Readonly<Record<ContentFamily, Readonly<PriceQuote>>> = Object.freeze({
  knowledge: Object.freeze({
    amountMinor: 0,
    currency: "USD",
    licence: LICENCE_OPERATOR_VERSION_PERPETUAL,
    paymentRequired: false,
  }),
  execution: Object.freeze({
    amountMinor: 0,
    currency: "USD",
    licence: LICENCE_OPERATOR_VERSION_PERPETUAL,
    paymentRequired: false,
  }),
});

export function priceFor(family: ContentFamily): PriceQuote {
  return PILOT_PRICES[family];
}

export function versionPrice(ref: {
  readonly contributionId: string;
  readonly version: number;
  readonly family: ContentFamily;
}): VersionPrice {
  return { contributionId: ref.contributionId, version: ref.version, ...priceFor(ref.family) };
}
