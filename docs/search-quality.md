# Search-Quality Report (Phase 3)

Offline benchmark of the existing internal D1 FTS5 search (`src/registry/search.ts`) with realistic
agent-style queries over both contribution families. Deterministic, LLM-free, no network, and
independent of R2 content (the search service is constructed with D1 only). No production search or
ranking code was changed.

Files: `test/registry/search-quality-benchmark.ts` (corpus, cases, scoring harness),
`search-quality.test.ts` (runs the cases on local Miniflare D1 with the real migrations and pins the
observed behaviour), `search-quality-harness.test.ts` (scoring unit tests, no D1).
Reference time: `2026-11-20T00:00:00Z`.

## Verdict

**The acceptance criteria are NOT met.** Concise keyword queries, filters, freshness and ranking
behave correctly; natural agent-style requests fail outright (zero results). The Phase 3 checklist
item "Test search quality…" therefore stays **open**.

## Corpus (21 contributions, all schema-valid, created through `ContributionRegistry`)

Knowledge (10): `k-httpbin` (seed, source-checked), `k-github-rate` (cross-source, current),
`k-github-rate-old` (unverified, **stale**), `k-retry-after`, `k-idempotency` (cross-source),
`k-json-pointer`, `k-httpbin-post` (distractor), `k-d1-limits`, `k-oauth-token`, `k-http-etag`
(reference-only).
Execution (11, incl. seed): `e-httpbin` (seed, owner-tested, read-only), `e-github-rate` (read-only),
`e-github-issue` (reversible-write, approval), `e-github-delete` (irreversible-write, approval,
simulated), `e-retry-after`, `e-oauth-token` (simulated), `e-payment-idempotency` (irreversible-write,
approval), `e-http-etag` (unverified), `e-mtls-status` (capability `mtls`), `e-httpbin-post`
(distractor), `e-httpbin-headers-old` (unverified, **stale**).
Overlapping topics (GitHub rate limits, httpbin, idempotency, 429/Retry-After, ETag) exist in both
families; httpbin and GitHub entries are distractors for each other.

## Metrics and acceptance criteria

