/**
 * Content pricing, the licence a purchase grants and the contributor's revenue share (Phase 6).
 * Prices are platform-owned and never contributor-supplied.
 *
 * Payment is in USDC (a stablecoin worth 1 USD). Amounts are integer USDC base units: 1 USDC is
 * 1,000,000 units, so 0.01 USDC is 10,000. While payments are off every price is zero, so search
 * and get behave exactly as before; the paid prices apply only when payments are switched on.
 */
export type ContentFamily = "knowledge" | "execution";

/** Payment currency code, as stored in the ledger. */
export const PAYMENT_CURRENCY = "USDC";

/** Base units per whole USDC (6 decimals). */
export const USDC_UNITS = 1_000_000;

/**
 * One purchase grants every agent of the buying operator permanent access to that exact
 * contribution version. A new version is a new purchase.
 */
export const LICENCE_OPERATOR_VERSION_PERPETUAL = "operator-version-perpetual";

/**
 * The contributor's share of an independent purchase, in percent; the platform keeps the rest.
 * Migration 0016 enforces the same figure in D1 (trigger `ledger_entries_revenue_share_amount`).
 */
export const CONTRIBUTOR_SHARE_PERCENT = 50;

/** The contributor's earning from a purchase of `amountMinor`, rounded down. */
export const contributorShare = (amountMinor: number): number =>
  Math.floor((amountMinor * CONTRIBUTOR_SHARE_PERCENT) / 100);

export interface PriceQuote {
  readonly amountMinor: number;
  readonly currency: string;
  readonly licence: typeof LICENCE_OPERATOR_VERSION_PERPETUAL;
  /** True exactly when the amount is above zero. */
  readonly paymentRequired: boolean;
}

export interface VersionPrice extends PriceQuote {
  readonly contributionId: string;
  readonly version: number;
}

/** The platform's price for each family. */
export type PriceList = (family: ContentFamily) => PriceQuote;

export function quote(amountMinor: number, currency: string): PriceQuote {
  return Object.freeze({
    amountMinor,
    currency,
    licence: LICENCE_OPERATOR_VERSION_PERPETUAL,
    paymentRequired: amountMinor > 0,
  });
}

/** Prices while payments are off: everything is free. */
export const PILOT_PRICES: Readonly<Record<ContentFamily, PriceQuote>> = Object.freeze({
  knowledge: quote(0, PAYMENT_CURRENCY),
  execution: quote(0, PAYMENT_CURRENCY),
});

/** Prices once payments are on: 0.01 USDC per Knowledge version, 0.05 USDC per Execution version. */
export const PAID_PRICES: Readonly<Record<ContentFamily, PriceQuote>> = Object.freeze({
  knowledge: quote(10_000, PAYMENT_CURRENCY),
  execution: quote(50_000, PAYMENT_CURRENCY),
});

export const PILOT_PRICE_LIST: PriceList = (family) => PILOT_PRICES[family];
export const PAID_PRICE_LIST: PriceList = (family) => PAID_PRICES[family];

export function priceFor(family: ContentFamily, prices: PriceList = PILOT_PRICE_LIST): PriceQuote {
  return prices(family);
}

export function versionPrice(
  ref: {
    readonly contributionId: string;
    readonly version: number;
    readonly family: ContentFamily;
  },
  prices: PriceList = PILOT_PRICE_LIST,
): VersionPrice {
  return { contributionId: ref.contributionId, version: ref.version, ...prices(ref.family) };
}
