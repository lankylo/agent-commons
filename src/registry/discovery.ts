/**
 * Compact, family-labelled internal discovery response (Phase 3).
 *
 * Pure, synchronous, deterministic and LLM-free mapping from already-ranked {@link SearchResultItem}
 * values. No D1, R2, network, clock or randomness. Ranked order is preserved exactly.
 *
 * Output uses an explicit field allow-list built field by field (never spread), so any extra
 * property on an input item is dropped. It carries evaluation metadata only; it never contains
 * indexed search text, Knowledge summary/explanation/facts/sources, Execution objective/steps, R2
 * content, identities, hashes or other contribution content. Internal only: no public route.
 */
import type { ContributionRef } from "./envelope";
import type { FreshnessState, SearchResultItem } from "./search";

export const DISCOVERY_RESPONSE_VERSION = "discovery-response/v1" as const;

interface DiscoveryItemBase {
  readonly contributionId: string;
  readonly version: number;
  readonly contentType: string;
  readonly title: string;
  readonly purpose: string;
  readonly asOf: string;
  readonly freshness: FreshnessState;
  readonly reviewDueAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly reliabilityScore: number | null;
  readonly consumerCount: number;
  /** Exact `{ family, id, version }` references in stored order; empty when none. */
  readonly related: readonly ContributionRef[];
}

export interface KnowledgeDiscoveryItem extends DiscoveryItemBase {
  readonly family: "knowledge";
}
export interface ExecutionDiscoveryItem extends DiscoveryItemBase {
  readonly family: "execution";
}
export type DiscoveryItem = KnowledgeDiscoveryItem | ExecutionDiscoveryItem;

export interface DiscoveryResponse {
  readonly schemaVersion: typeof DISCOVERY_RESPONSE_VERSION;
  readonly resultCount: number;
  /** In exactly the input (ranked) order. */
  readonly results: readonly DiscoveryItem[];
}

/** Exact allow-list of keys on every discovery item (family-independent). */
export const DISCOVERY_ITEM_KEYS = [
  "contributionId",
  "version",
  "family",
  "contentType",
  "title",
  "purpose",
  "asOf",
  "freshness",
  "reviewDueAt",
  "lastVerifiedAt",
  "reliabilityScore",
  "consumerCount",
  "related",
] as const;

function toDiscoveryItem(item: SearchResultItem): DiscoveryItem {
  const base = {
    contributionId: item.id,
    version: item.version,
    contentType: item.contentType,
    title: item.title,
    purpose: item.purpose,
    asOf: item.asOf,
    freshness: item.freshness,
    reviewDueAt: item.reviewDueAt,
    lastVerifiedAt: item.lastVerifiedAt,
    reliabilityScore: item.reliabilityScore,
    consumerCount: item.consumerCount,
    related: Object.freeze(
      item.related.map((r) => Object.freeze({ family: r.family, id: r.id, version: r.version })),
    ),
  };
  switch (item.family) {
    case "knowledge":
      return Object.freeze({ family: "knowledge" as const, ...base });
    case "execution":
      return Object.freeze({ family: "execution" as const, ...base });
    default:
      throw new Error("Unsupported contribution family in search result.");
  }
}

export function buildDiscoveryResponse(items: readonly SearchResultItem[]): DiscoveryResponse {
  const results = Object.freeze(items.map(toDiscoveryItem));
  return Object.freeze({
    schemaVersion: DISCOVERY_RESPONSE_VERSION,
    resultCount: results.length,
    results,
  });
}
