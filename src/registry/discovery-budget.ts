/**
 * Deterministic UTF-8 byte budgeting for internal `discovery-response/v1` (Phase 3).
 *
 * UTF-8 bytes of the serialized JSON (`JSON.stringify`, measured with `TextEncoder`) are the
 * deterministic enforcement unit. They are a model-independent proxy for token cost, NOT an exact
 * model token count: no LLM or provider tokenizer is used.
 *
 * The response keeps the largest ranked prefix whose serialized JSON fits the budget. Results are
 * never reordered, and no field or result is ever split or truncated. Budget metadata is returned
 * beside the response; it is deliberately not added to `discovery-response/v1`. Pure, synchronous,
 * no D1/R2/network. Internal only: no public route.
 */
import { buildDiscoveryResponse, type DiscoveryResponse } from "./discovery";
import type { SearchResultItem } from "./search";

export interface DiscoveryBudget {
  readonly maxUtf8Bytes: number;
  /** Exact UTF-8 byte length of the JSON serialization of the returned response. */
  readonly usedUtf8Bytes: number;
  /** Ranked results dropped from the end to fit the budget. */
  readonly omittedResultCount: number;
}

export type DiscoveryBudgetErrorCode = "invalid_budget" | "budget_too_small";

export interface DiscoveryBudgetError {
  readonly code: DiscoveryBudgetErrorCode;
  readonly message: string;
}

export type BudgetedDiscoveryResult =
  | { readonly ok: true; readonly response: DiscoveryResponse; readonly budget: DiscoveryBudget }
  | { readonly ok: false; readonly error: DiscoveryBudgetError };

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function fail(code: DiscoveryBudgetErrorCode, message: string): BudgetedDiscoveryResult {
  return Object.freeze({ ok: false as const, error: Object.freeze({ code, message }) });
}

export function budgetDiscoveryResponse(
  items: readonly SearchResultItem[],
  maxUtf8Bytes: number,
): BudgetedDiscoveryResult {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0) {
    return fail("invalid_budget", "maxUtf8Bytes must be a positive safe integer.");
  }
  const full = buildDiscoveryResponse(items);
  const emptyBytes = utf8Bytes(JSON.stringify(buildDiscoveryResponse([])));
  if (emptyBytes > maxUtf8Bytes) {
    return fail("budget_too_small", "Budget cannot fit even an empty discovery response.");
  }

  // Size grows monotonically with the prefix length, so the first overflow ends the scan.
  let keep = 0;
  let best = emptyBytes;
  for (let k = 1; k <= full.results.length; k++) {
    const size = utf8Bytes(JSON.stringify(buildDiscoveryResponse(items.slice(0, k))));
    if (size > maxUtf8Bytes) break;
    keep = k;
    best = size;
  }

  const response =
    keep === full.results.length ? full : buildDiscoveryResponse(items.slice(0, keep));
  const budget: DiscoveryBudget = Object.freeze({
    maxUtf8Bytes,
    usedUtf8Bytes: best,
    omittedResultCount: items.length - keep,
  });
  return Object.freeze({ ok: true as const, response, budget });
}
