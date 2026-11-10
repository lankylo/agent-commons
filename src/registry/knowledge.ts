/**
 * Knowledge contribution schema (Phase 2). Validates untrusted contributor
 * input for the `knowledge` family within the shared envelope. Pure and
 * deterministic: no I/O, no storage, no LLM. Execution fields (steps, target
 * domains) are intentionally not part of this schema and are rejected.
 */
import { PLATFORM_ONLY_FIELDS, type ContributionEnvelopeInput } from "./envelope";
import { Checker, SHA256_HEX, isObj } from "./check";

export const KNOWLEDGE_LIMITS = {
  /** Untrusted prose; the only free-text field. */
  explanationMaxChars: 1000,
  summaryMaxChars: 600,
  titleMaxChars: 160,
  purposeMaxChars: 300,
  shortStringMaxChars: 200,
  uriMaxChars: 2048,
  maxFacts: 100,
  maxRecords: 100,
  maxRecordFields: 30,
  maxSources: 20,
  maxEvidence: 20,
  maxRelated: 20,
  reviewIntervalMaxDaysCeiling: 3650,
} as const;

export const HASH_ALGORITHMS = ["sha256"] as const;
export const VERIFICATION_METHODS = [
  "owner-tested",
  "source-checked",
  "cross-source",
  "unverified",
] as const;
export const PERMITTED_USES = ["reference-only", "summary", "redistribute"] as const;

export type Scalar = string | number | boolean | null;

export interface KnowledgeFact {
  readonly subject: string;
  readonly predicate: string;
  readonly value: Scalar;
  readonly unit?: string;
}

export type KnowledgeRecord = Readonly<Record<string, Scalar>>;

/** Source as accessed at contribution time. A reference, never an action target. */
export interface KnowledgeSource {
  readonly uri: string;
  readonly accessedAt: string; // ISO 8601 UTC
  readonly sourceDate?: string; // ISO 8601 UTC, publication/last-modified
  readonly hash: { readonly algorithm: (typeof HASH_ALGORITHMS)[number]; readonly digest: string };
  readonly snapshotRef?: string;
}

export interface KnowledgeRights {
  readonly sourceLicense: string;
  readonly rightsHolder?: string;
  readonly permittedUse: (typeof PERMITTED_USES)[number];
}

/** Contributor's claim only; platform verification (lastVerifiedAt) is separate. */
export interface KnowledgeVerification {
  readonly method: (typeof VERIFICATION_METHODS)[number];
  /** Contributor-declared, 0..1. Not a platform reliability score. */
  readonly declaredConfidence?: number;
}

export interface KnowledgeContributionInput extends ContributionEnvelopeInput<"knowledge"> {
  readonly facts?: readonly KnowledgeFact[];
  readonly records?: readonly KnowledgeRecord[];
  readonly summary?: string;
  /** Untrusted, capped prose. Always served labelled untrusted; never ranked on. */
  readonly explanation?: string;
  readonly sources: readonly KnowledgeSource[];
  readonly rights: KnowledgeRights;
  readonly verification: KnowledgeVerification;
  /** Observed freshness of the facts themselves. */
  readonly asOf: string; // ISO 8601 UTC
}

export type KnowledgeValidation =
  | { readonly ok: true; readonly value: KnowledgeContributionInput }
  | { readonly ok: false; readonly errors: readonly string[] };

const ALLOWED_KEYS = new Set([
  "family",
  "title",
  "purpose",
  "contentType",
  "evidence",
  "licensing",
  "reviewIntervalDays",
  "related",
  "facts",
  "records",
  "summary",
  "explanation",
  "sources",
  "rights",
  "verification",
  "asOf",
]);

