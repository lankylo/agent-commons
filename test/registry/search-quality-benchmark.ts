/**
 * Deterministic, offline search-quality benchmark (Phase 3). Test-support only: a corpus of
 * schema-valid Knowledge and Execution contributions, realistic agent-style query cases with
 * stated expectations, and a pure scoring harness. It never calls production code, an LLM, R2
 * content retrieval or the network; `search-quality.test.ts` runs the cases against the real
 * internal D1 search and `search-quality-harness.test.ts` tests the scoring on its own.
 *
 * Contributions are addressed by stable benchmark keys, never by generated IDs.
 */
export const BENCHMARK_NOW = "2026-11-20T00:00:00.000Z";
/** Each corpus item is created one minute after the previous one, so created_at order is fixed. */
export const CORPUS_START = "2026-11-11T12:00:00.000Z";

// ---------- corpus ----------

interface KnowledgeSpec {
  key: string;
  title: string;
  summary: string;
  contentType: "api-reference" | "api-limits" | "error-reference" | "concept-summary";
  method: "cross-source" | "source-checked" | "owner-tested" | "unverified";
  permittedUse: "reference-only" | "summary" | "redistribute";
  asOf: string;
  reviewIntervalDays: number;
  facts: [subject: string, predicate: string, value: string | number][];
  sources?: number;
}
interface ExecutionSpec {
  key: string;
  title: string;
  purpose: string;
  objective: string;
  contentType: "api-recipe" | "diagnostic-recipe";
  domain: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  capabilities: string[];
  sideEffect: "read-only" | "reversible-write" | "irreversible-write";
  approval: boolean;
  method_: "owner-tested" | "simulated" | "unverified";
  asOf: string;
  reviewIntervalDays: number;
}

