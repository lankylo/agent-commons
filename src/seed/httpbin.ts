/**
 * Owner-approved httpbin seed fixtures (Phase 2, preparation only). Typed,
 * deterministic data: nothing here is loaded into D1 or R2, and there is no
 * registry loader. The Execution fixture cannot name the Knowledge contribution
 * until a loader assigns its ID and version; `executionWithKnowledgeRef` adds
 * that reference then.
 */
import type { ContributionRef } from "../registry/envelope";
import type { ExecutionContributionInput } from "../registry/execution";
import type { KnowledgeContributionInput } from "../registry/knowledge";

/** Checked-in snapshot of the relevant contract (httpbin `view_get`, core.py lines 371-384). */
export const HTTPBIN_SNAPSHOT_PATH = "seed/httpbin/get-contract.snapshot.txt";
export const HTTPBIN_SNAPSHOT_SHA256 =
  "fc86e9856bbaa1f0580c2cb3c979c8c19a41fb97f74fff9d28965a4fd02beb4f";
const SOURCE_COMMIT = "010785cebdd430288b76ba3bb52cc67f6eeb3bda";
export const HTTPBIN_SOURCE_URI = `https://github.com/postmanlabs/httpbin/blob/${SOURCE_COMMIT}/httpbin/core.py#L371-L384`;
export const HTTPBIN_DOCS_URI = "https://httpbin.org/";

/** Seed provenance: one opt-in live run of `npm run seed:verify:httpbin`. */
export const HTTPBIN_SEED_PROVENANCE = {
  seededBy: "owner-approved seed preparation",
  liveVerification: {
    command: "npm run seed:verify:httpbin",
    url: "https://httpbin.org/get?agent_commons=seed-v1",
    verifiedAt: "2026-11-11T11:54:25Z",
    result: "passed",
    detail: "HTTP 200, JSON body with url/args/headers/origin, args.agent_commons=seed-v1",
  },
  note: "Owner-tested only; not independently verified.",
} as const;

export const HTTPBIN_KNOWLEDGE_SEED: KnowledgeContributionInput = {
  family: "knowledge",
  title: "httpbin GET /get response contract",
  purpose: "Document the successful JSON response of GET https://httpbin.org/get",
  contentType: "api-reference",
  evidence: [
    { kind: "official-documentation", uri: HTTPBIN_DOCS_URI },
    { kind: "source-code", uri: HTTPBIN_SOURCE_URI },
  ],
  licensing: { license: "ISC", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 90,
  facts: [
    { subject: "GET https://httpbin.org/get", predicate: "successStatus", value: 200 },
    {
      subject: "GET https://httpbin.org/get",
      predicate: "responseContentType",
      value: "application/json",
    },
    {
      subject: "GET https://httpbin.org/get",
      predicate: "responseFields",
      value: "url,args,headers,origin",
    },
    {
      subject: "GET https://httpbin.org/get",
      predicate: "argsContent",
      value: "the request query parameters",
    },
  ],
  summary:
    "A successful GET https://httpbin.org/get returns HTTP 200 with a JSON object containing url, args (the query parameters), headers and origin.",
  sources: [
    {
      uri: HTTPBIN_SOURCE_URI,
      accessedAt: "2026-11-11T11:00:00Z",
      hash: { algorithm: "sha256", digest: HTTPBIN_SNAPSHOT_SHA256 },
      snapshotRef: HTTPBIN_SNAPSHOT_PATH,
    },
  ],
  rights: {
    sourceLicense: "ISC",
    rightsHolder: "Kenneth Reitz",
    permittedUse: "redistribute",
  },
  verification: { method: "source-checked" },
  asOf: "2026-11-11T11:54:25Z",
};

export const HTTPBIN_EXECUTION_SEED: ExecutionContributionInput = {
  family: "execution",
  title: "httpbin GET /get diagnostic",
  purpose: "Check that httpbin.org echoes a query parameter in args",
  contentType: "diagnostic-recipe",
  evidence: [
    { kind: "official-documentation", uri: HTTPBIN_DOCS_URI },
    { kind: "source-code", uri: HTTPBIN_SOURCE_URI },
  ],
  licensing: { license: "ISC", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: 30,
  objective:
    "Call GET /get with agent_commons=seed-v1, extract args.agent_commons and assert it equals seed-v1.",
  inputs: [],
  outputs: [{ name: "echoedValue", type: "string", variable: "echoed" }],
  targetDomains: ["httpbin.org"],
  compatibility: { requiredCapabilities: ["http-get", "json-parse"] },
  steps: [
    {
      id: "fetch",
      type: "http_request",
      method: "GET",
      domain: "httpbin.org",
      path: "/get",
      query: { agent_commons: { literal: "seed-v1" } },
      expectStatus: [200],
      saveAs: "response",
    },
    {
      id: "extract",
      type: "extract_field",
      from: "response",
      pointer: "/args/agent_commons",
      saveAs: "echoed",
    },
    {
      id: "check_echo",
      type: "assert",
      source: { variable: "echoed" },
      operator: "equals",
      expected: "seed-v1",
    },
  ],
  successChecks: ["check_echo"],
  safety: {
    sideEffect: "read-only",
    requiresHumanApproval: false,
    maxRequests: 1,
    timeoutSeconds: 30,
    onFailure: "report-and-stop",
  },
  // Owner-tested because the opt-in live run in HTTPBIN_SEED_PROVENANCE passed.
  verification: {
    method: "owner-tested",
    testedAt: HTTPBIN_SEED_PROVENANCE.liveVerification.verifiedAt,
  },
  asOf: HTTPBIN_SEED_PROVENANCE.liveVerification.verifiedAt,
};

/** Add the Knowledge reference once a loader has assigned its ID and version. */
export function executionWithKnowledgeRef(knowledge: ContributionRef): ExecutionContributionInput {
  return { ...HTTPBIN_EXECUTION_SEED, related: [knowledge] };
}
