/**
 * Deterministic UTF-8 byte budgeting for internal `retrieval-response/v1` (Phase 3).
 *
 * UTF-8 bytes of the serialized JSON (`JSON.stringify`, measured with `TextEncoder`) are the
 * deterministic enforcement unit. They are a model-independent proxy for token cost, NOT an exact
 * model token count: no LLM or provider tokenizer is used.
 *
 * A retrieval response is all-or-nothing: no field or contribution content is ever truncated,
 * split, summarized or removed (Knowledge `untrustedExplanation` text included). If the complete
 * response does not fit, a typed `response_too_large` error reports the maximum and required
 * bytes and the response is not returned. Budget metadata is returned beside the response; it is
 * deliberately not added to `retrieval-response/v1`. Pure, synchronous, no D1/R2/network.
 * Internal only: no public route.
 */
import type { RetrievedContribution } from "./retrieval";
import { buildRetrievalResponse, type RetrievalResponse } from "./retrieval-response";

export interface RetrievalBudget {
  readonly maxUtf8Bytes: number;
  /** Exact UTF-8 byte length of the JSON serialization of the returned response. */
  readonly usedUtf8Bytes: number;
}

export type RetrievalBudgetError =
  | { readonly code: "invalid_budget"; readonly message: string }
  | {
      readonly code: "response_too_large";
      readonly message: string;
      readonly maxUtf8Bytes: number;
      readonly requiredUtf8Bytes: number;
    };

export type BudgetedRetrievalResult =
  | { readonly ok: true; readonly response: RetrievalResponse; readonly budget: RetrievalBudget }
  | { readonly ok: false; readonly error: RetrievalBudgetError };

const encoder = new TextEncoder();

export function budgetRetrievalResponse(
  contribution: RetrievedContribution,
  maxUtf8Bytes: number,
): BudgetedRetrievalResult {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "invalid_budget" as const,
        message: "maxUtf8Bytes must be a positive safe integer.",
      }),
    });
  }
  const response = buildRetrievalResponse(contribution);
  const required = encoder.encode(JSON.stringify(response)).length;
  if (required > maxUtf8Bytes) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "response_too_large" as const,
        message: "Complete retrieval response exceeds the UTF-8 byte budget.",
        maxUtf8Bytes,
        requiredUtf8Bytes: required,
      }),
    });
  }
  const budget: RetrievalBudget = Object.freeze({ maxUtf8Bytes, usedUtf8Bytes: required });
  return Object.freeze({ ok: true as const, response, budget });
}
