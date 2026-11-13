/**
 * Deterministic, offline response-size tests for the Phase 3 discovery and retrieval contracts.
 * Sizes are exact UTF-8 bytes of `JSON.stringify` measured with `TextEncoder` (the convention of
 * the budget modules). Bytes are only a deterministic proxy for token cost, not a token count.
 * Measured values are pinned and mirrored in docs/response-sizes.md.
 */
import { describe, expect, it } from "vitest";
import type { ActorRef, AgentId, OperatorId } from "../../src/identity/types";
import { buildDiscoveryResponse } from "../../src/registry/discovery";
import { budgetDiscoveryResponse } from "../../src/registry/discovery-budget";
import type { ContributionId } from "../../src/registry/envelope";
import {
  validateExecutionContribution,
  type ExecutionContributionInput,
} from "../../src/registry/execution";
import {
  validateKnowledgeContribution,
  type KnowledgeContributionInput,
} from "../../src/registry/knowledge";
import type { RetrievedContribution } from "../../src/registry/retrieval";
import { budgetRetrievalResponse } from "../../src/registry/retrieval-budget";
import { buildConditionalRetrievalResponse } from "../../src/registry/retrieval-conditional";
import { buildRetrievalResponse } from "../../src/registry/retrieval-response";
import type { SearchResultItem } from "../../src/registry/search";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../../src/seed/httpbin";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

const actor = (n: string): ActorRef => ({
  agentId: `agent-${n}` as AgentId,
  operatorId: `op-${n}` as OperatorId,
});
const base = {
  id: "01JCOMMONS0000000000000001",
  version: 3,
  previousVersion: 2,
  contentHash: "a".repeat(64),
  payloadBytes: 1234,
  author: actor("a"),
  contributor: actor("b"),
  contributionCreatedAt: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z",
  platformState: {
    lastVerifiedAt: null,
    reliabilityScore: null,
    consumerCount: 0,
    updatedAt: "2026-11-06T00:00:00.000Z",
  },
  related: [{ family: "execution", id: "r-1" as ContributionId, version: 7 }],
} as const;

// Multibyte text: 2-byte (Latin/Greek), 3-byte (CJK) and 4-byte (emoji) UTF-8 sequences.
const MULTIBYTE = "Café Ωμέγα 日本語のテキスト 🚀";

function larger<T>(r: { ok: true; value: T } | { ok: false; errors: readonly string[] }): T {
  if (!r.ok) throw new Error(`fixture invalid: ${r.errors.join("; ")}`);
  return r.value;
}

const LARGE_KNOWLEDGE: KnowledgeContributionInput = larger(
  validateKnowledgeContribution({
    ...HTTPBIN_KNOWLEDGE_SEED,
    title: `Large reference ${MULTIBYTE}`,
    facts: Array.from({ length: 100 }, (_, i) => ({
      subject: `Subject ${i} ${MULTIBYTE}`,
      predicate: `predicate${i}`,
      value: `value ${i} ${MULTIBYTE}`,
      unit: "unit",
    })),
    records: Array.from({ length: 100 }, (_, i) =>
      Object.fromEntries(
        Array.from({ length: 10 }, (_, j) => [`field${j}`, `r${i} f${j} ${MULTIBYTE}`]),
      ),
    ),
    summary: `${MULTIBYTE} `.repeat(20).slice(0, 600),
    explanation: MULTIBYTE.repeat(40).slice(0, 1000),
  }),
);

const LARGE_EXECUTION: ExecutionContributionInput = larger(
  validateExecutionContribution({
    ...HTTPBIN_EXECUTION_SEED,
    // Execution literals are ASCII-only by schema, so multibyte text appears in free-text fields.
    title: `Large recipe ${MULTIBYTE}`,
    purpose: `${MULTIBYTE} `.repeat(10).slice(0, 300),
    objective: `${MULTIBYTE} `.repeat(10).slice(0, 300),
    steps: [
      HTTPBIN_EXECUTION_SEED.steps[0],
      ...Array.from({ length: 24 }, (_, i) => ({
        id: `extract${i}`,
        type: "extract_field",
        from: "response",
        pointer: "/args/agent_commons",
        saveAs: `v${i}`,
      })),
      ...Array.from({ length: 25 }, (_, i) => ({
        id: `assert${i}`,
        type: "assert",
        source: { variable: `v${i % 24}` },
        operator: "equals",
        expected: "seed-v1",
      })),
    ],
    outputs: [{ name: "echoedValue", type: "string", variable: "v0" }],
    successChecks: ["assert24"],
  }),
);