const DIGESTS = ["a", "b", "c"].map((c) => c.repeat(64));
const k = (s: KnowledgeSpec): Record<string, unknown> => ({
  family: "knowledge",
  title: s.title,
  purpose: `Record documented behaviour: ${s.title}`,
  contentType: s.contentType,
  evidence: [{ kind: "documentation", uri: `https://docs.example.com/${s.key}` }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: s.reviewIntervalDays,
  asOf: s.asOf,
  summary: s.summary,
  facts: s.facts.map(([subject, predicate, value]) => ({ subject, predicate, value })),
  sources: Array.from({ length: s.sources ?? 1 }, (_, i) => ({
    uri: `https://docs.example.com/${s.key}/source-${i + 1}`,
    accessedAt: s.asOf,
    hash: { algorithm: "sha256", digest: DIGESTS[i] },
  })),
  rights: { sourceLicense: "CC-BY-4.0", permittedUse: s.permittedUse },
  verification: { method: s.method },
});
const e = (s: ExecutionSpec): Record<string, unknown> => ({
  family: "execution",
  title: s.title,
  purpose: s.purpose,
  contentType: s.contentType,
  evidence: [{ kind: "documentation", uri: `https://docs.example.com/${s.key}` }],
  licensing: { license: "CC-BY-4.0", dataPermission: "redistribution-allowed" },
  reviewIntervalDays: s.reviewIntervalDays,
  asOf: s.asOf,
  objective: s.objective,
  inputs: [],
  outputs: [{ name: "status", type: "integer", variable: "status" }],
  targetDomains: [s.domain],
  compatibility: { requiredCapabilities: s.capabilities },
  steps: [
    {
      id: "call",
      type: "http_request",
      method: s.method,
      domain: s.domain,
      path: s.path,
      expectStatus: [200],
      saveAs: "body",
    },
    { id: "pick", type: "extract_field", from: "body", pointer: "/status", saveAs: "status" },
    {
      id: "check",
      type: "assert",
      source: { variable: "status" },
      operator: "exists",
    },
  ],
  successChecks: ["check"],
  safety: {
    sideEffect: s.sideEffect,
    requiresHumanApproval: s.approval,
    maxRequests: 1,
    timeoutSeconds: 30,
    onFailure: "stop",
  },
  verification:
    s.method_ === "unverified" ? { method: "unverified" } : { method: s.method_, testedAt: s.asOf },
});

const K_DEFAULTS = { permittedUse: "summary", asOf: "2026-11-05T10:00:00Z" } as const;
const E_DEFAULTS = {
  contentType: "api-recipe",
  method: "GET",
  capabilities: ["http-get", "json-parse"],
  sideEffect: "read-only",
  approval: false,
  method_: "owner-tested",
  asOf: "2026-11-05T10:00:00Z",
  reviewIntervalDays: 60,
} as const;

/** Knowledge distractors and neighbours of the httpbin seed pair (loaded separately). */
export const KNOWLEDGE_CORPUS: Record<string, unknown>[] = (
  [
    {
      ...K_DEFAULTS,
      key: "k-github-rate",
      title: "GitHub REST API rate limits",
      summary:
        "Unauthenticated GitHub REST API requests are limited to 60 per hour, and authenticated requests to 5000 per hour.",
      contentType: "api-limits",
      method: "cross-source",
      reviewIntervalDays: 30,
      sources: 2,
      facts: [["GitHub REST API", "authenticatedHourlyLimit", 5000]],
    },
    {
      ...K_DEFAULTS,
      key: "k-github-rate-old",
      title: "GitHub REST API rate limits (archived notes)",
      summary:
        "Older notes say unauthenticated GitHub REST API requests were limited to 60 per hour.",
      contentType: "api-limits",
      method: "unverified",
      asOf: "2026-08-01T10:00:00Z",
      reviewIntervalDays: 30,
      facts: [["GitHub REST API", "unauthenticatedHourlyLimit", 60]],
    },
    {
      ...K_DEFAULTS,
      key: "k-retry-after",
      title: "HTTP 429 Retry-After header",
      summary:
        "A 429 Too Many Requests response may carry a Retry-After header holding a delay in seconds or an HTTP date.",
      contentType: "error-reference",
      method: "source-checked",
      reviewIntervalDays: 90,
      facts: [["HTTP 429", "retryHeader", "Retry-After"]],
    },
    {
      ...K_DEFAULTS,
      key: "k-idempotency",
      title: "Idempotency-Key header for safe POST retries",
      summary:
        "Servers that support the Idempotency-Key header return the stored result when a POST is retried with the same key.",
      contentType: "api-reference",
      method: "cross-source",
      reviewIntervalDays: 60,
      sources: 2,
      facts: [["POST request", "idempotencyHeader", "Idempotency-Key"]],
    },
    {
      ...K_DEFAULTS,
      key: "k-json-pointer",
      title: "JSON Pointer syntax (RFC 6901)",
      summary:
        "A JSON Pointer is a slash-separated string such as /args/name that identifies one value in a JSON document.",
      contentType: "concept-summary",
      method: "source-checked",
      reviewIntervalDays: 180,
      facts: [["JSON Pointer", "separator", "/"]],
    },
    {
      ...K_DEFAULTS,
      key: "k-httpbin-post",
      title: "httpbin POST /post echo contract",
      summary:
        "POST https://httpbin.org/post echoes the request body in the json, form and data fields.",
      contentType: "api-reference",
      method: "unverified",
      reviewIntervalDays: 60,
      facts: [["POST https://httpbin.org/post", "echoes", "request body"]],
    },
    {
      ...K_DEFAULTS,
      key: "k-d1-limits",
      title: "Cloudflare D1 database size limits",
      summary:
        "A D1 database has a maximum storage size, and each query has a bounded number of bound parameters.",
      contentType: "api-limits",
      method: "owner-tested",
      reviewIntervalDays: 30,
      facts: [["Cloudflare D1", "limitKind", "storage and bound parameters"]],
    },
    {
      ...K_DEFAULTS,
      key: "k-oauth-token",
      title: "OAuth 2.0 client credentials token request",
      summary:
        "A client posts grant_type=client_credentials to the token endpoint and receives a bearer access token with an expiry.",
      contentType: "api-reference",
      method: "source-checked",
      reviewIntervalDays: 60,
      facts: [["token endpoint", "grantType", "client_credentials"]],
    },
    {
      ...K_DEFAULTS,
      key: "k-http-etag",
      title: "HTTP caching with ETag and If-None-Match",
      summary:
        "A client sends If-None-Match with a stored ETag, and the server answers 304 Not Modified when the representation is unchanged.",
      contentType: "concept-summary",
      method: "source-checked",
      permittedUse: "reference-only",
      reviewIntervalDays: 180,
      facts: [["If-None-Match", "successStatus", 304]],
    },
  ] as (KnowledgeSpec & { key: string })[]
).map(k);

export const EXECUTION_CORPUS: Record<string, unknown>[] = (
  [
    {
      ...E_DEFAULTS,
      key: "e-github-rate",
      title: "Check GitHub API rate limit status",
      purpose: "Confirm the remaining GitHub API quota before a batch of requests",
      objective:
        "Call GET /rate_limit on api.github.com and assert that the remaining quota is present.",
      domain: "api.github.com",
      path: "/rate_limit",
    },
    {
      ...E_DEFAULTS,
      key: "e-github-issue",
      title: "Create a GitHub issue",
      purpose: "Open an issue in a repository",
      objective: "POST a new issue to the repository and assert that the response status exists.",
      domain: "api.github.com",
      path: "/repos/example/issues",
      method: "POST",
      capabilities: ["http-post", "json-parse"],
      sideEffect: "reversible-write",
      approval: true,
    },
    {
      ...E_DEFAULTS,
      key: "e-github-delete",
      title: "Delete a GitHub repository",
      purpose: "Permanently remove a repository",
      objective: "Send DELETE for the repository and assert that the response status exists.",
      domain: "api.github.com",
      path: "/repos/example/old",
      method: "DELETE",
      capabilities: ["http-delete"],
      sideEffect: "irreversible-write",
      approval: true,
      method_: "simulated",
    },
    {
      ...E_DEFAULTS,
      key: "e-retry-after",
      title: "Retry a request after HTTP 429 Retry-After",
      purpose: "Back off and retry a throttled GET request",
      objective: "Call GET /v1/items; on 429 wait for the Retry-After delay and call it again.",
      domain: "api.acme.com",
      path: "/v1/items",
    },
    {
      ...E_DEFAULTS,
      key: "e-oauth-token",
      title: "Obtain an OAuth client credentials access token",
      purpose: "Fetch a bearer token for later calls",
      objective:
        "POST grant_type=client_credentials to the token endpoint and assert a token exists.",
      domain: "auth.acme.com",
      path: "/oauth/token",
      method: "POST",
      capabilities: ["http-post", "json-parse"],
      sideEffect: "reversible-write",
      method_: "simulated",
    },
    {
      ...E_DEFAULTS,
      key: "e-payment-idempotency",
      title: "Create a payment with an idempotency key",
      purpose: "Submit a charge that is safe to retry",
      objective: "POST a charge with an Idempotency-Key header and assert that the status exists.",
      domain: "pay.acme.com",
      path: "/v1/charges",
      method: "POST",
      capabilities: ["http-post", "json-parse"],
      sideEffect: "irreversible-write",
      approval: true,
    },
    {
      ...E_DEFAULTS,
      key: "e-http-etag",
      title: "Conditional GET with an ETag",
      purpose: "Avoid re-downloading an unchanged resource",
      objective: "Call GET /asset with If-None-Match and assert the status exists.",
      domain: "cdn.acme.com",
      path: "/asset",
      capabilities: ["http-get"],
      method_: "unverified",
    },
    {
      ...E_DEFAULTS,
      key: "e-mtls-status",
      title: "Call the status endpoint with a client certificate",
      purpose: "Check an internal service that requires mutual TLS",
      objective: "Call GET /status presenting a client certificate and assert the status exists.",
      domain: "status.acme.com",
      path: "/status",
      capabilities: ["http-get", "mtls"],
    },
    {
      ...E_DEFAULTS,
      key: "e-httpbin-post",
      title: "httpbin POST /post echo check",
      purpose: "Check that httpbin.org echoes a posted body",
      objective: "POST a small JSON body to /post and assert the echoed status exists.",
      domain: "httpbin.org",
      path: "/post",
      method: "POST",
      contentType: "diagnostic-recipe",
      capabilities: ["http-post", "json-parse"],
      sideEffect: "reversible-write",
      reviewIntervalDays: 30,
    },
    {
      ...E_DEFAULTS,
      key: "e-httpbin-headers-old",
      title: "httpbin GET /headers diagnostic (old)",
      purpose: "Check the request headers httpbin.org reports",
      objective: "Call GET /headers and assert that the headers object exists.",
      domain: "httpbin.org",
      path: "/headers",
      contentType: "diagnostic-recipe",
      method_: "unverified",
      asOf: "2026-08-01T10:00:00Z",
      reviewIntervalDays: 30,
    },
  ] as (ExecutionSpec & { key: string })[]
).map(e);

/** Keys in creation order. The httpbin seed pair is created first as `k-httpbin` / `e-httpbin`. */
export const CORPUS_KEYS = [
  "k-httpbin",
  "e-httpbin",
  ...[
    "k-github-rate",
    "k-github-rate-old",
    "k-retry-after",
    "k-idempotency",
    "k-json-pointer",
    "k-httpbin-post",
    "k-d1-limits",
    "k-oauth-token",
    "k-http-etag",
  ],
  ...[
    "e-github-rate",
    "e-github-issue",
    "e-github-delete",
    "e-retry-after",
    "e-oauth-token",
    "e-payment-idempotency",
    "e-http-etag",
    "e-mtls-status",
    "e-httpbin-post",
    "e-httpbin-headers-old",
  ],
] as const;
export type CorpusKey = (typeof CORPUS_KEYS)[number];

// ---------- query cases ----------

export type CaseCategory =
  | "knowledge-lookup"
  | "execution-lookup"
  | "keyword"
  | "natural"
  | "mixed-family"
  | "family-filter"
  | "metadata-filter"
  | "compatibility-filter"
  | "safety-filter"
  | "freshness"
  | "ranking"
  | "no-result";

export interface BenchmarkCase {
  readonly id: string;
  readonly categories: readonly CaseCategory[];
  /** The exact request sent to the search service, as an agent would write it. */
  readonly request: Readonly<Record<string, unknown>>;
  /** Relevant contributions and the lowest acceptable (1-based) rank of each. */
  readonly relevant: readonly { key: CorpusKey; maxRank: number }[];
  /** Tolerated extra results (related or lower-value but legitimately matching). */
  readonly acceptable?: readonly CorpusKey[];
  /** Pairs [better, worse]: when both are returned, `better` must rank first. */
  readonly orderedBefore?: readonly (readonly [CorpusKey, CorpusKey])[];
  /** True when nothing in the corpus is relevant: zero results are the correct answer. */
  readonly expectNone?: true;
}

const rel = (key: CorpusKey, maxRank: number) => ({ key, maxRank });

export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    id: "K1 knowledge keyword: httpbin get contract",
    categories: ["knowledge-lookup", "keyword"],
    request: { query: "httpbin get contract", family: "knowledge" },
    relevant: [rel("k-httpbin", 1)],
  },
  {
    id: "K2 knowledge natural: httpbin get response",
    categories: ["knowledge-lookup", "natural"],
    request: { query: "what status code and fields does httpbin get return" },
    relevant: [rel("k-httpbin", 1)],
    acceptable: ["e-httpbin"],
  },
  {
    id: "K3 knowledge keyword: github rate limits",
    categories: ["knowledge-lookup", "keyword"],
    request: { query: "github rate limits", family: "knowledge" },
    relevant: [rel("k-github-rate", 1)],
    acceptable: ["k-github-rate-old"],
  },
  {
    id: "K4 knowledge natural: unauthenticated github quota",
    categories: ["knowledge-lookup", "natural"],
    request: { query: "how many unauthenticated requests per hour does the github api allow" },
    relevant: [rel("k-github-rate", 1)],
    acceptable: ["k-github-rate-old", "e-github-rate"],
  },
  {
    id: "E1 execution keyword: github issue",
    categories: ["execution-lookup", "keyword"],
    request: { query: "github issue", family: "execution" },
    relevant: [rel("e-github-issue", 1)],
  },
  {
    id: "E2 execution natural: check github rate limit",
    categories: ["execution-lookup", "natural"],
    request: { query: "I need a recipe to check my github api rate limit", family: "execution" },
    relevant: [rel("e-github-rate", 1)],
  },
  {
    id: "E3 execution keyword: oauth access token",
    categories: ["execution-lookup", "keyword"],
    request: { query: "oauth access token", family: "execution" },
    relevant: [rel("e-oauth-token", 1)],
  },
  {
    id: "M1 mixed keyword: idempotency key",
    categories: ["mixed-family", "keyword"],
    request: { query: "idempotency key" },
    relevant: [rel("k-idempotency", 3), rel("e-payment-idempotency", 3)],
  },
  {
    id: "M2 mixed keyword: retry after 429",
    categories: ["mixed-family", "keyword"],
    request: { query: "retry after 429" },
    relevant: [rel("k-retry-after", 3), rel("e-retry-after", 3)],
  },
  {
    id: "M3 mixed keyword: etag",
    categories: ["mixed-family", "keyword"],
    request: { query: "etag" },
    relevant: [rel("k-http-etag", 3), rel("e-http-etag", 3)],
  },
  {
    id: "F1 family filter: httpbin executions only",
    categories: ["family-filter", "execution-lookup"],
    request: { query: "httpbin", family: "execution" },
    relevant: [rel("e-httpbin", 2), rel("e-httpbin-post", 2)],
    acceptable: ["e-httpbin-headers-old"],
  },
  {
    id: "F2 metadata filter: cross-source knowledge",
    categories: ["metadata-filter", "knowledge-lookup"],
    request: {
      query: "github rate limits",
      family: "knowledge",
      filters: { verificationMethod: "cross-source" },
    },
    relevant: [rel("k-github-rate", 1)],
  },
  {
    id: "F3 metadata filter: redistributable httpbin knowledge",
    categories: ["metadata-filter", "knowledge-lookup"],
    request: {
      query: "httpbin",
      family: "knowledge",
      filters: { permittedUse: "redistribute" },
    },
    relevant: [rel("k-httpbin", 1)],
  },
  {
    id: "F4 content-type filter: httpbin diagnostics",
    categories: ["metadata-filter", "execution-lookup"],
    request: { query: "httpbin", contentType: "diagnostic-recipe" },
    relevant: [rel("e-httpbin", 2), rel("e-httpbin-post", 2)],
    acceptable: ["e-httpbin-headers-old"],
  },
  {
    id: "S1 safety filter: read-only github recipes",
    categories: ["safety-filter", "execution-lookup"],
    request: { query: "github", family: "execution", filters: { sideEffect: "read-only" } },
    relevant: [rel("e-github-rate", 1)],
  },
  {
    id: "S2 safety filter: irreversible payment recipes",
    categories: ["safety-filter", "execution-lookup"],
    request: {
      query: "payment",
      family: "execution",
      filters: { sideEffect: "irreversible-write" },
    },
    relevant: [rel("e-payment-idempotency", 1)],
  },
  {
    id: "S3 safety filter: github recipes needing no human approval",
    categories: ["safety-filter", "execution-lookup"],
    request: { query: "github", family: "execution", filters: { requiresHumanApproval: false } },
    relevant: [rel("e-github-rate", 1)],
  },
  {
    id: "C1 compatibility filter: mTLS-capable status check",
    categories: ["compatibility-filter", "execution-lookup"],
    request: { query: "status", family: "execution", filters: { requiredCapability: "mtls" } },
    relevant: [rel("e-mtls-status", 1)],
  },
  {
    id: "C2 compatibility filter: target domain httpbin.org, post",
    categories: ["compatibility-filter", "execution-lookup"],
    request: {
      query: "post echo",
      family: "execution",
      filters: { targetDomain: "httpbin.org" },
    },
    relevant: [rel("e-httpbin-post", 1)],
  },
  {
    id: "R1 freshness: stale github limits ranked below current",
    categories: ["freshness", "mixed-family"],
    request: { query: "github rate" },
    relevant: [rel("k-github-rate", 3), rel("e-github-rate", 3)],
    acceptable: ["k-github-rate-old"],
    orderedBefore: [["k-github-rate", "k-github-rate-old"]],
  },
  {
    id: "R2 freshness: stale httpbin diagnostic ranked below current",
    categories: ["freshness", "ranking"],
    request: { query: "httpbin diagnostic", family: "execution" },
    relevant: [rel("e-httpbin", 2), rel("e-httpbin-post", 2)],
    acceptable: ["e-httpbin-headers-old"],
    orderedBefore: [["e-httpbin", "e-httpbin-headers-old"]],
  },
  {
    id: "R3 ranking: broad httpbin query orders by freshness then evidence",
    categories: ["ranking", "mixed-family", "keyword"],
    request: { query: "httpbin" },
    relevant: [
      rel("k-httpbin", 5),
      rel("e-httpbin", 5),
      rel("k-httpbin-post", 5),
      rel("e-httpbin-post", 5),
      rel("e-httpbin-headers-old", 5),
    ],
    orderedBefore: [
      ["e-httpbin", "e-httpbin-headers-old"],
      ["k-httpbin", "k-httpbin-post"],
    ],
  },
  {
    id: "N1 no result: unrelated infrastructure topic",
    categories: ["no-result", "natural"],
    request: { query: "kubernetes pod autoscaling" },
    relevant: [],
    expectNone: true,
  },
  {
    id: "N2 no result: github knowledge nobody permits to redistribute",
    categories: ["no-result", "metadata-filter"],
    request: { query: "github", family: "knowledge", filters: { permittedUse: "redistribute" } },
    relevant: [],
    expectNone: true,
  },
  {
    id: "N3 no result: unrelated execution topic",
    categories: ["no-result", "execution-lookup"],
    request: { query: "quantum", family: "execution" },
    relevant: [],
    expectNone: true,
  },
];