Positive cases have at least one relevant contribution; no-result cases expect zero results.
- **top-1 success**: rank 1 is relevant. **top-3 success**: at least min(#relevant, 3) relevant items are in ranks 1–3.
- **missed**: relevant item not returned. **misplaced**: returned below its stated `maxRank`.
- **unexpected**: returned item neither relevant nor listed as acceptable. **zero-result**: positive case returning nothing (or a no-result case returning something).

| Criterion | Threshold |
|---|---|
| top-1 rate (positive cases) | ≥ 80% |
| top-3 rate (positive cases) | ≥ 90% |
| missed relevant, misplaced relevant | 0 |
| zero-result positive cases; non-empty no-result cases | 0 |
| unexpected results; ordering violations | 0 |

## Query cases (25) and observed ranking

Expected = relevant item(s) with max rank; observed = returned order. All requests are sent verbatim.

| Case | Query / filters | Expected | Observed | Result |
|---|---|---|---|---|
| K1 | `httpbin get contract` (knowledge) | k-httpbin ≤1 | k-httpbin | pass |
| K2 | `what status code and fields does httpbin get return` | k-httpbin ≤1 | none | **fail** |
| K3 | `github rate limits` (knowledge) | k-github-rate ≤1 | k-github-rate, k-github-rate-old | pass |
| K4 | `how many unauthenticated requests per hour does the github api allow` | k-github-rate ≤1 | none | **fail** |
| E1 | `github issue` (execution) | e-github-issue ≤1 | e-github-issue | pass |
| E2 | `I need a recipe to check my github api rate limit` (execution) | e-github-rate ≤1 | none | **fail** |
| E3 | `oauth access token` (execution) | e-oauth-token ≤1 | e-oauth-token | pass |
| M1 | `idempotency key` | k-idempotency, e-payment-idempotency ≤3 | both, ranks 1–2 | pass |
| M2 | `retry after 429` | k-retry-after, e-retry-after ≤3 | e-retry-after, k-retry-after | pass |
| M3 | `etag` | k-http-etag, e-http-etag ≤3 | k-http-etag, e-http-etag | pass |
| F1 | `httpbin` (execution) | e-httpbin, e-httpbin-post ≤2 | e-httpbin-post, e-httpbin, e-httpbin-headers-old | pass |
| F2 | `github rate limits` + verificationMethod=cross-source | k-github-rate ≤1 | k-github-rate only | pass |
| F3 | `httpbin` + permittedUse=redistribute (knowledge) | k-httpbin ≤1 | k-httpbin only | pass |
| F4 | `httpbin`, contentType=diagnostic-recipe | e-httpbin, e-httpbin-post ≤2 | e-httpbin-post, e-httpbin, e-httpbin-headers-old | pass |
| S1 | `github` + sideEffect=read-only | e-github-rate ≤1 | e-github-rate only | pass |
| S2 | `payment` + sideEffect=irreversible-write | e-payment-idempotency ≤1 | that only | pass |
| S3 | `github` + requiresHumanApproval=false | e-github-rate ≤1 | e-github-rate only | pass |
| C1 | `status` + requiredCapability=mtls | e-mtls-status ≤1 | that only | pass |
| C2 | `post echo` + targetDomain=httpbin.org | e-httpbin-post ≤1 | that only | pass |
| R1 | `github rate` (stale must trail current) | k-github-rate, e-github-rate ≤3 | k-github-rate, e-github-rate, k-github-rate-old | pass |
| R2 | `httpbin diagnostic` (execution) | e-httpbin, e-httpbin-post ≤2; current before stale | e-httpbin-post, e-httpbin, e-httpbin-headers-old | pass |
| R3 | `httpbin` (all five httpbin items ≤5; current before stale) | see corpus | e-httpbin-post, e-httpbin, k-httpbin, k-httpbin-post, e-httpbin-headers-old | pass |
| N1 | `kubernetes pod autoscaling` | none | none | pass |
| N2 | `github` + knowledge + permittedUse=redistribute | none | none | pass |
| N3 | `quantum` (execution) | none | none | pass |

Authoring note: the first R2/R3 drafts listed only `e-httpbin`/`k-httpbin` as relevant and marked
`e-httpbin-post` unexpected. `httpbin diagnostic` legitimately matches `e-httpbin-post` (its content
type is `diagnostic-recipe`) and `httpbin` matches all five httpbin items, so those expectations were
corrected as a relevance-judgement error. No expectation was changed to accommodate the three
failures, and no query was reworded.

## Measured results

| Measure | Result |
|---|---|
| Cases (positive / no-result) | 25 (22 / 3) |
| Top-1 success | 19 / 22 = 86.4% (criterion ≥ 80%: **met**) |
| Top-3 success | 19 / 22 = 86.4% (criterion ≥ 90%: **not met**) |
| Missed relevant results | 3 of 33 expected (K2, K4, E2) — **not met** |
| Misplaced relevant results | 0 |
| Unexpected results | 0 of 35 returned |
| Ordering violations (freshness, evidence tier) | 0 |
| Zero-result queries | 3 positive cases (**not met**); 0 non-empty no-result cases |
| Cases fully passed | 22 / 25 |

Failed criteria: top-3 rate, missed relevant results, zero-result positive queries.

## Findings

All three failures are natural, agent-style requests. Search tokenizes the query, requires **every**
token (implicit AND), and uses FTS5 `unicode61` with no stemming and no stop-word handling. Observed
(pinned in `search-quality.test.ts`):
- one stop word is enough to return nothing: `github rate limits` finds the Knowledge item, `the github rate limits` finds nothing;
- no stemming: `github rate limit` finds only the Execution recipe (title says "limit"), `github rate limits` only the Knowledge items ("limits"), so one real quota question can miss the relevant family.

Concise keyword, family, metadata, compatibility, safety, freshness and tie-break behaviour is correct
and deterministic: filters never leaked other families or unsafe recipes, stale items trailed current
ones, and repeated runs were identical.

## Limitations

- Small corpus (21 items) written by the benchmark author; queries are hand-written to resemble agent output, not sampled from real agents.
- Relevance judgements are the author's; the ranking order among equally relevant items (e.g. `e-httpbin-post` before `e-httpbin`) is accepted rather than judged.
- Ranks reflect only the Phase 3 baseline signals; Phase 5 signals (outcomes, feedback, reliability) do not exist yet, and no `reliabilityScore` is populated.
- Measures lexical retrieval only; no latency, scale or large-corpus behaviour.

## Recommendation

D1 FTS5 is **sufficient for concise keyword, filtered, freshness-aware and mixed-family lookup**, but
**not sufficient as-is for natural agent requests**. Because every miss is lexical (stop words,
inflection, strict AND) and not semantic, propose a separately approved, bounded improvement before
considering Vectorize: deterministic, LLM-free query normalization in the search layer (fixed
stop-word list, deterministic suffix folding applied to both index text and query, and a fallback
that relaxes AND to a bounded match when the strict query returns nothing), re-run against this
benchmark unchanged. Evaluate Vectorize (per `project.md`) only if that bounded change still fails
these criteria. That work needs its own approval; it may require an index migration and is not part
of this task.
