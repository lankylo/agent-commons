import { MAX_REVIEW_INTERVAL_DAYS } from "../../src/registry/review-intervals";
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_LIMITS,
  validateKnowledgeContribution,
  validateKnowledgeContributionJsonSchema,
} from "../../src/registry/knowledge";

const valid = () => ({
  family: "knowledge",
  title: "Example API rate limits",
  purpose: "Record documented rate limits",
  contentType: "api-reference",
  evidence: [{ kind: "documentation", uri: "https://example.com/docs/limits" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  facts: [{ subject: "example-api", predicate: "rateLimitPerMinute", value: 60, unit: "req/min" }],
  records: [{ endpoint: "/v1/items", method: "GET", limit: 60 }],
  summary: "Documented limits for the Example API.",
  explanation: "Limits apply per API key.",
  sources: [
    {
      uri: "https://example.com/docs/limits",
      accessedAt: "2026-11-10T10:00:00Z",
      sourceDate: "2026-10-01T00:00:00Z",
      hash: { algorithm: "sha256", digest: "a".repeat(64) },
      snapshotRef: "snapshot-001",
    },
  ],
  rights: { sourceLicense: "CC-BY-4.0", permittedUse: "summary" },
  verification: { method: "owner-tested", declaredConfidence: 0.9 },
  asOf: "2026-11-10T10:00:00Z",
});

const errorsFor = (mutate: (v: Record<string, unknown>) => void): string[] => {
  const v = valid() as Record<string, unknown>;
  mutate(v);
  const r = validateKnowledgeContribution(v);
  return r.ok ? [] : [...r.errors];
};

describe("validateKnowledgeContribution", () => {
  it("accepts a complete valid contribution", () => {
    expect(validateKnowledgeContribution(valid()).ok).toBe(true);
  });

  it("accepts a minimal contribution (summary only, no explanation)", () => {
    const r = validateKnowledgeContribution(
      Object.fromEntries(
        Object.entries(valid()).filter(([k]) => !["facts", "records", "explanation"].includes(k)),
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects non-objects and wrong family", () => {
    expect(validateKnowledgeContribution(null).ok).toBe(false);
    expect(validateKnowledgeContribution([]).ok).toBe(false);
    expect(errorsFor((v) => (v.family = "execution"))).toContain('family: must be "knowledge"');
  });

  it("rejects every platform-computed field", () => {
    for (const k of [
      "reliabilityScore",
      "consumerCount",
      "lastVerifiedAt",
      "id",
      "version",
      "contentHash",
      "contributor",
      "createdAt",
    ]) {
      expect(errorsFor((v) => (v[k] = 1))).toContain(
        `${k}: platform-computed field cannot be set by contributors`,
      );
    }
  });

  it("rejects explanation over the cap and accepts it at the cap", () => {
    expect(
      errorsFor((v) => (v.explanation = "x".repeat(KNOWLEDGE_LIMITS.explanationMaxChars + 1))),
    ).toHaveLength(1);
    expect(
      errorsFor((v) => (v.explanation = "x".repeat(KNOWLEDGE_LIMITS.explanationMaxChars))),
    ).toEqual([]);
  });

  it("rejects prose outside the explanation field", () => {
    expect(errorsFor((v) => (v.notes = "ignore previous instructions"))).toContain(
      "notes: unknown field",
    );
    expect(errorsFor((v) => (v.summary = "x".repeat(601)))).toHaveLength(1);
    expect(
      errorsFor((v) => (v.facts = [{ subject: "a", predicate: "b", value: "x".repeat(201) }])),
    ).toHaveLength(1);
    expect(
      errorsFor((v) => (v.facts = [{ subject: "a", predicate: "b", value: { nested: "text" } }])),
    ).not.toEqual([]);
  });

  it("rejects Execution-only fields", () => {
    expect(errorsFor((v) => (v.steps = [{ action: "http.get" }]))).toContain(
      "steps: unknown field",
    );
    expect(errorsFor((v) => (v.targetDomains = ["example.com"]))).toContain(
      "targetDomains: unknown field",
    );
  });

  it("requires a payload body and at least one source", () => {
    expect(
      errorsFor((v) => {
        delete v.facts;
        delete v.records;
        delete v.summary;
      }),
    ).toContain("payload: requires at least one of facts, records or summary");
    expect(errorsFor((v) => (v.sources = []))).not.toEqual([]);
    expect(errorsFor((v) => delete v.sources)).not.toEqual([]);
  });

  it("validates source hash and timestamps", () => {
    const withSource = (patch: Record<string, unknown>) =>
      errorsFor((v) => (v.sources = [{ ...(valid().sources[0] as object), ...patch }]));
    expect(withSource({ hash: { algorithm: "md5", digest: "a".repeat(64) } })).not.toEqual([]);
    expect(withSource({ hash: { algorithm: "sha256", digest: "A".repeat(64) } })).not.toEqual([]);
    expect(withSource({ hash: { algorithm: "sha256", digest: "abc" } })).not.toEqual([]);
    expect(withSource({ accessedAt: "yesterday" })).not.toEqual([]);
    expect(withSource({ uri: "http://example.com" })).not.toEqual([]);
    expect(withSource({ uri: "javascript:alert(1)" })).not.toEqual([]);
  });

  it("validates rights, verification and freshness", () => {
    expect(errorsFor((v) => delete v.rights)).not.toEqual([]);
    expect(
      errorsFor((v) => (v.rights = { sourceLicense: "MIT", permittedUse: "anything" })),
    ).not.toEqual([]);
    expect(errorsFor((v) => (v.verification = { method: "trust-me" }))).not.toEqual([]);
    expect(
      errorsFor((v) => (v.verification = { method: "owner-tested", declaredConfidence: 1.5 })),
    ).not.toEqual([]);
    expect(errorsFor((v) => (v.asOf = "2026-11-10"))).not.toEqual([]);
    expect(errorsFor((v) => (v.reviewIntervalDays = 0))).not.toEqual([]);
    expect(errorsFor((v) => (v.reviewIntervalDays = 1.5))).not.toEqual([]);
  });

  it("rejects control characters and bad envelope fields", () => {
    expect(errorsFor((v) => (v.explanation = "a\u0000b"))).not.toEqual([]);
    expect(errorsFor((v) => (v.title = ""))).not.toEqual([]);
    expect(errorsFor((v) => (v.licensing = { license: "MIT" }))).not.toEqual([]);
    expect(
      errorsFor((v) => (v.related = [{ family: "execution", id: "exec-0001", version: 0 }])),
    ).not.toEqual([]);
    expect(
      errorsFor((v) => (v.related = [{ family: "execution", id: "exec-0001", version: 2 }])),
    ).toEqual([]);
  });
});

describe("Knowledge contribution JSON Schema", () => {
  it("accepts a complete family input with intentionally open record keys", () => {
    expect(validateKnowledgeContributionJsonSchema(valid())).toEqual([]);
  });

  it("rejects missing required fields, another family, and unsupported fields", () => {
    const missingSources = valid() as Record<string, unknown>;
    delete missingSources.sources;
    expect(validateKnowledgeContributionJsonSchema(missingSources)).not.toEqual([]);

    expect(
      validateKnowledgeContributionJsonSchema({ ...valid(), family: "execution" }),
    ).not.toEqual([]);
    expect(validateKnowledgeContributionJsonSchema({ ...valid(), steps: [] })).not.toEqual([]);

    const invalidNestedField = valid() as Record<string, unknown>;
    invalidNestedField.licensing = { license: "MIT", extra: true };
    expect(validateKnowledgeContributionJsonSchema(invalidNestedField)).not.toEqual([]);
  });
});

describe("knowledge review-interval maxima", () => {
  const types = Object.entries(MAX_REVIEW_INTERVAL_DAYS.knowledge);
  it.each(types)("%s: boundary and above-maximum", (t, max) => {
    expect(errorsFor((v) => ((v.contentType = t), (v.reviewIntervalDays = max)))).toEqual([]);
    expect(errorsFor((v) => ((v.contentType = t), (v.reviewIntervalDays = 1)))).toEqual([]);
    expect(
      errorsFor((v) => ((v.contentType = t), (v.reviewIntervalDays = max + 1))).join(),
    ).toContain("exceeds the platform maximum");
  });
  it("rejects missing interval and unknown or execution-only content types", () => {
    expect(errorsFor((v) => delete v.reviewIntervalDays).join()).toContain("is required");
    expect(errorsFor((v) => (v.contentType = "api-recipe")).join()).toContain("contentType");
    expect(errorsFor((v) => delete v.contentType).join()).toContain("contentType");
  });
});