// ---------- scoring ----------

export interface CaseOutcome {
  readonly id: string;
  readonly returned: readonly string[];
  /** Relevant keys not returned at all. */
  readonly missed: readonly string[];
  /** Relevant keys returned but ranked below their stated `maxRank`. */
  readonly misplaced: readonly string[];
  /** Returned keys that are neither relevant nor acceptable. */
  readonly unexpected: readonly string[];
  /** [better, worse] pairs returned in the wrong order. */
  readonly orderViolations: readonly (readonly [string, string])[];
  readonly zeroResults: boolean;
  /** Rank 1 is a relevant contribution (positive cases only; false for expectNone). */
  readonly top1: boolean;
  /** At least min(relevant, 3) relevant contributions are in the first three (positive cases). */
  readonly top3: boolean;
  /** Every stated expectation holds: nothing missed/misplaced/unexpected/misordered. */
  readonly passed: boolean;
}

export function evaluateCase(c: BenchmarkCase, returned: readonly string[]): CaseOutcome {
  const rank = new Map(returned.map((key, i) => [key, i + 1]));
  const relevantKeys = new Set<string>(c.relevant.map((r) => r.key));
  const allowed = new Set<string>([...relevantKeys, ...(c.acceptable ?? [])]);
  const missed = c.relevant.filter((r) => !rank.has(r.key)).map((r) => r.key);
  const misplaced = c.relevant
    .filter((r) => rank.has(r.key) && rank.get(r.key)! > r.maxRank)
    .map((r) => r.key);
  const unexpected = returned.filter((key) => !allowed.has(key));
  const orderViolations = (c.orderedBefore ?? []).filter(
    ([better, worse]) =>
      rank.has(better) && rank.has(worse) && rank.get(better)! > rank.get(worse)!,
  );
  const positive = !c.expectNone && c.relevant.length > 0;
  const inTop3 = returned.slice(0, 3).filter((key) => relevantKeys.has(key)).length;
  return {
    id: c.id,
    returned,
    missed,
    misplaced,
    unexpected,
    orderViolations,
    zeroResults: returned.length === 0,
    top1: positive && returned.length > 0 && relevantKeys.has(returned[0]),
    top3: positive && inTop3 >= Math.min(c.relevant.length, 3),
    passed:
      missed.length === 0 &&
      misplaced.length === 0 &&
      unexpected.length === 0 &&
      orderViolations.length === 0,
  };
}

