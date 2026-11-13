import { describe, expect, it } from "vitest";
import type { ActorRef, AgentId, OperatorId } from "../../src/identity/types";
import type { ContributionId } from "../../src/registry/envelope";
import type { RetrievedContribution } from "../../src/registry/retrieval";
import {
  buildConditionalRetrievalResponse,
  RETRIEVAL_NOT_MODIFIED_KEYS,
  RETRIEVAL_NOT_MODIFIED_VERSION,
  type RetrievalValidator,
} from "../../src/registry/retrieval-conditional";
import {
  buildRetrievalResponse,
  RETRIEVAL_RESPONSE_VERSION,
} from "../../src/registry/retrieval-response";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../../src/seed/httpbin";

const actor = (n: string): ActorRef => ({
  agentId: `agent-${n}` as AgentId,
  operatorId: `op-${n}` as OperatorId,
});
const base = {
  id: "c-1",
  version: 3,
  previousVersion: 2,
  contentHash: "a".repeat(64),
  payloadBytes: 1234,
  author: actor("a"),
  contributor: actor("b"),
  contributionCreatedAt: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z",
  platformState: {
    lastVerifiedAt: "2026-11-05T00:00:00.000Z",
    reliabilityScore: 0.5,
    consumerCount: 4,
    updatedAt: "2026-11-06T00:00:00.000Z",
  },
  related: [{ family: "execution", id: "r-1" as ContributionId, version: 7 }],
} as const;

const EXPLANATION = "UNIQUE-EXPLANATION-TEXT";
const knowledge = (): RetrievedContribution => ({
  ...base,
  family: "knowledge",
  content: structuredClone({ ...HTTPBIN_KNOWLEDGE_SEED, explanation: EXPLANATION }),
});
const execution = (): RetrievedContribution => ({
  ...base,
  family: "execution",
  content: structuredClone(HTTPBIN_EXECUTION_SEED),
});
const validatorFor = (c: RetrievedContribution): RetrievalValidator => ({
  contributionId: c.id,
  version: c.version,
  contentHash: c.contentHash,
});

const isDeepFrozen = (v: unknown): boolean =>
  v === null ||
  typeof v !== "object" ||
  (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));

describe.each([
  ["knowledge", knowledge],
  ["execution", execution],
])("buildConditionalRetrievalResponse (%s)", (_name, make) => {
  it("returns only the minimal not-modified response on a full match", () => {
    const c = make();
    const res = buildConditionalRetrievalResponse(c, validatorFor(c));
    expect(res).toEqual({
      schemaVersion: RETRIEVAL_NOT_MODIFIED_VERSION,
      contributionId: "c-1",
      version: 3,
      contentHash: "a".repeat(64),
    });
    expect(Object.keys(res)).toEqual([...RETRIEVAL_NOT_MODIFIED_KEYS]);
    const json = JSON.stringify(res);
    for (const leaked of [
      EXPLANATION,
      "httpbin",
      "agent-a",
      "op-b",
      "2026-11",
      "reliabilityScore",
      "r-1",
      '"content"',
      '"family"',
    ]) {
      expect(json).not.toContain(leaked);
    }
    expect(isDeepFrozen(res)).toBe(true);
    expect(JSON.parse(json)).toEqual(res);
  });

  it.each([
    ["contributionId", { contributionId: "c-2" }],
    ["version", { version: 2 }],
    ["contentHash", { contentHash: "b".repeat(64) }],
    ["contentHash case", { contentHash: "A".repeat(64) }],
  ])("returns the complete response on %s mismatch", (_label, override) => {
    const c = make();
    const res = buildConditionalRetrievalResponse(c, { ...validatorFor(c), ...override });
    expect(res.schemaVersion).toBe(RETRIEVAL_RESPONSE_VERSION);
    expect(res).toEqual(buildRetrievalResponse(c));
  });

  it("returns the complete response when the validator is absent", () => {
    const c = make();
    for (const res of [
      buildConditionalRetrievalResponse(c),
      buildConditionalRetrievalResponse(c, undefined),
      buildConditionalRetrievalResponse(c, null),
    ]) {
      expect(res).toEqual(buildRetrievalResponse(c));
      expect(res.schemaVersion).toBe(RETRIEVAL_RESPONSE_VERSION);
    }
  });

  it("does not alias or mutate the validator", () => {
    const c = make();
    const v = Object.freeze(validatorFor(c));
    const res = buildConditionalRetrievalResponse(c, v);
    expect(res).not.toBe(v);
  });
});