const knowledge = (content: KnowledgeContributionInput): RetrievedContribution => ({
  ...base,
  family: "knowledge",
  content: structuredClone(content),
});
const execution = (content: ExecutionContributionInput): RetrievedContribution => ({
  ...base,
  family: "execution",
  content: structuredClone(content),
});

const FIXTURES = {
  "httpbin Knowledge": knowledge(HTTPBIN_KNOWLEDGE_SEED),
  "httpbin Execution": execution(HTTPBIN_EXECUTION_SEED),
  "large Knowledge": knowledge(LARGE_KNOWLEDGE),
  "large Execution": execution(LARGE_EXECUTION),
};

const item = (id: string, over: Partial<SearchResultItem> = {}): SearchResultItem => ({
  id,
  version: 1,
  family: "knowledge",
  contentType: "api-reference",
  title: `Title ${id}`,
  purpose: "Purpose",
  asOf: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z",
  reviewIntervalDays: 30,
  lastVerifiedAt: null,
  reliabilityScore: null,
  consumerCount: 0,
  freshness: "current",
  reviewDueAt: null,
  related: [{ family: "execution", id: "r-1" as ContributionId, version: 7 }],
  ...over,
});

const discoveryItem = (i: number): SearchResultItem =>
  item(`01JCOMMONS${String(i).padStart(16, "0")}`, {
    family: i % 2 === 0 ? "knowledge" : "execution",
    contentType: i % 2 === 0 ? "api-reference" : "diagnostic-recipe",
    title: `Result ${i} ${MULTIBYTE}`,
    purpose: `Purpose ${i} ${MULTIBYTE} `.repeat(3).slice(0, 300),
  });
const RANKED = Array.from({ length: 10 }, (_, i) => discoveryItem(i));
const HTTPBIN_DISCOVERY = [
  item("k1", { title: HTTPBIN_KNOWLEDGE_SEED.title, purpose: HTTPBIN_KNOWLEDGE_SEED.purpose }),
  item("e1", {
    family: "execution",
    contentType: "diagnostic-recipe",
    title: HTTPBIN_EXECUTION_SEED.title,
    purpose: HTTPBIN_EXECUTION_SEED.purpose,
    reviewIntervalDays: 30,
  }),
];

describe("fixtures", () => {
  it("contain meaningful multibyte text (UTF-8 bytes exceed UTF-16 code units)", () => {
    for (const text of [
      LARGE_KNOWLEDGE.title,
      LARGE_KNOWLEDGE.explanation ?? "",
      LARGE_EXECUTION.title,
    ]) {
      expect(new TextEncoder().encode(text).length).toBeGreaterThan(text.length);
    }
    const json = JSON.stringify(buildRetrievalResponse(FIXTURES["large Knowledge"]));
    expect(bytes(json)).toBeGreaterThan(json.length);
  });
});

describe("measured serialized sizes (exact UTF-8 bytes)", () => {
  it("discovery-response/v1", () => {
    expect({
      empty: bytes(buildDiscoveryResponse([])),
      httpbinTwoResults: bytes(buildDiscoveryResponse(HTTPBIN_DISCOVERY)),
      tenMultibyteResults: bytes(buildDiscoveryResponse(RANKED)),
      perResultAverage: bytes(buildDiscoveryResponse(RANKED)) / 10,
    }).toEqual(DISCOVERY_SIZES);
  });

  it("complete retrieval-response/v1", () => {
    const sizes = Object.fromEntries(
      Object.entries(FIXTURES).map(([k, c]) => [k, bytes(buildRetrievalResponse(c))]),
    );
    expect(sizes).toEqual(RETRIEVAL_SIZES);
  });

  it("retrieval-not-modified/v1 is constant-size and far smaller than full responses", () => {
    const notModified = Object.entries(FIXTURES).map(([name, c]) => {
      const r = buildConditionalRetrievalResponse(c, {
        contributionId: c.id,
        version: c.version,
        contentHash: c.contentHash,
      });
      expect(r.schemaVersion).toBe("retrieval-not-modified/v1");
      const full = bytes(buildRetrievalResponse(c));
      const nm = bytes(r);
      return { name, full, nm, saved: full - nm };
    });
    expect(new Set(notModified.map((x) => x.nm)).size).toBe(1);
    expect(Object.fromEntries(notModified.map((x) => [x.name, [x.nm, x.saved]]))).toEqual(
      NOT_MODIFIED_SIZES,
    );
    for (const x of notModified) expect(x.nm).toBeLessThan(x.full / 2);
  });

  it("mismatched or absent validators return the full response", () => {
    const c = FIXTURES["large Execution"];
    const wrong = { contributionId: c.id, version: c.version, contentHash: "b".repeat(64) };
    for (const v of [wrong, null, undefined]) {
      expect(bytes(buildConditionalRetrievalResponse(c, v))).toBe(bytes(buildRetrievalResponse(c)));
    }
  });
});

