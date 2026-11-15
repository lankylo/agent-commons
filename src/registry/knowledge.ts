/**
 * Knowledge contribution schema (Phase 2). Validates untrusted contributor
 * input for the `knowledge` family within the shared envelope. Pure and
 * deterministic: no I/O, no storage, no LLM. Execution fields (steps, target
 * domains) are intentionally not part of this schema and are rejected.
 */
import { PLATFORM_ONLY_FIELDS, type ContributionEnvelopeInput } from "./envelope";
import { checkReviewInterval } from "./review-intervals";
import { checkContributionRefs } from "./references";
import { Checker, ISO_UTC, SHA256_HEX, isObj } from "./check";
import { HOSTNAME, isIanaSpecialUseHostname } from "./hostname";
import type { Schema } from "@cfworker/json-schema";
import {
  COMMON_CONTRIBUTION_REQUIRED,
  COMMON_CONTRIBUTION_SCHEMA_PROPERTIES,
  createJsonSchemaValidator,
} from "./schema-validation";

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

const scalarSchema: Schema = {
  oneOf: [
    { type: "string", minLength: 1, maxLength: KNOWLEDGE_LIMITS.shortStringMaxChars },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

export const KNOWLEDGE_CONTRIBUTION_JSON_SCHEMA: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [...COMMON_CONTRIBUTION_REQUIRED, "sources", "rights", "verification", "asOf"],
  properties: {
    ...COMMON_CONTRIBUTION_SCHEMA_PROPERTIES,
    family: { const: "knowledge" },
    related: COMMON_CONTRIBUTION_SCHEMA_PROPERTIES.related,
    facts: {
      type: "array",
      minItems: 1,
      maxItems: KNOWLEDGE_LIMITS.maxFacts,
      items: {
        type: "object",
        required: ["subject", "predicate", "value"],
        properties: {
          subject: {
            type: "string",
            minLength: 1,
            maxLength: KNOWLEDGE_LIMITS.shortStringMaxChars,
          },
          predicate: {
            type: "string",
            minLength: 1,
            maxLength: KNOWLEDGE_LIMITS.shortStringMaxChars,
          },
          value: scalarSchema,
          unit: { type: "string", minLength: 1, maxLength: KNOWLEDGE_LIMITS.shortStringMaxChars },
        },
        additionalProperties: false,
      },
    },
    records: {
      type: "array",
      minItems: 1,
      maxItems: KNOWLEDGE_LIMITS.maxRecords,
      items: {
        type: "object",
        minProperties: 1,
        maxProperties: KNOWLEDGE_LIMITS.maxRecordFields,
        propertyNames: { type: "string", minLength: 1, maxLength: 64 },
        additionalProperties: scalarSchema,
      },
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: KNOWLEDGE_LIMITS.summaryMaxChars,
    },
    explanation: {
      type: "string",
      minLength: 1,
      maxLength: KNOWLEDGE_LIMITS.explanationMaxChars,
    },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: KNOWLEDGE_LIMITS.maxSources,
      items: {
        type: "object",
        required: ["uri", "accessedAt", "hash"],
        properties: {
          uri: { type: "string", minLength: 1, maxLength: KNOWLEDGE_LIMITS.uriMaxChars },
          accessedAt: { type: "string", pattern: ISO_UTC.source },
          sourceDate: { type: "string", pattern: ISO_UTC.source },
          hash: {
            type: "object",
            required: ["algorithm", "digest"],
            properties: {
              algorithm: { enum: [...HASH_ALGORITHMS] },
              digest: { type: "string", pattern: SHA256_HEX.source },
            },
            additionalProperties: false,
          },
          snapshotRef: {
            type: "string",
            minLength: 1,
            maxLength: KNOWLEDGE_LIMITS.uriMaxChars,
          },
        },
        additionalProperties: false,
      },
    },
    rights: {
      type: "object",
      required: ["sourceLicense", "permittedUse"],
      properties: {
        sourceLicense: {
          type: "string",
          minLength: 1,
          maxLength: KNOWLEDGE_LIMITS.shortStringMaxChars,
        },
        rightsHolder: {
          type: "string",
          minLength: 1,
          maxLength: KNOWLEDGE_LIMITS.shortStringMaxChars,
        },
        permittedUse: { enum: [...PERMITTED_USES] },
      },
      additionalProperties: false,
    },
    verification: {
      type: "object",
      required: ["method"],
      properties: {
        method: { enum: [...VERIFICATION_METHODS] },
        declaredConfidence: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
    asOf: { type: "string", pattern: ISO_UTC.source },
  },
  additionalProperties: false,
  anyOf: [{ required: ["facts"] }, { required: ["records"] }, { required: ["summary"] }],
};

export const validateKnowledgeContributionJsonSchema = createJsonSchemaValidator(
  KNOWLEDGE_CONTRIBUTION_JSON_SCHEMA,
);

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

function publicHttpsUrl(c: Checker, value: unknown, path: string): void {
  const raw = c.str(value, path, KNOWLEDGE_LIMITS.uriMaxChars);
  if (raw === undefined) return;
  if (raw !== raw.trim() || !/^https:\/\//i.test(raw)) {
    c.err(path, "must be an absolute HTTPS URL without surrounding whitespace");
    return;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    c.err(path, "must be a valid absolute HTTPS URL");
    return;
  }
  if (url.protocol !== "https:") {
    c.err(path, "must use HTTPS");
    return;
  }
  const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@") || url.username !== "" || url.password !== "") {
    c.err(path, "must not contain embedded credentials");
    return;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("[") || /^\d+(?:\.\d+){0,3}$/.test(hostname)) {
    c.err(path, "must not use an IP literal");
    return;
  }
  if (isIanaSpecialUseHostname(hostname)) {
    c.err(path, "must not use an IANA Special-Use Domain Name or its subdomains");
    return;
  }
  if (!HOSTNAME.test(url.hostname)) {
    c.err(path, "must use a valid public DNS hostname");
  }
}

/** Validate untrusted input as a Knowledge contribution. Never throws. */
export function validateKnowledgeContribution(input: unknown): KnowledgeValidation {
  const schemaErrors = validateKnowledgeContributionJsonSchema(input);
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

  for (const e of checkReviewInterval("knowledge", input.contentType, input.reviewIntervalDays)) {
    if (e.path !== "contentType" || typeof input.contentType === "string") c.err(e.path, e.message);
  }

  c.list(input.evidence, "evidence", KNOWLEDGE_LIMITS.maxEvidence).forEach((e, i) => {
    const o = c.obj(e, `evidence[${i}]`, ["kind", "uri"]);
    if (!o) return;
    c.str(o.kind, `evidence[${i}].kind`, KNOWLEDGE_LIMITS.shortStringMaxChars);
    publicHttpsUrl(c, o.uri, `evidence[${i}].uri`);
  });

  const lic = c.obj(input.licensing, "licensing", ["license", "dataPermission"]);
  if (lic) {
    c.str(lic.license, "licensing.license", KNOWLEDGE_LIMITS.shortStringMaxChars);
    c.str(lic.dataPermission, "licensing.dataPermission", KNOWLEDGE_LIMITS.shortStringMaxChars);
  }

  if (input.related !== undefined) {
    checkContributionRefs(c, input.related, "related", "knowledge", KNOWLEDGE_LIMITS.maxRelated);
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
    publicHttpsUrl(c, o.uri, `${p}.uri`);
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
  if (schemaErrors.length > 0) return { ok: false, errors: schemaErrors };
  return { ok: true, value: input as unknown as KnowledgeContributionInput };
}