export interface BenchmarkSummary {
  readonly cases: number;
  readonly positiveCases: number;
  readonly noResultCases: number;
  readonly top1Successes: number;
  readonly top3Successes: number;
  readonly relevantExpected: number;
  readonly missedRelevant: number;
  readonly misplacedRelevant: number;
  readonly returnedTotal: number;
  readonly unexpectedResults: number;
  readonly orderViolations: number;
  /** Positive cases that returned nothing. */
  readonly zeroResultPositiveCases: number;
  /** No-result cases that returned something. */
  readonly nonEmptyNoResultCases: number;
  readonly casesPassed: number;
}

export function summarize(
  cases: readonly BenchmarkCase[],
  outcomes: readonly CaseOutcome[],
): BenchmarkSummary {
  const sum = (f: (c: BenchmarkCase, o: CaseOutcome) => number) =>
    cases.reduce((n, c, i) => n + f(c, outcomes[i]), 0);
  const positive = (c: BenchmarkCase) => !c.expectNone && c.relevant.length > 0;
  return {
    cases: cases.length,
    positiveCases: sum((c) => (positive(c) ? 1 : 0)),
    noResultCases: sum((c) => (c.expectNone ? 1 : 0)),
    top1Successes: sum((_, o) => (o.top1 ? 1 : 0)),
    top3Successes: sum((_, o) => (o.top3 ? 1 : 0)),
    relevantExpected: sum((c) => c.relevant.length),
    missedRelevant: sum((_, o) => o.missed.length),
    misplacedRelevant: sum((_, o) => o.misplaced.length),
    returnedTotal: sum((_, o) => o.returned.length),
    unexpectedResults: sum((_, o) => o.unexpected.length),
    orderViolations: sum((_, o) => o.orderViolations.length),
    zeroResultPositiveCases: sum((c, o) => (positive(c) && o.zeroResults ? 1 : 0)),
    nonEmptyNoResultCases: sum((c, o) => (c.expectNone && !o.zeroResults ? 1 : 0)),
    casesPassed: sum((_, o) => (o.passed ? 1 : 0)),
  };
}

