/**
 * Internal conditional-retrieval contract, `retrieval-not-modified/v1` (Phase 3).
 *
 * Compares a caller-supplied validator (`contributionId`, exact `version`, `contentHash`) with an
 * already verified {@link RetrievedContribution}. Only when all three match exactly (strict
 * equality, no normalization) is the minimal not-modified response returned; otherwise, or when no
 * validator is supplied, the complete `retrieval-response/v1` is returned through the unchanged
 * {@link buildRetrievalResponse} mapper.
 *
 * The not-modified response is built from an explicit allow-list and never contains family
 * content, untrusted explanation, provenance, platform state or related references. Pure,
 * synchronous, LLM-free: no D1, R2, network, clock or cache. Internal only: no public route.
 */
import type { RetrievedContribution } from "./retrieval";
import { buildRetrievalResponse, type RetrievalResponse } from "./retrieval-response";

export const RETRIEVAL_NOT_MODIFIED_VERSION = "retrieval-not-modified/v1" as const;

export const RETRIEVAL_NOT_MODIFIED_KEYS = [
  "schemaVersion",
  "contributionId",
  "version",
  "contentHash",
] as const;

export interface RetrievalValidator {
  readonly contributionId: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface RetrievalNotModifiedResponse {
  readonly schemaVersion: typeof RETRIEVAL_NOT_MODIFIED_VERSION;
  readonly contributionId: string;
  readonly version: number;
  readonly contentHash: string;
}

export type ConditionalRetrievalResponse = RetrievalNotModifiedResponse | RetrievalResponse;

export function buildConditionalRetrievalResponse(
  contribution: RetrievedContribution,
  validator?: RetrievalValidator | null,
): ConditionalRetrievalResponse {
  if (
    validator != null &&
    validator.contributionId === contribution.id &&
    validator.version === contribution.version &&
    validator.contentHash === contribution.contentHash
  ) {
    return Object.freeze({
      schemaVersion: RETRIEVAL_NOT_MODIFIED_VERSION,
      contributionId: contribution.id,
      version: contribution.version,
      contentHash: contribution.contentHash,
    });
  }
  return buildRetrievalResponse(contribution);
}