/** Validate untrusted input as a Knowledge contribution. Never throws. */
export function validateKnowledgeContribution(input: unknown): KnowledgeValidation {
  const c = new Checker();
  if (!isObj(input)) return { ok: false, errors: ["input: must be an object"] };

  for (const k of PLATFORM_ONLY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, k)) {
      c.err(k, "platform-computed field cannot be set by contributors");
    }
  }
  for (const k of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(k) && !(PLATFORM_ONLY_FIELDS as readonly string[]).includes(k)) {
      c.err(k, "unknown field");
    }
  }

  if (input.family !== "knowledge") c.err("family", 'must be "knowledge"');
  c.str(input.title, "title", KNOWLEDGE_LIMITS.titleMaxChars);
  c.str(input.purpose, "purpose", KNOWLEDGE_LIMITS.purposeMaxChars);
  c.str(input.contentType, "contentType", KNOWLEDGE_LIMITS.shortStringMaxChars);

  const days = input.reviewIntervalDays;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > KNOWLEDGE_LIMITS.reviewIntervalMaxDaysCeiling
  ) {
    c.err(
      "reviewIntervalDays",
      `must be an integer from 1 to ${KNOWLEDGE_LIMITS.reviewIntervalMaxDaysCeiling}`,
    );
  }

  c.list(input.evidence, "evidence", KNOWLEDGE_LIMITS.maxEvidence).forEach((e, i) => {
    const o = c.obj(e, `evidence[${i}]`, ["kind", "uri"]);
    if (!o) return;
    c.str(o.kind, `evidence[${i}].kind`, KNOWLEDGE_LIMITS.shortStringMaxChars);
    c.uri(o.uri, `evidence[${i}].uri`);
  });

  const lic = c.obj(input.licensing, "licensing", ["license", "dataPermission"]);
  if (lic) {
    c.str(lic.license, "licensing.license", KNOWLEDGE_LIMITS.shortStringMaxChars);
    c.str(lic.dataPermission, "licensing.dataPermission", KNOWLEDGE_LIMITS.shortStringMaxChars);
  }

  if (input.related !== undefined) {
    c.list(input.related, "related", KNOWLEDGE_LIMITS.maxRelated).forEach((r, i) => {
      const o = c.obj(r, `related[${i}]`, ["id", "version"]);
      if (!o) return;
      c.str(o.id, `related[${i}].id`, KNOWLEDGE_LIMITS.shortStringMaxChars);
      if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) {
        c.err(`related[${i}].version`, "must be a positive integer");
      }
    });
  }

  // Payload: at least one structured or summary body.
  const hasFacts = input.facts !== undefined;
  const hasRecords = input.records !== undefined;
  const hasSummary = input.summary !== undefined;
  if (!hasFacts && !hasRecords && !hasSummary) {
    c.err("payload", "requires at least one of facts, records or summary");
  }
  if (hasFacts) {
    c.list(input.facts, "facts", KNOWLEDGE_LIMITS.maxFacts, 1).forEach((f, i) => {
      const o = c.obj(f, `facts[${i}]`, ["subject", "predicate", "value", "unit"]);
      if (!o) return;
      c.str(o.subject, `facts[${i}].subject`, KNOWLEDGE_LIMITS.shortStringMaxChars);
      c.str(o.predicate, `facts[${i}].predicate`, KNOWLEDGE_LIMITS.shortStringMaxChars);
      if (!Object.prototype.hasOwnProperty.call(o, "value"))
        c.err(`facts[${i}].value`, "is required");
      else c.scalar(o.value, `facts[${i}].value`);
      c.str(o.unit, `facts[${i}].unit`, KNOWLEDGE_LIMITS.shortStringMaxChars, { optional: true });
    });
  }
  if (hasRecords) {
    c.list(input.records, "records", KNOWLEDGE_LIMITS.maxRecords, 1).forEach((r, i) => {
      if (!isObj(r)) return c.err(`records[${i}]`, "must be an object");
      const keys = Object.keys(r);
      if (keys.length === 0) c.err(`records[${i}]`, "must not be empty");
      if (keys.length > KNOWLEDGE_LIMITS.maxRecordFields) {
        c.err(`records[${i}]`, `exceeds ${KNOWLEDGE_LIMITS.maxRecordFields} fields`);
      }
      for (const k of keys.slice(0, KNOWLEDGE_LIMITS.maxRecordFields)) {
        c.str(k, `records[${i}] key`, 64);
        c.scalar(r[k], `records[${i}].${k}`);
      }
    });
  }
  c.str(input.summary, "summary", KNOWLEDGE_LIMITS.summaryMaxChars, { optional: true });
  c.str(input.explanation, "explanation", KNOWLEDGE_LIMITS.explanationMaxChars, {
    optional: true,
  });

  c.list(input.sources, "sources", KNOWLEDGE_LIMITS.maxSources, 1).forEach((s, i) => {
    const p = `sources[${i}]`;
    const o = c.obj(s, p, ["uri", "accessedAt", "sourceDate", "hash", "snapshotRef"]);
    if (!o) return;
    c.uri(o.uri, `${p}.uri`);
    c.date(o.accessedAt, `${p}.accessedAt`);
    c.date(o.sourceDate, `${p}.sourceDate`, { optional: true });
    const h = c.obj(o.hash, `${p}.hash`, ["algorithm", "digest"]);
    if (h) {
      if (!(HASH_ALGORITHMS as readonly unknown[]).includes(h.algorithm)) {
        c.err(`${p}.hash.algorithm`, `must be one of: ${HASH_ALGORITHMS.join(", ")}`);
      }
      if (typeof h.digest !== "string" || !SHA256_HEX.test(h.digest)) {
        c.err(`${p}.hash.digest`, "must be 64 lowercase hex characters");
      }
    }
    c.str(o.snapshotRef, `${p}.snapshotRef`, KNOWLEDGE_LIMITS.uriMaxChars, { optional: true });
  });

  const rights = c.obj(input.rights, "rights", ["sourceLicense", "rightsHolder", "permittedUse"]);
  if (rights) {
    c.str(rights.sourceLicense, "rights.sourceLicense", KNOWLEDGE_LIMITS.shortStringMaxChars);
    c.str(rights.rightsHolder, "rights.rightsHolder", KNOWLEDGE_LIMITS.shortStringMaxChars, {
      optional: true,
    });
    if (!(PERMITTED_USES as readonly unknown[]).includes(rights.permittedUse)) {
      c.err("rights.permittedUse", `must be one of: ${PERMITTED_USES.join(", ")}`);
    }
  }

  const ver = c.obj(input.verification, "verification", ["method", "declaredConfidence"]);
  if (ver) {
    if (!(VERIFICATION_METHODS as readonly unknown[]).includes(ver.method)) {
      c.err("verification.method", `must be one of: ${VERIFICATION_METHODS.join(", ")}`);
    }
    const dc = ver.declaredConfidence;
    if (dc !== undefined && (typeof dc !== "number" || !(dc >= 0 && dc <= 1))) {
      c.err("verification.declaredConfidence", "must be a number from 0 to 1");
    }
  }
  c.date(input.asOf, "asOf");

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: input as unknown as KnowledgeContributionInput };
}
