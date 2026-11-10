/**
 * Knowledge contribution schema (Phase 2). Validates untrusted contributor
 * input for the `knowledge` family within the shared envelope. Pure and
 * deterministic: no I/O, no storage, no LLM. Execution fields (steps, target
 * domains) are intentionally not part of this schema and are rejected.
 */
import { PLATFORM_ONLY_FIELDS, type ContributionEnvelopeInput } from "./envelope";

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

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Checker {
  readonly errors: string[] = [];

  err(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }

  str(
    v: unknown,
    path: string,
    max: number,
    opts: { optional?: boolean } = {},
  ): string | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      this.err(path, "must be a non-empty string");
      return undefined;
    }
    if (v.length > max) this.err(path, `exceeds ${max} characters`);
    if (CONTROL_CHARS.test(v)) this.err(path, "contains control characters");
    return v;
  }

  uri(v: unknown, path: string): void {
    if (this.str(v, path, KNOWLEDGE_LIMITS.uriMaxChars) === undefined) return;
    try {
      if (new URL(v as string).protocol !== "https:") this.err(path, "must be an https URL");
    } catch {
      this.err(path, "must be a valid URL");
    }
  }

  date(v: unknown, path: string, opts: { optional?: boolean } = {}): void {
    if (v === undefined && opts.optional) return;
    if (typeof v !== "string" || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) {
      this.err(path, "must be an ISO 8601 UTC timestamp");
    }
  }

  scalar(v: unknown, path: string): void {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) this.err(path, "must be a finite number");
      return;
    }
    // Scalar strings are data values, not prose: held to the short-string cap.
    this.str(v, path, KNOWLEDGE_LIMITS.shortStringMaxChars);
  }

  list(v: unknown, path: string, max: number, min = 0): unknown[] {
    if (!Array.isArray(v)) {
      this.err(path, "must be an array");
      return [];
    }
    if (v.length > max) this.err(path, `exceeds ${max} items`);
    if (v.length < min) this.err(path, `requires at least ${min} item(s)`);
    return v.slice(0, max);
  }

  obj(v: unknown, path: string, keys: readonly string[]): Obj | undefined {
    if (!isObj(v)) {
      this.err(path, "must be an object");
      return undefined;
    }
    for (const k of Object.keys(v))
      if (!keys.includes(k)) this.err(`${path}.${k}`, "unknown field");
    return v;
  }
}

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