describe("retrieval budget boundaries", () => {
  it.each(Object.entries(FIXTURES))(
    "%s: accepted at exactly the size, rejected one byte below, never truncated",
    (_name, c) => {
      const full = buildRetrievalResponse(c);
      const size = bytes(full);
      const fit = budgetRetrievalResponse(c, size);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.budget).toEqual({ maxUtf8Bytes: size, usedUtf8Bytes: size });
      expect(fit.response).toEqual(full);

      const small = budgetRetrievalResponse(c, size - 1);
      expect(small.ok).toBe(false);
      if (small.ok) return;
      expect(small.error).toEqual({
        code: "response_too_large",
        message: expect.any(String),
        maxUtf8Bytes: size - 1,
        requiredUtf8Bytes: size,
      });
      expect("response" in small).toBe(false);
    },
  );

  it("returns the full untrusted explanation byte-for-byte when it fits", () => {
    const r = budgetRetrievalResponse(FIXTURES["large Knowledge"], 1_000_000);
    expect(r.ok).toBe(true);
    if (!r.ok || r.response.family !== "knowledge") return;
    expect(r.response.untrustedExplanation?.text).toBe(LARGE_KNOWLEDGE.explanation);
  });
});

describe("discovery budget boundaries", () => {
  const sizeOfPrefix = (k: number) => bytes(buildDiscoveryResponse(RANKED.slice(0, k)));

  it("accepts exactly the full size and drops only the last result one byte below", () => {
    const full = sizeOfPrefix(10);
    const fit = budgetDiscoveryResponse(RANKED, full);
    expect(fit.ok && fit.budget).toEqual({
      maxUtf8Bytes: full,
      usedUtf8Bytes: full,
      omittedResultCount: 0,
    });
    const below = budgetDiscoveryResponse(RANKED, full - 1);
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.response.results.map((r) => r.contributionId)).toEqual(
      RANKED.slice(0, 9).map((r) => r.id),
    );
    expect(below.budget).toEqual({
      maxUtf8Bytes: full - 1,
      usedUtf8Bytes: sizeOfPrefix(9),
      omittedResultCount: 1,
    });
  });

  it("retains the largest ranked prefix at every prefix boundary, in order, untruncated", () => {
    for (let k = 0; k <= 10; k++) {
      const exact = budgetDiscoveryResponse(RANKED, sizeOfPrefix(k));
      expect(exact.ok).toBe(true);
      if (!exact.ok) continue;
      expect(exact.response).toEqual(buildDiscoveryResponse(RANKED.slice(0, k)));
      expect(exact.budget.omittedResultCount).toBe(10 - k);
      expect(exact.budget.usedUtf8Bytes).toBe(sizeOfPrefix(k));
      if (k > 0) {
        const below = budgetDiscoveryResponse(RANKED, sizeOfPrefix(k) - 1);
        expect(below.ok && below.response.resultCount).toBe(k - 1);
      }
    }
  });

  it("does not skip an oversized result to fit a later smaller one", () => {
    const list = [RANKED[0]!, discoveryItem(99), RANKED[1]!];
    list[1] = { ...list[1]!, purpose: MULTIBYTE.repeat(10).slice(0, 300) };
    const max = bytes(buildDiscoveryResponse([list[0]!])) + 5;
    const r = budgetDiscoveryResponse(list, max);
    expect(r.ok && r.response.results.map((x) => x.contributionId)).toEqual([list[0]!.id]);
  });

  it("reports budget_too_small below the empty response and accepts it exactly", () => {
    const empty = bytes(buildDiscoveryResponse([]));
    const ok = budgetDiscoveryResponse(RANKED, empty);
    expect(ok.ok && ok.response.resultCount).toBe(0);
    const bad = budgetDiscoveryResponse(RANKED, empty - 1);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("budget_too_small");
  });
});

// Pinned measurements (exact UTF-8 bytes); mirrored in docs/response-sizes.md.
const DISCOVERY_SIZES = {
  empty: 70,
  httpbinTwoResults: 873,
  tenMultibyteResults: 5670,
  perResultAverage: 567,
};
const RETRIEVAL_SIZES = {
  "httpbin Knowledge": 2206,
  "httpbin Execution": 2071,
  "large Knowledge": 87385,
  "large Execution": 7770,
};
/** [not-modified bytes, bytes saved versus the full response]. */
const NOT_MODIFIED_SIZES = {
  "httpbin Knowledge": [184, 2022],
  "httpbin Execution": [184, 1887],
  "large Knowledge": [184, 87201],
  "large Execution": [184, 7586],
};