/** Acceptance criteria for the existing keyword search; see docs/search-quality.md. */
export const ACCEPTANCE_CRITERIA = {
  minTop1Rate: 0.8,
  minTop3Rate: 0.9,
  maxMissedRelevant: 0,
  maxMisplacedRelevant: 0,
  maxZeroResultPositiveCases: 0,
  maxNonEmptyNoResultCases: 0,
  maxUnexpectedResults: 0,
  maxOrderViolations: 0,
} as const;

export interface AcceptanceVerdict {
  readonly met: boolean;
  readonly failures: readonly string[];
}

export function checkAcceptance(
  s: BenchmarkSummary,
  a: typeof ACCEPTANCE_CRITERIA = ACCEPTANCE_CRITERIA,
): AcceptanceVerdict {
  const failures: string[] = [];
  const rate = (n: number, d: number) => (d === 0 ? 1 : n / d);
  if (rate(s.top1Successes, s.positiveCases) < a.minTop1Rate) failures.push("top-1 rate");
  if (rate(s.top3Successes, s.positiveCases) < a.minTop3Rate) failures.push("top-3 rate");
  if (s.missedRelevant > a.maxMissedRelevant) failures.push("missed relevant results");
  if (s.misplacedRelevant > a.maxMisplacedRelevant) failures.push("misplaced relevant results");
  if (s.zeroResultPositiveCases > a.maxZeroResultPositiveCases) {
    failures.push("zero-result positive queries");
  }
  if (s.nonEmptyNoResultCases > a.maxNonEmptyNoResultCases) {
    failures.push("results for no-result queries");
  }
  if (s.unexpectedResults > a.maxUnexpectedResults) failures.push("unexpected results");
  if (s.orderViolations > a.maxOrderViolations) failures.push("ordering violations");
  return { met: failures.length === 0, failures };
}

/** Runs every case through `searchKeys` (which returns benchmark keys in ranked order). */
export async function runBenchmark(
  searchKeys: (request: Readonly<Record<string, unknown>>) => Promise<readonly string[]>,
  cases: readonly BenchmarkCase[] = BENCHMARK_CASES,
): Promise<{ outcomes: CaseOutcome[]; summary: BenchmarkSummary; verdict: AcceptanceVerdict }> {
  const outcomes: CaseOutcome[] = [];
  for (const c of cases) outcomes.push(evaluateCase(c, await searchKeys(c.request)));
  const summary = summarize(cases, outcomes);
  return { outcomes, summary, verdict: checkAcceptance(summary) };
}
