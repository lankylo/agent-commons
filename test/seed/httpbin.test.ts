import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashContribution, sha256Hex } from "../../src/registry/content-hash";
import type { ContributionId } from "../../src/registry/envelope";
import { validateExecutionContribution } from "../../src/registry/execution";
import { validateKnowledgeContribution } from "../../src/registry/knowledge";
import {
  HTTPBIN_EXECUTION_SEED,
  HTTPBIN_KNOWLEDGE_SEED,
  HTTPBIN_SEED_PROVENANCE,
  HTTPBIN_SNAPSHOT_PATH,
  HTTPBIN_SNAPSHOT_SHA256,
  executionWithKnowledgeRef,
} from "../../src/seed/httpbin";
import { checkHttpbinResponse } from "../../src/seed/httpbin-live-check";

const goodBody = JSON.stringify({
  url: "https://httpbin.org/get?agent_commons=seed-v1",
  args: { agent_commons: "seed-v1" },
  headers: { Host: "httpbin.org" },
  origin: "203.0.113.1",
});

describe("httpbin seed fixtures (offline)", () => {
  it("validates the Knowledge fixture", () => {
    expect(validateKnowledgeContribution(HTTPBIN_KNOWLEDGE_SEED)).toMatchObject({ ok: true });
  });

  it("validates the Execution fixture, targeting only httpbin.org", () => {
    expect(validateExecutionContribution(HTTPBIN_EXECUTION_SEED)).toMatchObject({ ok: true });
    expect(HTTPBIN_EXECUTION_SEED.targetDomains).toEqual(["httpbin.org"]);
  });

  it("validates once the Knowledge reference is added", () => {
    const ref = { family: "knowledge", id: "a".repeat(32) as ContributionId, version: 1 } as const;
    const withRef = executionWithKnowledgeRef(ref);
    expect(validateExecutionContribution(withRef).ok).toBe(true);
    expect(withRef.related).toEqual([ref]);
    expect(HTTPBIN_EXECUTION_SEED.related).toBeUndefined();
  });

  it("records ISC licence and cites docs and source", () => {
    expect(HTTPBIN_KNOWLEDGE_SEED.rights.sourceLicense).toBe("ISC");
    expect(HTTPBIN_KNOWLEDGE_SEED.licensing.license).toBe("ISC");
    expect(HTTPBIN_KNOWLEDGE_SEED.evidence.map((e) => e.uri)).toEqual(
      expect.arrayContaining(["https://httpbin.org/"]),
    );
    expect(HTTPBIN_KNOWLEDGE_SEED.evidence.some((e) => e.kind === "source-code")).toBe(true);
  });

  it("matches the checked-in snapshot's SHA-256 digest", async () => {
    const text = readFileSync(HTTPBIN_SNAPSHOT_PATH, "utf8");
    expect(await sha256Hex(text)).toBe(HTTPBIN_SNAPSHOT_SHA256);
    expect(HTTPBIN_KNOWLEDGE_SEED.sources[0]).toMatchObject({
      snapshotRef: HTTPBIN_SNAPSHOT_PATH,
      hash: { algorithm: "sha256", digest: HTTPBIN_SNAPSHOT_SHA256 },
    });
    for (const field of ["url", "args", "headers", "origin"]) expect(text).toContain(`"${field}"`);
  });

  it("detects a changed snapshot", async () => {
    const text = readFileSync(HTTPBIN_SNAPSHOT_PATH, "utf8");
    expect(await sha256Hex(text + "\n")).not.toBe(HTTPBIN_SNAPSHOT_SHA256);
  });

  it("has deterministic content hashes, independent of key order", async () => {
    const k1 = await hashContribution(HTTPBIN_KNOWLEDGE_SEED);
    const e1 = await hashContribution(HTTPBIN_EXECUTION_SEED);
    expect(k1).toMatchObject({ ok: true });
    expect(e1).toMatchObject({ ok: true });
    const reordered = Object.fromEntries(Object.entries(HTTPBIN_KNOWLEDGE_SEED).reverse());
    expect(await hashContribution(reordered)).toEqual(k1);
    expect(await hashContribution(structuredClone(HTTPBIN_EXECUTION_SEED))).toEqual(e1);
    expect(JSON.stringify(k1)).not.toEqual(JSON.stringify(e1));
  });

  it("labels the Execution fixture owner-tested only with a recorded passing live run", () => {
    const live = HTTPBIN_SEED_PROVENANCE.liveVerification;
    expect(live.result).toBe("passed");
    expect(HTTPBIN_EXECUTION_SEED.verification).toEqual({
      method: "owner-tested",
      testedAt: live.verifiedAt,
    });
  });
});

describe("checkHttpbinResponse (offline)", () => {
  it("accepts the expected response", () => {
    expect(checkHttpbinResponse(200, goodBody)).toEqual({ ok: true });
  });
  it("reports rate limiting clearly", () => {
    expect(checkHttpbinResponse(429, "")).toMatchObject({ ok: false, kind: "rate_limited" });
    expect(checkHttpbinResponse(503, "")).toMatchObject({ ok: false, kind: "rate_limited" });
  });
  it.each([
    ["non-200", 404, goodBody],
    ["invalid JSON", 200, "<html>"],
    ["non-object JSON", 200, "[]"],
    ["missing field", 200, JSON.stringify({ url: "u", args: {}, headers: {} })],
    [
      "wrong arg value",
      200,
      JSON.stringify({ url: "u", args: { agent_commons: "x" }, headers: {}, origin: "o" }),
    ],
    [
      "wrong field type",
      200,
      JSON.stringify({ url: 1, args: { agent_commons: "seed-v1" }, headers: {}, origin: "o" }),
    ],
  ])("rejects %s", (_n, status, body) => {
    expect(checkHttpbinResponse(status, body)).toMatchObject({ ok: false, kind: "unexpected" });
  });
});
