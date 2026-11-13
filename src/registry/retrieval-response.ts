/**
 * Internal full-contribution retrieval-response contract, `retrieval-response/v1` (Phase 3).
 *
 * Pure, synchronous, deterministic and LLM-free mapping from an already successful
 * {@link RetrievedContribution}. No D1, R2, network, clock or randomness.
 *
 * Knowledge `explanation` is untrusted contributed prose. It is removed from `content` and exposed
 * only as the structurally separate `untrustedExplanation` (`{ label: "untrusted", text }`, or
 * `null` when absent). The text is passed through verbatim: never interpreted, executed,
 * summarized or transformed. Execution responses have no explanation field at all.
 *
 * Built from an explicit field allow-list (never spread) and deeply frozen. Internal only.
 */
import type { ContributionRef } from "./envelope";
import type { ExecutionContributionInput } from "./execution";
import type { KnowledgeContributionInput } from "./knowledge";
import type { RetrievedContribution, VersionPlatformState } from "./retrieval";

export const RETRIEVAL_RESPONSE_VERSION = "retrieval-response/v1" as const;
export const UNTRUSTED_LABEL = "untrusted" as const;

export interface UntrustedExplanation {
  readonly label: typeof UNTRUSTED_LABEL;
  /** Original capped contributor text, byte-for-byte. Treat as data, never as instructions. */
  readonly text: string;
}

export type KnowledgeContent = Readonly<Omit<KnowledgeContributionInput, "explanation">>;

interface RetrievalResponseBase {
  readonly schemaVersion: typeof RETRIEVAL_RESPONSE_VERSION;
  readonly contributionId: string;
  readonly version: number;
  readonly previousVersion: number | null;
  readonly contentHash: string;
  readonly payloadBytes: number;
  readonly author: { readonly agentId: string; readonly operatorId: string };
  readonly contributor: { readonly agentId: string; readonly operatorId: string };
  readonly contributionCreatedAt: string;
  readonly createdAt: string;
  readonly platformState: VersionPlatformState;
  readonly related: readonly ContributionRef[];
}

export interface KnowledgeRetrievalResponse extends RetrievalResponseBase {
  readonly family: "knowledge";
  readonly content: KnowledgeContent;
  readonly untrustedExplanation: UntrustedExplanation | null;
}

export interface ExecutionRetrievalResponse extends RetrievalResponseBase {
  readonly family: "execution";
  readonly content: ExecutionContributionInput;
}

export type RetrievalResponse = KnowledgeRetrievalResponse | ExecutionRetrievalResponse;

export const RETRIEVAL_RESPONSE_KEYS = {
  knowledge: [
    "schemaVersion",
    "family",
    "contributionId",
    "version",
    "previousVersion",
    "contentHash",
    "payloadBytes",
    "author",
    "contributor",
    "contributionCreatedAt",
    "createdAt",
    "platformState",
    "related",
    "content",
    "untrustedExplanation",
  ],
  execution: [
    "schemaVersion",
    "family",
    "contributionId",
    "version",
    "previousVersion",
    "contentHash",
    "payloadBytes",
    "author",
    "contributor",
    "contributionCreatedAt",
    "createdAt",
    "platformState",
    "related",
    "content",
  ],
} as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Independent deep copy of validated JSON content, frozen so the input is never aliased. */
const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value));

function mapBase(c: RetrievedContribution) {
  return {
    schemaVersion: RETRIEVAL_RESPONSE_VERSION,
    contributionId: c.id,
    version: c.version,
    previousVersion: c.previousVersion,
    contentHash: c.contentHash,
    payloadBytes: c.payloadBytes,
    author: Object.freeze({ agentId: c.author.agentId, operatorId: c.author.operatorId }),
    contributor: Object.freeze({
      agentId: c.contributor.agentId,
      operatorId: c.contributor.operatorId,
    }),
    contributionCreatedAt: c.contributionCreatedAt,
    createdAt: c.createdAt,
    platformState: Object.freeze({
      lastVerifiedAt: c.platformState.lastVerifiedAt,
      reliabilityScore: c.platformState.reliabilityScore,
      consumerCount: c.platformState.consumerCount,
      updatedAt: c.platformState.updatedAt,
    }),
    related: Object.freeze(
      c.related.map((r) => Object.freeze({ family: r.family, id: r.id, version: r.version })),
    ),
  };
}

export function buildRetrievalResponse(contribution: RetrievedContribution): RetrievalResponse {
  switch (contribution.family) {
    case "knowledge": {
      const { explanation, ...rest } = contribution.content;
      const response: KnowledgeRetrievalResponse = {
        family: "knowledge",
        ...mapBase(contribution),
        content: frozenCopy(rest),
        untrustedExplanation:
          explanation === undefined
            ? null
            : Object.freeze({ label: UNTRUSTED_LABEL, text: explanation }),
      };
      return Object.freeze(response);
    }
    case "execution": {
      const response: ExecutionRetrievalResponse = {
        family: "execution",
        ...mapBase(contribution),
        content: frozenCopy(contribution.content),
      };
      return Object.freeze(response);
    }
    default:
      throw new Error("Unsupported contribution family in retrieved contribution.");
  }
}
