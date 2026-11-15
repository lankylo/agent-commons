/**
 * Shared contribution envelope (design-only). Family-specific payload schemas
 * (Knowledge, Execution) are defined by later tasks; the envelope only fixes
 * the discriminator and the metadata common to both families.
 */
import type { ActorRef } from "../identity/types";

export const CONTRIBUTION_FAMILIES = ["knowledge", "execution"] as const;
export type ContributionFamily = (typeof CONTRIBUTION_FAMILIES)[number];

export function isContributionFamily(value: unknown): value is ContributionFamily {
  return typeof value === "string" && (CONTRIBUTION_FAMILIES as readonly string[]).includes(value);
}

export type ContributionId = string & { readonly __brand: "ContributionId" };

/**
 * Cross-family reference: by ID and exact immutable version, never embedded.
 * `family` is the family of the REFERENCED contribution and must be the
 * opposite of the referencing contribution's family (see `references.ts`).
 */
export interface ContributionRef {
  readonly family: ContributionFamily;
  readonly id: ContributionId;
  readonly version: number;
}

export interface EvidenceRef {
  readonly kind: string;
  readonly uri: string;
}

export interface LicenseDeclaration {
  readonly license: string;
  readonly dataPermission: string;
}

/** Fields a contributor supplies. Untrusted input. */
export interface ContributionEnvelopeInput<F extends ContributionFamily = ContributionFamily> {
  readonly family: F;
  readonly title: string;
  readonly purpose: string;
  readonly contentType: string;
  readonly evidence: readonly EvidenceRef[];
  readonly licensing: LicenseDeclaration;
  /** Days; contributor may choose shorter than the platform maximum, not longer. */
  readonly reviewIntervalDays: number;
  readonly related?: readonly ContributionRef[];
}

/** Fields only the platform may set. Contributors can never write these. */
export interface PlatformEnvelopeFields {
  readonly id: ContributionId;
  readonly version: number; // immutable once stored
  readonly contentHash: string;
  readonly contributor: ActorRef;
  readonly createdAt: string; // ISO 8601 UTC
  readonly lastVerifiedAt?: string; // ISO 8601 UTC
  /** Platform-computed; never contributor-supplied. */
  readonly reliabilityScore?: number;
  readonly consumerCount?: number;
}

export type ContributionEnvelope<F extends ContributionFamily = ContributionFamily> =
  ContributionEnvelopeInput<F> & PlatformEnvelopeFields;

/** Keys a contributor must not submit. */
export const PLATFORM_ONLY_FIELDS = [
  "id",
  "version",
  "contentHash",
  "contributor",
  "createdAt",
  "lastVerifiedAt",
  "reliabilityScore",
  "consumerCount",
  "executionDomainPolicy",
] as const;

/** Returns platform-only keys present in untrusted submitted data. */
export function findPlatformFieldViolations(submitted: Record<string, unknown>): string[] {
  return PLATFORM_ONLY_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(submitted, k));
}
