import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  hashContribution,
  hashValidatedContribution,
  sha256Hex,
} from "../../src/registry/content-hash";
import { validateKnowledgeContribution } from "../../src/registry/knowledge";

type Rec = Record<string, unknown>;

const validKnowledge = () => ({
  family: "knowledge",
  title: "Example API rate limits",
  purpose: "Record documented rate limits",
  contentType: "api-reference",
  evidence: [{ kind: "documentation", uri: "https://httpbin.org/docs/limits" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  facts: [{ subject: "example-api", predicate: "rateLimitPerMinute", value: 60, unit: "req/min" }],
  records: [{ endpoint: "/v1/items", method: "GET", limit: 60 }],
  summary: "Documented limits for the Example API.",
  explanation: "Limits apply per API key.",
  sources: [
    {
      uri: "https://httpbin.org/docs/limits",
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

const validExecution = (): Rec => ({
  family: "execution",
  title: "Fetch an item from Example API",
  purpose: "Retrieve an item and confirm it exists",
  contentType: "api-recipe",
  evidence: [{ kind: "documentation", uri: "https://example.com/docs/items" }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  related: [{ family: "knowledge", id: "know-0001", version: 1 }],
  objective: "Fetch an item by id and verify its status",
  inputs: [
    { name: "itemId", type: "string", required: true },
    { name: "kind", type: "string", required: false, allowedValues: ["a", "b"] },
  ],
  outputs: [{ name: "status", type: "string", variable: "itemStatus" }],
  targetDomains: ["api.acme.com"],
  compatibility: {
    requiredCapabilities: ["http-client", "json-parsing"],
    targetVersions: [{ domain: "api.acme.com", version: "v1" }],
  },
  steps: [
    {
      id: "fetch",
      type: "http_request",
      method: "GET",
      domain: "api.acme.com",
      path: "/v1/items",
      query: { id: { input: "itemId" }, expand: { literal: "none" } },
      expectStatus: [200],
      saveAs: "itemBody",
    },
    { id: "pause", type: "wait", seconds: 1 },
    {
      id: "pick",
      type: "extract_field",
      from: "itemBody",
      pointer: "/status",
      saveAs: "itemStatus",
    },
    {
      id: "check",
      type: "assert",
      source: { variable: "itemStatus" },
      operator: "equals",
      expected: "active",
    },
  ],
  successChecks: ["check"],
  safety: {
    sideEffect: "read-only",
    requiresHumanApproval: false,
    maxRequests: 1,
    timeoutSeconds: 30,
    onFailure: "stop",
  },
  verification: {
    method: "owner-tested",
    testedAt: "2026-11-10T10:00:00Z",
    declaredConfidence: 0.8,
  },
  asOf: "2026-11-10T10:00:00Z",
});

const HEX64 = /^[0-9a-f]{64}$/;
const hashOf = async (v: unknown): Promise<string> => {
  const r = await hashContribution(v);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.hash;
};
const reversed = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reversed)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Rec)
            .reverse()
            .map(([k, x]) => [k, reversed(x)]),
        )
      : v;

describe("canonicalJson", () => {
  it("sorts keys recursively and removes whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
  it("omits undefined members and normalizes -0", () => {
    expect(canonicalJson({ a: undefined, b: -0 })).toBe('{"b":0}');
  });
  it("emits Unicode strings without normalization or escaping of non-ASCII", () => {
    expect(canonicalJson({ é: "日本語 😀" })).toBe('{"é":"日本語 😀"}');
    expect(canonicalJson("\u00e9")).not.toBe(canonicalJson("e\u0301"));
  });
  it("rejects non-JSON values", () => {
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
});

describe("hashContribution", () => {
  it("returns a lowercase 64-char hex digest, stable across calls", async () => {
    const a = await hashOf(validKnowledge());
    expect(a).toMatch(HEX64);
    expect(await hashOf(validKnowledge())).toBe(a);
    expect(await hashOf(validExecution())).toMatch(HEX64);
  });

  it("sha256Hex matches the standard test vector and hashes UTF-8 bytes", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });

  it("is independent of object-key insertion order, including nested keys", async () => {
    expect(await hashOf(reversed(validKnowledge()))).toBe(await hashOf(validKnowledge()));
    expect(await hashOf(reversed(validExecution()))).toBe(await hashOf(validExecution()));
  });

  it("changes when meaningful content changes", async () => {
    const base = await hashOf(validKnowledge());
    const k = validKnowledge();
    k.title = "Example API rate limits!";
    expect(await hashOf(k)).not.toBe(base);
    const k2 = validKnowledge();
    k2.facts[0]!.value = 61;
    expect(await hashOf(k2)).not.toBe(base);
  });

  it("changes when array order changes", async () => {
    const base = await hashOf(validExecution());
    const e = validExecution();
    const steps = e.steps as Rec[];
    e.steps = [steps[1], steps[0], ...steps.slice(2)];
    expect(await hashOf(e)).not.toBe(base);
  });

  it("hashes Unicode content deterministically and distinguishes it", async () => {
    const a = validKnowledge();
    a.summary = "Limite de débit — 日本語 😀";
    const b = validKnowledge();
    b.summary = "Limite de de\u0301bit — 日本語 😀";
    expect(await hashOf(a)).toBe(await hashOf(structuredClone(a)));
    expect(await hashOf(a)).not.toBe(await hashOf(b));
  });

  it("separates families: the family is part of the hashed content", async () => {
    const shared = { family: "knowledge", x: 1 };
    const a = await hashValidatedContribution(shared as { family: "knowledge" });
    const b = await hashValidatedContribution({ ...shared, family: "execution" } as {
      family: "execution";
    });
    expect(a).not.toBe(b);
    expect(await hashOf(validKnowledge())).not.toBe(await hashOf(validExecution()));
  });

  it("excludes platform-assigned fields when hashing validated content", async () => {
    const r = validateKnowledgeContribution(validKnowledge());
    if (!r.ok) throw new Error("fixture invalid");
    const base = await hashValidatedContribution(r.value);
    const stored = {
      ...r.value,
      id: "know-0001",
      version: 3,
      contentHash: "f".repeat(64),
      contributor: { agentId: "a", operatorId: "o" },
      createdAt: "2026-11-11T00:00:00Z",
      lastVerifiedAt: "2026-11-11T00:00:00Z",
      reliabilityScore: 0.9,
      consumerCount: 4,
    };
    expect(await hashValidatedContribution(stored)).toBe(base);
  });

  it("never hashes invalid input, including platform fields in submissions", async () => {
    const withId = { ...validKnowledge(), id: "know-1" };
    const r = await hashContribution(withId);
    expect(r.ok).toBe(false);
    expect((await hashContribution({ ...validExecution(), version: 2 })).ok).toBe(false);
    expect((await hashContribution({ ...validKnowledge(), extra: 1 })).ok).toBe(false);
    expect((await hashContribution({ ...validKnowledge(), family: "other" })).ok).toBe(false);
    expect((await hashContribution(null)).ok).toBe(false);
    expect((await hashContribution("x")).ok).toBe(false);
  });
});
